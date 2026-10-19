import type { ContentSnapshot, JobOutput, JobPayload, SnapshotCursor, SnapshotObject } from "../jobs/types.ts";
import type { AppliedChange } from "@clause/core";

export interface DocumentRecord {
  id: string;
  title: string;
  content: string;
  /** Immutable object path for versions above the inline API threshold. */
  contentPath?: string;
  version: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  templateProvenance?: TemplateProvenance;
  /** One of the shared sample contracts: the server restores it if missing and the API refuses to change it. */
  sample?: boolean;
}

export interface TemplateProvenance {
  templateId: string;
  title: string;
  source: string;
  attribution: string;
  sourceUrl: string;
  sourceVersion: string;
  license: string;
  jurisdictionNote: string;
}

export type IntegrationProvider = "imanage" | "netdocuments" | "onedrive" | "dropbox" | "google_drive" | "sharepoint" | "box";
export interface IntegrationConnection {
  provider: IntegrationProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  accountName: string | null;
  connectedAt: string;
}
export interface IntegrationImport {
  provider: IntegrationProvider;
  fileId: string;
  documentId: string;
  importedAt: string;
}

export type DocumentSummary = Omit<DocumentRecord, "content" | "contentPath"> & { size: number; byteLength: number; utf16Length: number; wordCount?: number };

/** Body-free row used by lists, validators, and content-link requests. Offsets are UTF-16 code units. */
export type DocumentMetadata = Omit<DocumentRecord, "content"> & { byteLength: number; utf16Length: number; wordCount?: number };

export interface DocumentReadPrecondition {
  expectedVersion?: number;
  contentHashPrefix?: string;
}

export interface RevisionInfo {
  version: number;
  contentHash: string;
  createdAt: string;
  summary: unknown;
  contentPath?: string;
  byteLength?: number;
  utf16Length?: number;
  wordCount?: number;
}

export type JobStatus="queued"|"running"|"succeeded"|"failed"|"cancelled";
export type JobKind="export"|"provider_import"|"content_backfill"|"integrity_sweep"|"orphan_cleanup";
export interface JobRecord {
  id:string;
  idempotencyKey:string;
  kind:JobKind;
  status:JobStatus;
  progress:number;
  resultRef?:string;
  errorCode?:string;
  createdAt:string;
  updatedAt:string;
  expiresAt?:string;
  payload?:JobPayload;
  output?:JobOutput;
  checkpoint?:string;
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

export const NATIVE_SNIPPET_MAX_CHARS = 256 * 1024;

export interface WordSnapshot {
  id: string;
  title: string;
  version: number;
  /** Characters in the current text. */
  size: number;
  /** Backend-specific relevance, higher is better (SQLite: -bm25, Postgres: ts_rank_cd). */
  score: number;
  /** A bounded body window used to verify snippet offsets. */
  content: string;
  contentOffset?: number;
  nativeSnippet?: string;
  /** content is a small window, so its local match position is not a document offset. */
  contentIsWindow?: boolean;
}

export interface ExactHitSnapshot { start:number; end:number; before:string; after:string }
export interface ExactSnapshot { id:string;title:string;version:number;matchCount:number;hits:ExactHitSnapshot[] }

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
  /** Backend UTF-16 safety ceiling; all stores also enforce the shared 25 MiB UTF-8 document limit. */
  readonly maxContentChars: number;

  insertDocument(input: { title: string; content: string; contentPath?: string; templateProvenance?: TemplateProvenance }): Promise<DocumentRecord>;
  insertDocumentWithRequirements(input: { title: string; content: string; contentPath?: string; requirements: { kind: RequirementKind; text: string }[] }): Promise<DocumentRecord | undefined>;
  insertImportedDocument(input: { title: string; content: string; contentPath?: string; provider: IntegrationProvider; fileId: string; jobId?:string }): Promise<{ doc: DocumentRecord; imported: boolean }>;
  listIntegrationConnections(): Promise<Omit<IntegrationConnection, "accessToken" | "refreshToken">[]>;
  getIntegrationConnection(provider: IntegrationProvider): Promise<IntegrationConnection | undefined>;
  saveIntegrationConnection(connection: IntegrationConnection): Promise<void>;
  deleteIntegrationConnection(provider: IntegrationProvider): Promise<void>;
  getIntegrationImport(provider: IntegrationProvider, fileId: string): Promise<IntegrationImport | undefined>;
  getDocument(id: string): Promise<DocumentRecord | undefined>;
  getDocumentMetadata(id: string): Promise<DocumentMetadata | undefined>;
  getDocumentForEdit(id:string,precondition:DocumentReadPrecondition):Promise<DocumentRecord|DocumentMetadata|undefined>;
  listDocuments(limit: number, offset: number): Promise<{ items: DocumentSummary[]; total: number }>;
  deleteDocument(id: string): Promise<boolean>;
  commitRevision(args: { id: string; expectedVersion: number; content: string; contentPath?: string; previousContent?:string; summary: string }): Promise<DocumentRecord | "conflict">;
  listRevisions(id: string): Promise<RevisionInfo[]>;
  getRevision(id: string, version: number): Promise<(RevisionInfo & { content: string }) | undefined>;
  getRevisionMetadata(id: string, version: number): Promise<RevisionInfo | undefined>;
  createJob(input:{idempotencyKey:string;kind:JobKind;expiresAt?:string;payload?:JobPayload}):Promise<{job:JobRecord;created:boolean}|undefined>;
  getJob(id:string):Promise<JobRecord|undefined>;
  claimJob(id:string,maxConcurrent:number):Promise<boolean>;
  updateJob(id:string,patch:{status?:JobStatus;progress?:number;resultRef?:string|null;errorCode?:string|null;expiresAt?:string|null;checkpoint?:string;output?:JobOutput}):Promise<JobRecord|undefined>;
  completeJob(id:string,resultRef:string,expiresAt:string):Promise<boolean>;
  failJob(id:string,errorCode:string):Promise<boolean>;
  finishJob(id:string,output:JobOutput):Promise<boolean>;
  leaseJob(id:string,owner:string):Promise<boolean>;
  releaseJob(id:string,owner:string):Promise<void>;
  listPendingJobs(limit:number):Promise<JobRecord[]>;
  listExpiredExports(limit:number):Promise<JobRecord[]>;
  snapshotPage(after:SnapshotCursor|undefined,limit:number):Promise<ContentSnapshot[]>;
  setSnapshotMetadata(ref:Omit<SnapshotObject,"contentPath">,jobId?:string):Promise<boolean>;
  setSnapshotObject(ref:SnapshotObject,jobId?:string):Promise<boolean>;
  registerRecoveryManifest(path:string,hash:string,proofPath:string,objects:string[]):Promise<void>;
  pruneSnapshot(ref:SnapshotObject,manifestPath:string):Promise<boolean>;
  restoreSnapshot(ref:SnapshotObject,content:string):Promise<boolean>;
  isContentReferenced(path:string):Promise<boolean>;
  hasOtherActiveJobs(id?:string):Promise<boolean>;
  cancelJob(id:string):Promise<JobRecord|undefined>;

  /** Page metadata, content, and snippets share one database read snapshot. */
  wordsPage(query: string, options: { ids?: string[]; limit: number; offset: number }): Promise<{ total: number; items: WordSnapshot[] }>;
  exactPage(query:string,options:{ids?:string[];limit:number;offset:number;hitsPerDocument:number}):Promise<{total:number;items:ExactSnapshot[]}>;

  listRequirements(documentId: string): Promise<Requirement[]>;
  addRequirement(documentId: string, input: { kind: RequirementKind; text: string }): Promise<Requirement | undefined>;
  applyPlaybookRequirements(documentId: string, rules: { title: string; kind: RequirementKind; text: string }[]): Promise<{ added: Requirement[]; skipped: { title: string; reason: "duplicate" | "limit" }[] }>;
  deleteRequirement(documentId: string, id: string): Promise<boolean>;

  listRecentRevisions(limit: number): Promise<RecentRevision[]>;

  listRequests(): Promise<WorkRequest[]>;
  getRequest(id: string): Promise<WorkRequest | undefined>;
  insertRequest(input: RequestInput): Promise<WorkRequest>;
  updateRequest(id: string, patch: RequestPatch): Promise<WorkRequest | undefined>;
  deleteRequest(id: string): Promise<boolean>;

  listPlaybooks(): Promise<PlaybookSummary[]>;
  getPlaybook(id: string): Promise<(Playbook & { rules: PlaybookRule[] }) | undefined>;
  insertPlaybook(input: { name: string; description: string }): Promise<Playbook | undefined>;
  updatePlaybook(id: string, patch: { name?: string | undefined; description?: string | undefined }): Promise<Playbook | undefined>;
  deletePlaybook(id: string): Promise<boolean>;
  addPlaybookRule(playbookId: string, input: { title: string; kind: RequirementKind; text: string }): Promise<PlaybookRule | undefined>;
  deletePlaybookRule(playbookId: string, ruleId: string): Promise<boolean>;

  /** Like seedIfEmpty, for the sample playbooks and requests: inserts only into an empty table, atomically. Returns how many were inserted. */
  seedPlaybooksIfEmpty(items: SeedPlaybook[]): Promise<number>;
  seedRequestsIfEmpty(items: SeedRequest[]): Promise<number>;

  /**
   * Makes sure every sample exists, atomically (safe if several instances start at once). A sample that is missing is
   * created; an unmarked document with the same title and EXACTLY the canonical text is adopted instead of duplicated.
   * Existing samples are never rewritten. Returns how many were created or adopted.
   */
  ensureSamples(items: { title: string; content: string }[]): Promise<number>;

  /** A cheap database round trip used by /ready; /health remains process liveness only. */
  checkReady(): Promise<void>;

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
