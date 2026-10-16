import { randomUUID } from "node:crypto";
import { sha256 } from "@clause/core";
import { openDb, transaction, type Db } from "../db.ts";
import { dueIn, newId, REQUEST_COLUMNS, requestPatchColumns, toPlaybook, toRequest, toRule, type PlaybookRow, type RequestRow, type RuleRow } from "./shared.ts";
import { InvalidQueryError, queryTerms, type Requirement, type RequirementKind, type DocumentRecord, type DocumentSummary, type ExactCandidate, NATIVE_SNIPPET_MAX_CHARS, type WordSnapshot, type RevisionInfo, type Store, type IntegrationConnection, type IntegrationProvider } from "./types.ts";

const OPEN = "\u0002";
const CLOSE = "\u0003";
const ELLIPSIS = "…";

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
  ...(r.template_provenance ? { templateProvenance: JSON.parse(r.template_provenance) } : {}),
});

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * Plain text -> FTS5 query. Every term (or "quoted phrase") is emitted as an FTS5 phrase literal, so operators,
 * column filters, NEAR, `*` and `-` in user input are inert. Terms are implicitly ANDed.
 */
export function compileWordsQuery(q: string): string {
  const terms = queryTerms(q);
  if (terms.length === 0) throw new InvalidQueryError("Query is empty");
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}

/** SQLite + FTS5. Synchronous underneath; the methods are async only to satisfy the shared interface. */
export function createSqliteStore(path: string): Store {
  return sqliteStore(openDb(path));
}

export function sqliteStore(db: Db): Store {
  const getDoc = (id: string): DocumentRecord | undefined => {
    const row = db.prepare("SELECT id, title, content, version, content_hash, created_at, updated_at, template_provenance FROM documents WHERE id = ?").get(id);
    return row ? toRecord(row as unknown as Row) : undefined;
  };

  return {
    kind: "sqlite",
    maxContentChars: Number.POSITIVE_INFINITY,

    async insertDocument(input) {
      const now = new Date().toISOString();
      const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const hash = sha256(input.content);
      return transaction(db, () => {
        const provenance = input.templateProvenance ? JSON.stringify(input.templateProvenance) : null;
        db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at, template_provenance) VALUES (?, ?, ?, 1, ?, ?, ?, ?)").run(id, input.title, input.content, hash, now, now, provenance);
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, input.content, hash, JSON.stringify([{ created: true }]), now);
        return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now, ...(input.templateProvenance ? { templateProvenance: input.templateProvenance } : {}) };
      });
    },

    async insertImportedDocument(input) {
      return transaction(db, () => {
        const prior = db.prepare("SELECT d.id FROM integration_imports i JOIN documents d ON d.id = i.document_id WHERE i.provider = ? AND i.file_id = ?").get(input.provider, input.fileId) as { id: string } | undefined;
        if (prior) return { doc: getDoc(prior.id)!, imported: false };
        const now = new Date().toISOString();
        const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const hash = sha256(input.content);
        db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(id, input.title, input.content, hash, now, now);
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, input.content, hash, JSON.stringify([{ created: true, importedFrom: input.provider }]), now);
        db.prepare("INSERT INTO integration_imports (provider, file_id, document_id, imported_at) VALUES (?, ?, ?, ?)").run(input.provider, input.fileId, id, now);
        return { doc: getDoc(id)!, imported: true };
      });
    },

    async listIntegrationConnections() {
      const rows = db.prepare("SELECT provider, expires_at, account_name, connected_at FROM integration_connections ORDER BY provider").all() as unknown as { provider: IntegrationProvider; expires_at: string | null; account_name: string | null; connected_at: string }[];
      return rows.map((r) => ({ provider: r.provider, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at }));
    },

    async getIntegrationConnection(provider) {
      const r = db.prepare("SELECT provider, access_token, refresh_token, expires_at, account_name, connected_at FROM integration_connections WHERE provider = ?").get(provider) as unknown as { provider: IntegrationProvider; access_token: string; refresh_token: string | null; expires_at: string | null; account_name: string | null; connected_at: string } | undefined;
      return r && { provider: r.provider, accessToken: r.access_token, refreshToken: r.refresh_token, expiresAt: r.expires_at, accountName: r.account_name, connectedAt: r.connected_at };
    },

    async saveIntegrationConnection(c: IntegrationConnection) {
      db.prepare("INSERT INTO integration_connections (provider, access_token, refresh_token, expires_at, account_name, connected_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at, account_name = excluded.account_name, connected_at = excluded.connected_at").run(c.provider, c.accessToken, c.refreshToken, c.expiresAt, c.accountName, c.connectedAt);
    },

    async deleteIntegrationConnection(provider) {
      db.prepare("DELETE FROM integration_connections WHERE provider = ?").run(provider);
    },

    async getIntegrationImport(provider, fileId) {
      const r = db.prepare("SELECT provider, file_id, document_id, imported_at FROM integration_imports WHERE provider = ? AND file_id = ?").get(provider, fileId) as unknown as { provider: IntegrationProvider; file_id: string; document_id: string; imported_at: string } | undefined;
      return r && { provider: r.provider, fileId: r.file_id, documentId: r.document_id, importedAt: r.imported_at };
    },

    async getDocument(id) {
      return getDoc(id);
    },

    async listDocuments(limit, offset) {
      const rows = db
        .prepare(
          `SELECT id, title, version, content_hash, created_at, updated_at, length(content) AS size
           FROM documents ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as unknown as (Omit<Row, "content"> & { size: number })[];
      const { n } = db.prepare("SELECT count(*) AS n FROM documents").get() as { n: number };
      const items: DocumentSummary[] = rows.map((r) => ({ id: r.id, title: r.title, version: r.version, contentHash: r.content_hash, createdAt: r.created_at, updatedAt: r.updated_at, size: r.size }));
      return { total: n, items };
    },

    async deleteDocument(id) {
      return transaction(db, () => db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes === 1);
    },

    /** Compare-and-swap: the UPDATE only matches while the row is still at `expectedVersion`. Triggers keep both FTS indexes in step. */
    async commitRevision(args) {
      const now = new Date().toISOString();
      const hash = sha256(args.content);
      const next = args.expectedVersion + 1;
      return transaction(db, () => {
        const res = db.prepare("UPDATE documents SET content = ?, version = ?, content_hash = ?, updated_at = ? WHERE id = ? AND version = ?").run(args.content, next, hash, now, args.id, args.expectedVersion);
        if (res.changes !== 1) return "conflict" as const;
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(args.id, next, args.content, hash, args.summary, now);
        return getDoc(args.id)!;
      });
    },

    async listRevisions(id) {
      const rows = db
        .prepare("SELECT version, content_hash, created_at, summary FROM revisions WHERE document_id = ? ORDER BY version DESC")
        .all(id) as unknown as { version: number; content_hash: string; created_at: string; summary: string }[];
      return rows.map((r): RevisionInfo => ({ version: r.version, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary) }));
    },

    async getRevision(id, version) {
      const r = db
        .prepare("SELECT version, content, content_hash, created_at, summary FROM revisions WHERE document_id = ? AND version = ?")
        .get(id, version) as unknown as { version: number; content: string; content_hash: string; created_at: string; summary: string } | undefined;
      return r && { version: r.version, content: r.content, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary) };
    },

    async wordsPage(query, { ids = [], limit, offset }) {
      const match = compileWordsQuery(query);
      const idFilter = ids.length ? `AND d.id IN (${placeholders(ids.length)})` : "";
      db.exec("BEGIN");
      try {
        const { n } = db.prepare(`SELECT count(*) AS n FROM documents_words JOIN documents d ON d.seq = documents_words.rowid WHERE documents_words MATCH ? ${idFilter}`).get(match, ...ids) as { n: number };
        const ranked = db.prepare(`SELECT d.id, d.title, d.version, length(d.content) AS size, bm25(documents_words, 5.0, 1.0) AS score
          FROM documents_words JOIN documents d ON d.seq = documents_words.rowid
          WHERE documents_words MATCH ? ${idFilter} ORDER BY score, d.seq LIMIT ? OFFSET ?`).all(match, ...ids, limit, offset) as unknown as Omit<WordSnapshot, "content">[];
        const items = ranked.map((r): WordSnapshot => {
          const content = getDoc(r.id)!.content;
          const snippet = r.size <= NATIVE_SNIPPET_MAX_CHARS
            ? db.prepare(`SELECT snippet(documents_words, 1, '${OPEN}', '${CLOSE}', '${ELLIPSIS}', 24) AS snip
                FROM documents_words JOIN documents d ON d.seq = documents_words.rowid WHERE documents_words MATCH ? AND d.id = ?`).get(match, r.id) as { snip: string } | undefined
            : undefined;
          return { ...r, score: -r.score, content, ...(snippet && { nativeSnippet: snippet.snip }) };
        });
        db.exec("COMMIT");
        return { total: n, items };
      } catch (e) {
        db.exec("ROLLBACK");
        if (e instanceof Error && /fts5|unterminated|syntax|malformed/i.test(e.message)) throw new InvalidQueryError(`Unsupported query: ${e.message}`);
        throw e;
      }
    },

    /** Trigram index (case-insensitive, needs >= 3 chars) narrows candidates; instr() covers shorter queries. */
    async exactCandidates(query, ids = []) {
      const idFilter = ids.length ? `AND d.id IN (${placeholders(ids.length)})` : "";
      const rows =
        query.length >= 3
          ? db
              .prepare(
                `SELECT d.id, d.title, d.version, d.content FROM documents_trgm
                 JOIN documents d ON d.seq = documents_trgm.rowid
                 WHERE documents_trgm MATCH ? ${idFilter}`,
              )
              .all(`"${query.replaceAll('"', '""')}"`, ...ids)
          : db.prepare(`SELECT d.id, d.title, d.version, d.content FROM documents d WHERE instr(d.content, ?) > 0 ${idFilter}`).all(query, ...ids);
      return rows as unknown as ExactCandidate[];
    },

    async listRequirements(documentId) {
      const rows = db.prepare("SELECT id, document_id, kind, text, created_at FROM requirements WHERE document_id = ? ORDER BY seq").all(documentId) as unknown as { id: string; document_id: string; kind: RequirementKind; text: string; created_at: string }[];
      return rows.map((r): Requirement => ({ id: r.id, documentId: r.document_id, kind: r.kind, text: r.text, createdAt: r.created_at }));
    },

    async addRequirement(documentId, input) {
      const id = `req_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const now = new Date().toISOString();
      db.prepare("INSERT INTO requirements (id, document_id, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM requirements WHERE document_id = ?))").run(id, documentId, input.kind, input.text, now, documentId);
      return { id, documentId, kind: input.kind, text: input.text, createdAt: now };
    },

    async deleteRequirement(documentId, id) {
      return db.prepare("DELETE FROM requirements WHERE document_id = ? AND id = ?").run(documentId, id).changes === 1;
    },

    async listRecentRevisions(limit) {
      const rows = db
        .prepare("SELECT r.document_id, d.title, r.version, r.content_hash, r.created_at, r.summary FROM revisions r JOIN documents d ON d.id = r.document_id ORDER BY r.created_at DESC, r.version DESC LIMIT ?")
        .all(limit) as unknown as { document_id: string; title: string; version: number; content_hash: string; created_at: string; summary: string }[];
      return rows.map((r) => ({ documentId: r.document_id, title: r.title, version: r.version, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary) }));
    },

    async listRequests() {
      return (db.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests ORDER BY updated_at DESC, seq DESC`).all() as unknown as RequestRow[]).map(toRequest);
    },

    async getRequest(id) {
      const r = db.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE id = ?`).get(id) as unknown as RequestRow | undefined;
      return r && toRequest(r);
    },

    async insertRequest(input) {
      const id = newId("wrq");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM requests))").run(id, input.documentId, input.title, input.goal, input.status, input.priority, input.type, input.dueDate, now, now);
      return (await this.getRequest(id))!;
    },

    async updateRequest(id, patch) {
      const cols = requestPatchColumns(patch);
      const now = new Date().toISOString();
      const set = [...cols.map(([c]) => `${c} = ?`), "updated_at = ?"].join(", ");
      const res = db.prepare(`UPDATE requests SET ${set} WHERE id = ?`).run(...cols.map(([, v]) => v), now, id);
      return res.changes === 1 ? this.getRequest(id) : undefined;
    },

    async deleteRequest(id) {
      return db.prepare("DELETE FROM requests WHERE id = ?").run(id).changes === 1;
    },

    async listPlaybooks() {
      const rows = db.prepare("SELECT p.id, p.name, p.description, p.created_at, p.updated_at, (SELECT count(*) FROM playbook_rules r WHERE r.playbook_id = p.id) AS rule_count FROM playbooks p ORDER BY p.seq").all() as unknown as (PlaybookRow & { rule_count: number })[];
      return rows.map((r) => ({ ...toPlaybook(r), ruleCount: Number(r.rule_count) }));
    },

    async getPlaybook(id) {
      const p = db.prepare("SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = ?").get(id) as unknown as PlaybookRow | undefined;
      if (!p) return undefined;
      const rules = db.prepare("SELECT id, playbook_id, title, kind, text, created_at FROM playbook_rules WHERE playbook_id = ? ORDER BY seq").all(id) as unknown as RuleRow[];
      return { ...toPlaybook(p), rules: rules.map(toRule) };
    },

    async insertPlaybook(input) {
      const id = newId("pbk");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO playbooks (id, name, description, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM playbooks))").run(id, input.name, input.description, now, now);
      return { id, name: input.name, description: input.description, createdAt: now, updatedAt: now };
    },

    async updatePlaybook(id, patch) {
      const now = new Date().toISOString();
      const cur = db.prepare("SELECT id, name, description, created_at, updated_at FROM playbooks WHERE id = ?").get(id) as unknown as PlaybookRow | undefined;
      if (!cur) return undefined;
      const name = patch.name ?? cur.name;
      const description = patch.description ?? cur.description;
      db.prepare("UPDATE playbooks SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(name, description, now, id);
      return { id, name, description, createdAt: cur.created_at, updatedAt: now };
    },

    async deletePlaybook(id) {
      return db.prepare("DELETE FROM playbooks WHERE id = ?").run(id).changes === 1;
    },

    async addPlaybookRule(playbookId, input) {
      if (!db.prepare("SELECT 1 FROM playbooks WHERE id = ?").get(playbookId)) return undefined;
      const id = newId("rul");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM playbook_rules WHERE playbook_id = ?))").run(id, playbookId, input.title, input.kind, input.text, now, playbookId);
      db.prepare("UPDATE playbooks SET updated_at = ? WHERE id = ?").run(now, playbookId);
      return { id, playbookId, title: input.title, kind: input.kind, text: input.text, createdAt: now };
    },

    async deletePlaybookRule(playbookId, ruleId) {
      return db.prepare("DELETE FROM playbook_rules WHERE playbook_id = ? AND id = ?").run(playbookId, ruleId).changes === 1;
    },

    async seedPlaybooksIfEmpty(items) {
      return transaction(db, () => {
        if ((db.prepare("SELECT count(*) AS n FROM playbooks").get() as { n: number }).n > 0) return 0;
        const now = new Date().toISOString();
        items.forEach((pb, i) => {
          const pid = newId("pbk");
          db.prepare("INSERT INTO playbooks (id, name, description, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(pid, pb.name, pb.description, now, now, i + 1);
          for (const [j, r] of pb.rules.entries()) db.prepare("INSERT INTO playbook_rules (id, playbook_id, title, kind, text, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)").run(newId("rul"), pid, r.title, r.kind, r.text, now, j + 1);
        });
        return items.length;
      });
    },

    async seedRequestsIfEmpty(items) {
      return transaction(db, () => {
        if ((db.prepare("SELECT count(*) AS n FROM requests").get() as { n: number }).n > 0) return 0;
        let n = 0;
        for (const it of items) {
          const doc = db.prepare("SELECT id FROM documents WHERE title = ? ORDER BY seq LIMIT 1").get(it.documentTitle) as { id: string } | undefined;
          if (!doc) continue;
          const now = new Date(Date.now() - (items.length - n) * 3_600_000).toISOString();
          db.prepare("INSERT INTO requests (id, document_id, title, goal, status, priority, type, due_date, ci, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)").run(newId("wrq"), doc.id, it.title, it.goal, it.status, it.priority, it.type, it.dueInDays === undefined ? null : dueIn(it.dueInDays), now, now, ++n);
        }
        return n;
      });
    },

    async seedIfEmpty(items) {
      const now = new Date().toISOString();
      return transaction(db, () => {
        if ((db.prepare("SELECT count(*) AS n FROM documents").get() as { n: number }).n > 0) return 0;
        for (const item of items) {
          const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
          const hash = sha256(item.content);
          db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(id, item.title, item.content, hash, now, now);
          db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, item.content, hash, JSON.stringify([{ created: true }]), now);
        }
        return items.length;
      });
    },

    async close() {
      db.close();
    },
  };
}
