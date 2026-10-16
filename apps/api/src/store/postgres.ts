import { randomUUID } from "node:crypto";
import { sha256 } from "@clause/core";
import pg from "pg";
import { dueIn, newId, REQUEST_COLUMNS, requestPatchColumns, toPlaybook, toRequest, toRule, type PlaybookRow, type RequestRow, type RuleRow } from "./shared.ts";
import { ContentTooLargeError, InvalidQueryError, queryTerms, type Requirement, type RequirementKind, type DocumentRecord, type DocumentSummary, type ExactCandidate, type WordSnapshot, type RevisionInfo, type Store, type IntegrationProvider } from "./types.ts";

/**
 * A tsvector may not exceed ~1 MB, and the generated column indexes the whole text, so a hosted document is capped.
 * Production would index per-paragraph chunks instead (see INFRA.md); until then we refuse rather than index
 * silently-partial text.
 */
export const POSTGRES_MAX_CONTENT_CHARS = 500_000;

export interface PostgresOptions {
  connectionString: string;
  /** Pool size. Keep it small for serverless: every warm instance holds its own pool. */
  max?: number;
  /** Tests give each test its own schema so they can run in parallel against one database. */
  schema?: string;
  /** Overrides the character cap (tests only, to exercise the database's own limit). */
  maxContentChars?: number;
  /** Drop `schema` on close (tests only). */
  dropSchemaOnClose?: boolean;
  /** Called with the pool right after creation (e.g. Vercel's attachDatabasePool). */
  onPool?: (pool: pg.Pool) => void;
}

const MIGRATIONS: string[] = [
  `
  CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;

  CREATE TABLE documents (
    seq          BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    content      TEXT NOT NULL,
    version      INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    -- Maintained by Postgres itself, inside the writing transaction: a reader can never see text and index disagree.
    search       TSVECTOR GENERATED ALWAYS AS (
      setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', content), 'D')
    ) STORED
  );
  CREATE INDEX documents_search_idx ON documents USING gin (search);
  CREATE INDEX documents_content_trgm_idx ON documents USING gin (content public.gin_trgm_ops);
  CREATE INDEX documents_created_idx ON documents (created_at DESC, seq DESC);

  CREATE TABLE revisions (
    document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    summary      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (document_id, version)
  );
  `,
  `
  CREATE TABLE requirements (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('present', 'absent', 'unchanged', 'semantic')),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX requirements_document_idx ON requirements (document_id, seq);
  `,
  `
  CREATE TABLE requests (
    id          TEXT PRIMARY KEY,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    goal        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('inbox', 'in_progress', 'needs_review', 'completed')),
    priority    TEXT NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
    type        TEXT NOT NULL CHECK (type IN ('NDA', 'Commercial', 'Employment', 'Data & Privacy', 'Other')),
    due_date    TEXT,
    ci          TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX requests_status_idx ON requests (status, updated_at DESC);

  CREATE TABLE playbooks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE TABLE playbook_rules (
    id          TEXT PRIMARY KEY,
    playbook_id TEXT NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('present', 'absent', 'unchanged', 'semantic')),
    text        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    seq         BIGINT GENERATED ALWAYS AS IDENTITY
  );
  CREATE INDEX playbook_rules_idx ON playbook_rules (playbook_id, seq);
  `,
  `
  CREATE TABLE integration_connections (
    provider TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at TEXT,
    account_name TEXT,
    connected_at TEXT NOT NULL
  );
  CREATE TABLE integration_imports (
    provider TEXT NOT NULL,
    file_id TEXT NOT NULL,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (provider, file_id)
  );
  CREATE INDEX integration_imports_document_idx ON integration_imports (document_id);
  `,
  `ALTER TABLE documents ADD COLUMN template_provenance TEXT;`,
];

interface Row {
  id: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
  template_provenance?: string | null;
}

const toRecord = (r: Row): DocumentRecord => ({
  id: r.id,
  title: r.title,
  content: r.content,
  version: r.version,
  contentHash: r.content_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.template_provenance ? { templateProvenance: typeof r.template_provenance === "string" ? JSON.parse(r.template_provenance) : r.template_provenance } : {}),
});

const DOC_COLUMNS = "id, title, content, version, content_hash, created_at, updated_at, template_provenance";

/**
 * Plain text -> tsquery text. Every word is emitted as a quoted literal and a "quoted phrase" becomes a `<->`
 * chain, so operators in user input (`&`, `|`, `!`, `:*`, parentheses) are inert; only letters and digits survive.
 * Terms are ANDed. `to_tsquery('english', ...)` then stems each word, as the index did.
 */
export function toTsQuery(q: string): string {
  const parts = queryTerms(q)
    .map((term) => {
      const words = term.match(/[\p{L}\p{N}]+/gu) ?? [];
      const lits = words.map((w) => `'${w}'`);
      return lits.length === 0 ? undefined : lits.length === 1 ? lits[0]! : `(${lits.join(" <-> ")})`;
    })
    .filter((p): p is string => p !== undefined);
  if (parts.length === 0) throw new InvalidQueryError("Query has no searchable words");
  return parts.join(" & ");
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** Applies pending migrations under an advisory lock, so two cold starts can't race each other. */
async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(727274)");
    await client.query("CREATE TABLE IF NOT EXISTS clause_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    const cur = Number((await client.query("SELECT v FROM clause_meta WHERE k = 'schema_version'")).rows[0]?.v ?? 0);
    for (let v = cur; v < MIGRATIONS.length; v++) await client.query(MIGRATIONS[v]!);
    await client.query("INSERT INTO clause_meta (k, v) VALUES ('schema_version', $1) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v", [MIGRATIONS.length]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function fetchRequest(pool: pg.Pool, id: string) {
  const r = (await pool.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = $1`, [id])).rows[0];
  return r && toRequest(r);
}

export async function createPostgresStore(opts: PostgresOptions): Promise<Store> {
  const schema = opts.schema;
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name: ${schema}`);

  if (schema) {
    const boot = new pg.Pool({ connectionString: opts.connectionString, max: 1 });
    await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await boot.end();
  }
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 5,
    ...(schema && { options: `-c search_path=${schema},public` }),
  });
  opts.onPool?.(pool);
  await migrate(pool);

  async function insertWith(c: pg.PoolClient, input: { title: string; content: string; templateProvenance?: import("./types.ts").TemplateProvenance }): Promise<DocumentRecord> {
    const now = new Date().toISOString();
    const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const hash = sha256(input.content);
    await c.query("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, template_provenance) VALUES ($1, $2, $3, 1, $4, $5, $5, $6)", [id, input.title, input.content, hash, now, input.templateProvenance ? JSON.stringify(input.templateProvenance) : null]);
    await c.query("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES ($1, 1, $2, $3, $4, $5)", [id, input.content, hash, JSON.stringify([{ created: true }]), now]);
    return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now, ...(input.templateProvenance ? { templateProvenance: input.templateProvenance } : {}) };
  }

  /** Runs `fn` on one connection inside a transaction. */
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, begin = "BEGIN"): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(begin);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      // 54000 = program_limit_exceeded: "string is too long for tsvector". Report it as what it is, not as a crash.
      if ((e as { code?: string }).code === "54000") throw new ContentTooLargeError("text exceeds the full-text index limit");
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    kind: "postgres",
    maxContentChars: opts.maxContentChars ?? POSTGRES_MAX_CONTENT_CHARS,

    async insertDocument(input) {
      return tx((c) => insertWith(c, input));
    },

    async insertImportedDocument(input) {
      return tx(async (c) => {
        const lock = `${input.provider}:${input.fileId}`;
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
        const prior = (await c.query<{ id: string }>("SELECT d.id FROM integration_imports i JOIN documents d ON d.id = i.document_id WHERE i.provider = $1 AND i.file_id = $2", [input.provider, input.fileId])).rows[0];
        if (prior) {
          const r = (await c.query<Row>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [prior.id])).rows[0]!;
          return { doc: toRecord(r), imported: false };
        }
        const doc = await insertWith(c, input);
        await c.query("INSERT INTO integration_imports (provider, file_id, document_id, imported_at) VALUES ($1, $2, $3, $4)", [input.provider, input.fileId, doc.id, new Date().toISOString()]);
        return { doc, imported: true };
      });
    },

    async listIntegrationConnections() {
      const rows = await pool.query<{ provider: IntegrationProvider; expires_at: string | null; account_name: string | null; connected_at: string }>("SELECT provider, expires_at, account_name, connected_at FROM integration_connections ORDER BY provider");
      return rows.rows.map((r) => ({ provider: r.provider, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at }));
    },

    async getIntegrationConnection(provider) {
      const r = (await pool.query<{ provider: IntegrationProvider; access_token: string; refresh_token: string | null; expires_at: string | null; account_name: string | null; connected_at: string }>("SELECT provider, access_token, refresh_token, expires_at, account_name, connected_at FROM integration_connections WHERE provider = $1", [provider])).rows[0];
      return r && { provider: r.provider, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at };
    },

    async saveIntegrationConnection(c) {
      await pool.query("INSERT INTO integration_connections (provider, access_token, refresh_token, expires_at, account_name, connected_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, account_name = excluded.account_name, connected_at = excluded.connected_at", [c.provider, c.accessToken, c.refreshToken, c.expiresAt, c.accountName, c.connectedAt]);
    },

    async deleteIntegrationConnection(provider) {
      await pool.query("DELETE FROM integration_connections WHERE provider = $1", [provider]);
    },

    async getIntegrationImport(provider, fileId) {
      const r = (await pool.query<{ provider: IntegrationProvider; file_id: string; document_id: string; imported_at: string }>("SELECT provider, file_id, document_id, imported_at FROM integration_imports WHERE provider = $1 AND file_id = $2", [provider, fileId])).rows[0];
      return r && { provider: r.provider, fileId: r.file_id, documentId: r.document_id, importedAt: r.imported_at };
    },

    async getDocument(id) {
      const r = await pool.query<Row>(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = $1`, [id]);
      return r.rows[0] && toRecord(r.rows[0]);
    },

    async listDocuments(limit, offset) {
      const rows = await pool.query<Omit<Row, "content"> & { size: number }>(
        `SELECT id, title, version, content_hash, created_at, updated_at, length(content) AS size
         FROM documents ORDER BY created_at DESC, seq DESC LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      const total = Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM documents")).rows[0]!.n);
      const items: DocumentSummary[] = rows.rows.map((r) => ({ id: r.id, title: r.title, version: r.version, contentHash: r.content_hash, createdAt: r.created_at, updatedAt: r.updated_at, size: Number(r.size) }));
      return { total, items };
    },

    async deleteDocument(id) {
      return (await pool.query("DELETE FROM documents WHERE id = $1", [id])).rowCount === 1;
    },

    /** Compare-and-swap: the UPDATE only matches while the row is still at `expectedVersion`. The generated tsvector and both indexes follow in the same transaction. */
    async commitRevision(args) {
      const now = new Date().toISOString();
      const hash = sha256(args.content);
      const next = args.expectedVersion + 1;
      return tx(async (c) => {
        const res = await c.query<Row>(
          `UPDATE documents SET content = $1, version = $2, content_hash = $3, updated_at = $4 WHERE id = $5 AND version = $6 RETURNING ${DOC_COLUMNS}`,
          [args.content, next, hash, now, args.id, args.expectedVersion],
        );
        if (res.rowCount !== 1) return "conflict" as const;
        await c.query("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [args.id, next, args.content, hash, args.summary, now]);
        return toRecord(res.rows[0]!);
      });
    },

    async listRevisions(id) {
      const r = await pool.query<{ version: number; content_hash: string; created_at: string; summary: string }>("SELECT version, content_hash, created_at, summary FROM revisions WHERE document_id = $1 ORDER BY version DESC", [id]);
      return r.rows.map((x): RevisionInfo => ({ version: x.version, contentHash: x.content_hash, createdAt: x.created_at, summary: JSON.parse(x.summary) }));
    },

    async getRevision(id, version) {
      const r = await pool.query<{ version: number; content: string; content_hash: string; created_at: string; summary: string }>("SELECT version, content, content_hash, created_at, summary FROM revisions WHERE document_id = $1 AND version = $2", [id, version]);
      const x = r.rows[0];
      return x && { version: x.version, content: x.content, contentHash: x.content_hash, createdAt: x.created_at, summary: JSON.parse(x.summary) };
    },

    async wordsPage(query, { ids = [], limit, offset }) {
      const params: unknown[] = [toTsQuery(query)];
      const idFilter = ids.length ? "AND id = ANY($2)" : "";
      if (ids.length) params.push(ids);
      return tx(async (client) => {
        const count = await client.query<{ n: string }>(`SELECT count(*) AS n FROM documents, to_tsquery('english', $1) q WHERE search @@ q ${idFilter}`, params);
        const rows = await client.query<WordSnapshot>(`WITH page AS MATERIALIZED (
          SELECT id, title, version, length(content) AS size, ts_rank_cd(search, q, 1) AS score, seq
          FROM documents, to_tsquery('english', $1) q WHERE search @@ q ${idFilter}
          ORDER BY score DESC, seq LIMIT $${params.length + 1} OFFSET $${params.length + 2})
          SELECT page.id, page.title, page.version, page.size, page.score, d.content
          FROM page JOIN documents d ON d.id = page.id ORDER BY page.score DESC, page.seq`, [...params, limit, offset]);
        return { total: Number(count.rows[0]!.n), items: rows.rows.map((r) => ({ ...r, size: Number(r.size), score: Number(r.score) })) };
      }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    },

    /** LIKE is case-sensitive; the trigram GIN index serves it for patterns of >= 3 characters. Callers verify by scanning the text. */
    async exactCandidates(query, ids = []) {
      const params: unknown[] = [`%${escapeLike(query)}%`];
      let idFilter = "";
      if (ids.length) {
        params.push(ids);
        idFilter = "AND id = ANY($2)";
      }
      const r = await pool.query<ExactCandidate>(`SELECT id, title, version, content FROM documents WHERE content LIKE $1 ESCAPE '\\' ${idFilter}`, params);
      return r.rows;
    },

    async listRequirements(documentId) {
      const r = await pool.query<{ id: string; document_id: string; kind: RequirementKind; text: string; created_at: string }>("SELECT id, document_id, kind, text, created_at FROM requirements WHERE document_id = $1 ORDER BY seq", [documentId]);
      return r.rows.map((x): Requirement => ({ id: x.id, documentId: x.document_id, kind: x.kind, text: x.text, createdAt: x.created_at }));
    },

    async addRequirement(documentId, input) {
      const id = `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const now = new Date().toISOString();
      await pool.query("INSERT INTO requirements (id, document_id, kind, text, created_at) VALUES ($1, $2, $3, $4, $5)", [id, documentId, input.kind, input.text, now]);
      return { id, documentId, kind: input.kind, text: input.text, createdAt: now };
    },

    async deleteRequirement(documentId, id) {
      return (await pool.query("DELETE FROM requirements WHERE document_id = $1 AND id = $2", [documentId, id])).rowCount === 1;
    },

    async listRecentRevisions(limit) {
      const r = await pool.query<{ document_id: string; title: string; version: number; content_hash: string; created_at: string; summary: string }>(
        "SELECT r.document_id, d.title, r.version, r.content_hash, r.created_at, r.summary FROM revisions r JOIN documents d ON d.id = r.document_id ORDER BY r.created_at DESC, r.version DESC LIMIT $1",
        [limit],
      );
      return r.rows.map((x) => ({ documentId: x.document_id, title: x.title, version: x.version, contentHash: x.content_hash, createdAt: x.created_at, summary: JSON.parse(x.summary) }));
    },

    async listRequests() {
      return (await pool.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM requests ORDER BY updated_at DESC, seq DESC`)).rows.map(toRequest);
    },

    async getRequest(id) {
      return fetchRequest(pool, id);
    },

    async insertRequest(input) {
      const id = newId("wrq");
      const now = new Date().toISOString();
      await pool.query("INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $9)", [id, input.documentId, input.title, input.goal, input.status, input.priority, input.type, input.dueDate, now]);
      return (await fetchRequest(pool, id))!;
    },

    async updateRequest(id, patch) {
      const cols = requestPatchColumns(patch);
      const now = new Date().toISOString();
      const set = [...cols.map(([c], i) => `${c} = $${i + 1}`), `updated_at = $${cols.length + 1}`].join(", ");
      const res = await pool.query(`UPDATE requests SET ${set} WHERE id = $${cols.length + 2}`, [...cols.map(([, v]) => v), now, id]);
      return res.rowCount === 1 ? fetchRequest(pool, id) : undefined;
    },

    async deleteRequest(id) {
      return (await pool.query("DELETE FROM requests WHERE id = $1", [id])).rowCount === 1;
    },

    async listPlaybooks() {
      const r = await pool.query<PlaybookRow & { rule_count: string }>("SELECT p.id, p.name, p.description, p.created_at, p.updated_at, (SELECT count(*) FROM playbook_rules r WHERE r.playbook_id = p.id) AS rule_count FROM playbooks p ORDER BY p.seq");
      return r.rows.map((x) => ({ ...toPlaybook(x), ruleCount: Number(x.rule_count) }));
    },

    async getPlaybook(id) {
      const p = (await pool.query<PlaybookRow>("SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = $1", [id])).rows[0];
      if (!p) return undefined;
      const rules = (await pool.query<RuleRow>("SELECT id, playbook_id, title, kind, text, created_at FROM playbook_rules WHERE playbook_id = $1 ORDER BY seq", [id])).rows;
      return { ...toPlaybook(p), rules: rules.map(toRule) };
    },

    async insertPlaybook(input) {
      const id = newId("pbk");
      const now = new Date().toISOString();
      await pool.query("INSERT INTO playbooks (id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [id, input.name, input.description, now]);
      return { id, name: input.name, description: input.description, createdAt: now, updatedAt: now };
    },

    async updatePlaybook(id, patch) {
      const cur = (await pool.query<PlaybookRow>("SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = $1", [id])).rows[0];
      if (!cur) return undefined;
      const now = new Date().toISOString();
      const name = patch.name ?? cur.name;
      const description = patch.description ?? cur.description;
      await pool.query("UPDATE playbooks SET name = $1, description = $2, updated_at = $3 WHERE id = $4", [name, description, now, id]);
      return { id, name, description, createdAt: cur.created_at, updatedAt: now };
    },

    async deletePlaybook(id) {
      return (await pool.query("DELETE FROM playbooks WHERE id = $1", [id])).rowCount === 1;
    },

    async addPlaybookRule(playbookId, input) {
      return tx(async (c) => {
        const now = new Date().toISOString();
        const touched = await c.query("UPDATE playbooks SET updated_at = $1 WHERE id = $2", [now, playbookId]);
        if (touched.rowCount !== 1) return undefined;
        const id = newId("rul");
        await c.query("INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [id, playbookId, input.title, input.kind, input.text, now]);
        return { id, playbookId, title: input.title, kind: input.kind, text: input.text, createdAt: now };
      });
    },

    async deletePlaybookRule(playbookId, ruleId) {
      return (await pool.query("DELETE FROM playbook_rules WHERE playbook_id = $1 AND id = $2", [playbookId, ruleId])).rowCount === 1;
    },

    async seedPlaybooksIfEmpty(items) {
      return tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(727276)");
        if (Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM playbooks")).rows[0]!.n) > 0) return 0;
        const now = new Date().toISOString();
        for (const pb of items) {
          const pid = newId("pbk");
          await c.query("INSERT INTO playbooks (id, name, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)", [pid, pb.name, pb.description, now]);
          for (const r of pb.rules) await c.query("INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [newId("rul"), pid, r.title, r.kind, r.text, now]);
        }
        return items.length;
      });
    },

    async seedRequestsIfEmpty(items) {
      return tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(727277)");
        if (Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM requests")).rows[0]!.n) > 0) return 0;
        let n = 0;
        for (const it of items) {
          const doc = (await c.query<{ id: string }>("SELECT id FROM documents WHERE title = $1 ORDER BY seq LIMIT 1", [it.documentTitle])).rows[0];
          if (!doc) continue;
          const now = new Date(Date.now() - (items.length - n) * 3_600_000).toISOString();
          n++;
          await c.query("INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $9)", [newId("wrq"), doc.id, it.title, it.goal, it.status, it.priority, it.type, it.dueInDays === undefined ? null : dueIn(it.dueInDays), now]);
        }
        return n;
      });
    },

    /** An advisory lock makes "is it empty? then fill it" atomic across instances: exactly one cold start seeds. */
    async seedIfEmpty(items) {
      return tx(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(727275)");
        if (Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM documents")).rows[0]!.n) > 0) return 0;
        for (const item of items) await insertWith(c, item);
        return items.length;
      });
    },

    async close() {
      await pool.end();
      if (schema && opts.dropSchemaOnClose) {
        const boot = new pg.Pool({ connectionString: opts.connectionString, max: 1 });
        await boot.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await boot.end();
      }
    },
  };
}
