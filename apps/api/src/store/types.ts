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

export type RequirementKind = "present" | "absent" | "unchanged" | "semantic";

/** A condition a document must satisfy, kept like a test in a suite and re-run against every proposed edit. */
export interface Requirement {
  id: string;
  documentId: string;
  kind: RequirementKind;
  text: string;
  createdAt: string;
}

/** Most requirements one document may carry: every check costs time and, for semantic ones, money. */
export const MAX_REQUIREMENTS_PER_DOCUMENT = 8;

export const REQUEST_STATUSES = ["inbox", "in_progress", "needs_review", "completed"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const PRIORITIES = ["low", "medium", "high"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const REQUEST_TYPES = ["NDA", "Commercial", "Employment", "Data & Privacy", "Other"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];

/** What the last Clause CI audit of a request's document found. Stored so the board can show it without re-running a model. */
export interface CiSnapshot {
  /** The document version that was audited. */
  version: number;
  checkedAt: string;
  total: number;
  holding: number;
  /** Requirements that do not currently hold (FAIL, NEEDS_REVIEW or UNAVAILABLE). */
  attention: number;
  judges: string[];
  /** Verdict on the request's own goal against the current text, when a goal was checked. */
  goal?: "PASS" | "FAIL" | "NEEDS_REVIEW" | "UNAVAILABLE";
  requirements: { text: string; kind: RequirementKind; verdict: "PASS" | "FAIL" | "NEEDS_REVIEW" | "UNAVAILABLE" }[];
}

/** A unit of legal work on one document: what someone asked for, how urgent it is, and where it stands. */
export interface WorkRequest {
  id: string;
  /** Null once the document was deleted: the request survives, the link does not. */
  documentId: string | null;
  title: string;
  /** The requested outcome, in the requester's words. */
  goal: string;
  status: RequestStatus;
  priority: Priority;
  type: RequestType;
  /** YYYY-MM-DD, or null. */
  dueDate: string | null;
  ci: CiSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export type RequestInput = Pick<WorkRequest, "documentId" | "title" | "goal" | "status" | "priority" | "type" | "dueDate">;
type Opt<T> = { [K in keyof T]?: T[K] | undefined };
export type RequestPatch = Opt<Omit<RequestInput, "documentId">> & { ci?: CiSnapshot | null | undefined };

export const MAX_PLAYBOOKS = 20;
export const MAX_RULES_PER_PLAYBOOK = 30;

export interface PlaybookRule {
  id: string;
  playbookId: string;
  /** Short label shown in lists, e.g. "Preserve compelled-disclosure exception". */
  title: string;
  kind: RequirementKind;
  /** The requirement text added to a document when the playbook is applied. */
  text: string;
  createdAt: string;
}

export interface Playbook {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}
export type PlaybookSummary = Playbook & { ruleCount: number };

export interface RecentRevision extends RevisionInfo {
  documentId: string;
  title: string;
}

export interface SeedPlaybook {
  name: string;
  description: string;
  rules: { title: string; kind: RequirementKind; text: string }[];
}
export interface SeedRequest {
  /** Matched against document titles; skipped if no such document exists. */
  documentTitle: string;
  title: string;
  goal: string;
  status: RequestStatus;
  priority: Priority;
  type: RequestType;
  /** Due this many days from now. */
  dueInDays?: number;
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

  listRequirements(documentId: string): Promise<Requirement[]>;
  addRequirement(documentId: string, input: { kind: RequirementKind; text: string }): Promise<Requirement>;
  deleteRequirement(documentId: string, id: string): Promise<boolean>;

  listRecentRevisions(limit: number): Promise<RecentRevision[]>;

  listRequests(): Promise<WorkRequest[]>;
  getRequest(id: string): Promise<WorkRequest | undefined>;
  insertRequest(input: RequestInput): Promise<WorkRequest>;
  updateRequest(id: string, patch: RequestPatch): Promise<WorkRequest | undefined>;
  deleteRequest(id: string): Promise<boolean>;

  listPlaybooks(): Promise<PlaybookSummary[]>;
  getPlaybook(id: string): Promise<(Playbook & { rules: PlaybookRule[] }) | undefined>;
  insertPlaybook(input: { name: string; description: string }): Promise<Playbook>;
  updatePlaybook(id: string, patch: { name?: string | undefined; description?: string | undefined }): Promise<Playbook | undefined>;
  deletePlaybook(id: string): Promise<boolean>;
  addPlaybookRule(playbookId: string, input: { title: string; kind: RequirementKind; text: string }): Promise<PlaybookRule | undefined>;
  deletePlaybookRule(playbookId: string, ruleId: string): Promise<boolean>;

  /** Like seedIfEmpty, for the sample playbooks and requests: inserts only into an empty table, atomically. Returns how many were inserted. */
  seedPlaybooksIfEmpty(items: SeedPlaybook[]): Promise<number>;
  seedRequestsIfEmpty(items: SeedRequest[]): Promise<number>;

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
