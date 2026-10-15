import { randomUUID } from "node:crypto";
import { sha256, type AppliedChange } from "@clause/core";
import { transaction, type Db } from "./db.ts";

export interface DocumentRecord {
  id: string;
  title: string;
  content: string;
  version: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export type DocumentSummary = Omit<DocumentRecord, "content"> & { size: number };

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

/** Long before/after strings are truncated in the history summary; full text lives in the snapshots. */
const SUMMARY_TEXT_LIMIT = 200;
const clip = (s: string) => (s.length > SUMMARY_TEXT_LIMIT ? `${s.slice(0, SUMMARY_TEXT_LIMIT)}…` : s);

export function summarize(applied: readonly AppliedChange[]): string {
  return JSON.stringify(applied.map((a) => ({ ...a, before: clip(a.before), after: clip(a.after) })));
}

export function insertDocument(db: Db, input: { title: string; content: string }): DocumentRecord {
  const now = new Date().toISOString();
  const id = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const hash = sha256(input.content);
  return transaction(db, () => {
    db.prepare(
      "INSERT INTO documents (id, title, content, version, content_hash, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)",
    ).run(id, input.title, input.content, hash, now, now);
    db.prepare(
      "INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, 1, ?, ?, ?, ?)",
    ).run(id, input.content, hash, JSON.stringify([{ created: true }]), now);
    return { id, title: input.title, content: input.content, version: 1, contentHash: hash, createdAt: now, updatedAt: now };
  });
}

export function getDocument(db: Db, id: string): DocumentRecord | undefined {
  const row = db.prepare("SELECT id, title, content, version, content_hash, created_at, updated_at FROM documents WHERE id = ?").get(id);
  return row ? toRecord(row as unknown as Row) : undefined;
}

export function listDocuments(db: Db, limit: number, offset: number): { items: DocumentSummary[]; total: number } {
  const rows = db
    .prepare(
      `SELECT id, title, version, content_hash, created_at, updated_at, length(content) AS size
       FROM documents ORDER BY created_at DESC, seq DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as unknown as (Omit<Row, "content"> & { size: number })[];
  const { n } = db.prepare("SELECT count(*) AS n FROM documents").get() as { n: number };
  return {
    total: n,
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      version: r.version,
      contentHash: r.content_hash,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      size: r.size,
    })),
  };
}

export function deleteDocument(db: Db, id: string): boolean {
  return transaction(db, () => db.prepare("DELETE FROM documents WHERE id = ?").run(id).changes === 1);
}

/**
 * Compare-and-swap commit. The UPDATE only matches while the row is still at
 * `expectedVersion`; zero rows changed means another writer won, and nothing
 * is written. Content, revision snapshot and (via triggers) both search
 * indexes change in one transaction or not at all.
 */
export function commitRevision(
  db: Db,
  args: { id: string; expectedVersion: number; content: string; summary: string },
): DocumentRecord | "conflict" {
  const now = new Date().toISOString();
  const hash = sha256(args.content);
  const next = args.expectedVersion + 1;
  return transaction(db, () => {
    const res = db
      .prepare("UPDATE documents SET content = ?, version = ?, content_hash = ?, updated_at = ? WHERE id = ? AND version = ?")
      .run(args.content, next, hash, now, args.id, args.expectedVersion);
    if (res.changes !== 1) return "conflict" as const;
    db.prepare(
      "INSERT INTO revisions (document_id, version, content, content_hash, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(args.id, next, args.content, hash, args.summary, now);
    return getDocument(db, args.id)!;
  });
}

export interface RevisionInfo {
  version: number;
  contentHash: string;
  createdAt: string;
  summary: unknown;
}

export function listRevisions(db: Db, id: string): RevisionInfo[] {
  const rows = db
    .prepare("SELECT version, content_hash, created_at, summary FROM revisions WHERE document_id = ? ORDER BY version DESC")
    .all(id) as unknown as { version: number; content_hash: string; created_at: string; summary: string }[];
  return rows.map((r) => ({ version: r.version, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary) }));
}

export function getRevision(db: Db, id: string, version: number): (RevisionInfo & { content: string }) | undefined {
  const r = db
    .prepare("SELECT version, content, content_hash, created_at, summary FROM revisions WHERE document_id = ? AND version = ?")
    .get(id, version) as unknown as { version: number; content: string; content_hash: string; created_at: string; summary: string } | undefined;
  return r && { version: r.version, content: r.content, contentHash: r.content_hash, createdAt: r.created_at, summary: JSON.parse(r.summary) };
}
