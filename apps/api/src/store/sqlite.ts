import { randomUUID } from "node:crypto";
import { sha256 } from "@clause/core";
import { openDb, transaction, type Db } from "../db.ts";
import { InvalidQueryError, queryTerms, type DocumentRecord, type DocumentSummary, type ExactCandidate, type RankedDocument, type RevisionInfo, type Store } from "./types.ts";

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
    const row = db.prepare("SELECT id, title, content, version, content_hash, created_at, updated_at FROM documents WHERE id = ?").get(id);
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
        db.prepare("INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(id, input.title, input.content, hash, now, now);
        db.prepare("INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, 1, ?, ?, ?, ?)").run(id, input.content, hash, JSON.stringify([{ created: true }]), now);
        return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now };
      });
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

    async rankWords(query, ids = []) {
      const match = compileWordsQuery(query);
      const idFilter = ids.length ? `AND d.id IN (${placeholders(ids.length)})` : "";
      try {
        const rows = db
          .prepare(
            `SELECT d.id, d.title, d.version, length(d.content) AS size, bm25(documents_words, 5.0, 1.0) AS score
             FROM documents_words
             JOIN documents d ON d.seq = documents_words.rowid
             WHERE documents_words MATCH ? ${idFilter}
             ORDER BY score, d.seq`,
          )
          .all(match, ...ids) as unknown as { id: string; title: string; version: number; size: number; score: number }[];
        return rows.map((r): RankedDocument => ({ id: r.id, title: r.title, version: r.version, size: r.size, score: -r.score }));
      } catch (e) {
        if (e instanceof Error && /fts5|unterminated|syntax|malformed/i.test(e.message)) throw new InvalidQueryError(`Unsupported query: ${e.message}`);
        throw e;
      }
    },

    async wordsSnippet(id, query) {
      // NOTE: filter on the JOINED d.id, never `documents_words.rowid = ?`: FTS5 silently ignored the rowid
      // constraint next to MATCH and returned another document's snippet.
      const rows = db
        .prepare(
          `SELECT d.id AS id, snippet(documents_words, 1, '${OPEN}', '${CLOSE}', '${ELLIPSIS}', 24) AS snip
           FROM documents_words JOIN documents d ON d.seq = documents_words.rowid
           WHERE documents_words MATCH ? AND d.id = ?`,
        )
        .all(compileWordsQuery(query), id) as unknown as { id: string; snip: string }[];
      return rows.length === 1 && rows[0]!.id === id ? rows[0]!.snip : undefined; // defence in depth
    },

    async getContent(id) {
      return (db.prepare("SELECT content FROM documents WHERE id = ?").get(id) as { content: string } | undefined)?.content;
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
