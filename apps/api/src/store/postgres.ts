import { randomUUID } from "node:crypto";
import { sha256 } from "@clause/core";
import pg from "pg";
import { ContentTooLargeError, InvalidQueryError, queryTerms, type DocumentRecord, type DocumentSummary, type ExactCandidate, type RankedDocument, type RevisionInfo, type Store } from "./types.ts";

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
];

interface Row {
  id: string;
  title: string;
  content: string;
  version: number;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

const toRecord = (r: Row): DocumentRecord => ({
  id: r.id,
  title: r.title,
  content: r.content,
  version: r.version,
  contentHash: r.content_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const DOC_COLUMNS = "id, title, content, version, content_hash, created_at, updated_at";

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

  async function insertWith(c: pg.PoolClient, input: { title: string; content: string }): Promise<DocumentRecord> {
    const now = new Date().toISOString();
    const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const hash = sha256(input.content);
    await c.query("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at) VALUES ($1, $2, $3, 1, $4, $5, $5)", [id, input.title, input.content, hash, now]);
    await c.query("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES ($1, 1, $2, $3, $4, $5)", [id, input.content, hash, JSON.stringify([{ created: true }]), now]);
    return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now };
  }

  /** Runs `fn` on one connection inside a transaction. */
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
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

    async rankWords(query, ids = []) {
      const tsquery = toTsQuery(query);
      const params: unknown[] = [tsquery];
      let idFilter = "";
      if (ids.length) {
        params.push(ids);
        idFilter = "AND id = ANY($2)";
      }
      const r = await pool.query<{ id: string; title: string; version: number; size: number; score: number }>(
        `SELECT id, title, version, length(content) AS size, ts_rank_cd(search, q, 1) AS score
         FROM documents, to_tsquery('english', $1) q
         WHERE search @@ q ${idFilter}
         ORDER BY score DESC, seq`,
        params,
      );
      return r.rows.map((x): RankedDocument => ({ id: x.id, title: x.title, version: x.version, size: Number(x.size), score: Number(x.score) }));
    },

    async getContent(id) {
      return (await pool.query<{ content: string }>("SELECT content FROM documents WHERE id = $1", [id])).rows[0]?.content;
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
