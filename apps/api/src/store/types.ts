import type { AppliedChange } from "@clause/core";

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

export interface RevisionInfo {
  version: number;
  contentHash: string;
  createdAt: string;
  summary: unknown;
}

export interface RankedDocument {
  id: string;
  title: string;
  version: number;
  /** Characters in the current text. */
  size: number;
  /** Backend-specific relevance, higher is better (SQLite: -bm25, Postgres: ts_rank_cd). */
  score: number;
}

export interface ExactCandidate {
  id: string;
  title: string;
  version: number;
  content: string;
}

/** The backend refused to index this text (Postgres: the generated tsvector exceeded its ~1 MB limit). Maps to HTTP 413. */
export class ContentTooLargeError extends Error {}

/** A query the backend cannot run (empty, no searchable words, unsupported syntax). Maps to HTTP 400. */
export class InvalidQueryError extends Error {}

/**
 * Everything the service layer needs from a database. SQLite (local, tests, the 10 MB benchmark) and Postgres
 * (the hosted deployment) both implement it, and the same API test suite runs against each.
 *
 * Contract every implementation must keep:
 *  - `commitRevision` is a compare-and-swap: it writes only if the row is still at `expectedVersion`, and the new
 *    text, the revision snapshot and the search index change in ONE transaction or not at all.
 *  - search reflects a committed write immediately.
 */
export interface Store {
  readonly kind: "sqlite" | "postgres";
  /** Largest document this backend indexes. Postgres caps a tsvector near 1 MB, so it refuses larger text up front. */
  readonly maxContentChars: number;

  insertDocument(input: { title: string; content: string }): Promise<DocumentRecord>;
  getDocument(id: string): Promise<DocumentRecord | undefined>;
  listDocuments(limit: number, offset: number): Promise<{ items: DocumentSummary[]; total: number }>;
  deleteDocument(id: string): Promise<boolean>;
  commitRevision(args: { id: string; expectedVersion: number; content: string; summary: string }): Promise<DocumentRecord | "conflict">;
  listRevisions(id: string): Promise<RevisionInfo[]>;
  getRevision(id: string, version: number): Promise<(RevisionInfo & { content: string }) | undefined>;

  /** Ranks documents matching the plain-text query (words AND-ed, "quoted phrases"). Throws InvalidQueryError. */
  rankWords(query: string, ids?: string[]): Promise<RankedDocument[]>;
  /** Optional: the backend's own best-window snippet, with \u0002/\u0003 around matches. Postgres omits it. */
  wordsSnippet?(id: string, query: string): Promise<string | undefined>;
  getContent(id: string): Promise<string | undefined>;
  /** Documents that MAY contain `query` literally and case-sensitively (callers verify by scanning the text). */
  exactCandidates(query: string, ids?: string[]): Promise<ExactCandidate[]>;

  /** Inserts `items` only if there are no documents at all, atomically (safe if several instances start at once). Returns how many were inserted. */
  seedIfEmpty(items: { title: string; content: string }[]): Promise<number>;

  close(): Promise<void>;
}

/** Long before/after strings are truncated in the history summary; full text lives in the snapshots. */
const SUMMARY_TEXT_LIMIT = 200;
const clip = (s: string) => (s.length > SUMMARY_TEXT_LIMIT ? `${s.slice(0, SUMMARY_TEXT_LIMIT)}…` : s);

export function summarize(applied: readonly AppliedChange[]): string {
  return JSON.stringify(applied.map((a) => ({ ...a, before: clip(a.before), after: clip(a.after) })));
}

/** Splits user text into words and "quoted phrases". */
export function queryTerms(q: string): string[] {
  return [...q.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean);
}
