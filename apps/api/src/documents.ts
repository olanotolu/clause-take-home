import { applyChanges, type AppliedChange, type Change, type EditResult, type Result } from "@clause/core";
import type { DomainError } from "./errors.ts";
import { ContentTooLargeError, summarize, type DocumentRecord, type Store } from "./store/types.ts";

export interface ChangeRequest {
  expectedVersion?: number | undefined;
  /** Raw If-Match header value, if the client sent one. */
  ifMatch?: string | undefined;
  changes: Change[];
}

export interface Receipt {
  id: string;
  title: string;
  /** The full updated document text. */
  content: string;
  previousVersion: number;
  version: number;
  /** False when the batch replaced text with identical text: no new revision is created. */
  changed: boolean;
  beforeHash: string;
  afterHash: string;
  applied: AppliedChange[];
  /** Set when this receipt came from a revert: the old version whose text was restored. */
  revertedTo?: number;
}

export const etagOf = (d: Pick<DocumentRecord, "version" | "contentHash">) => `"v${d.version}-${d.contentHash.slice(0, 12)}"`;

const IF_MATCH = /^"v(\d+)-([0-9a-f]+)"$/;

/**
 * Validates client preconditions against the document they will be applied to.
 * `expectedVersion` (body) and `If-Match` (header) may both be given, but must
 * agree. A stale one is a 409 / 412 respectively; we never auto-merge.
 */
function checkPreconditions(doc: DocumentRecord, req: Pick<ChangeRequest, "expectedVersion" | "ifMatch">): DomainError | undefined {
  let ifMatchVersion: number | undefined;
  if (req.ifMatch !== undefined) {
    const m = IF_MATCH.exec(req.ifMatch.trim());
    if (!m) return { type: "INVALID_PRECONDITION", header: "If-Match" };
    ifMatchVersion = Number(m[1]);
    if (req.expectedVersion !== undefined && req.expectedVersion !== ifMatchVersion) {
      return { type: "CONTRADICTORY_PRECONDITIONS", ifMatchVersion, expectedVersion: req.expectedVersion };
    }
    if (req.ifMatch.trim() !== etagOf(doc)) return { type: "PRECONDITION_FAILED", expected: req.ifMatch, current: etagOf(doc) };
  }
  if (req.expectedVersion !== undefined && req.expectedVersion !== doc.version) {
    return { type: "VERSION_CONFLICT", expectedVersion: req.expectedVersion, currentVersion: doc.version };
  }
  return undefined;
}

const fail = (error: DomainError): Result<never, DomainError> => ({ ok: false, error });

/** Refuses text the backend cannot index, rather than storing it half-searchable. */
const tooLarge = (store: Store, content: string): DomainError | undefined =>
  content.length > store.maxContentChars ? { type: "TOO_LARGE_FOR_BACKEND", chars: content.length, max: store.maxContentChars } : undefined;

/** Runs a write, turning the database's own "too large to index" refusal into the same domain error as our cap. */
async function guarded<T>(store: Store, content: string, write: () => Promise<T>): Promise<T | { tooLarge: DomainError }> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof ContentTooLargeError) return { tooLarge: { type: "TOO_LARGE_FOR_BACKEND", chars: content.length, max: store.maxContentChars } };
    throw e;
  }
}
const isTooLarge = (x: unknown): x is { tooLarge: DomainError } => typeof x === "object" && x !== null && "tooLarge" in x;

/** The conflict a failed compare-and-swap means: someone committed between our read and our write. */
async function conflictFor(store: Store, id: string, read: DocumentRecord, ifMatch: string | undefined): Promise<Result<never, DomainError>> {
  const current = await store.getDocument(id);
  if (!current) return fail({ type: "DOCUMENT_NOT_FOUND", id });
  return fail(
    ifMatch !== undefined
      ? { type: "PRECONDITION_FAILED", expected: ifMatch, current: etagOf(current) }
      : { type: "VERSION_CONFLICT", expectedVersion: read.version, currentVersion: current.version },
  );
}

export async function createDocument(store: Store, input: { title: string; content: string; templateProvenance?: import("./store/types.ts").TemplateProvenance }): Promise<Result<DocumentRecord, DomainError>> {
  const big = tooLarge(store, input.content);
  if (big) return fail(big);
  const doc = await guarded(store, input.content, () => store.insertDocument(input));
  return isTooLarge(doc) ? fail(doc.tooLarge) : { ok: true, value: doc };
}

/** Resolves and validates the request against the current version without writing anything. */
export async function preview(store: Store, id: string, req: ChangeRequest): Promise<Result<{ doc: DocumentRecord; result: EditResult }, DomainError>> {
  const doc = await store.getDocument(id);
  if (!doc) return fail({ type: "DOCUMENT_NOT_FOUND", id });
  const pre = checkPreconditions(doc, req);
  if (pre) return fail(pre);
  const edit = applyChanges(doc.content, req.changes);
  if (!edit.ok) return edit;
  return { ok: true, value: { doc, result: edit.value } };
}

/**
 * Like `preview`, but an EMPTY change list means "no edit": the result is the current text, unchanged. Used only by
 * CLAUSE CI to audit a document against its requirements without proposing anything. The engine itself still rejects
 * an empty batch (EMPTY_BATCH), and PATCH / preview never call this.
 */
export async function previewOrCurrent(store: Store, id: string, req: ChangeRequest): Promise<Result<{ doc: DocumentRecord; result: EditResult }, DomainError>> {
  if (req.changes.length > 0) return preview(store, id, req);
  const doc = await store.getDocument(id);
  if (!doc) return fail({ type: "DOCUMENT_NOT_FOUND", id });
  const pre = checkPreconditions(doc, req);
  if (pre) return fail(pre);
  return { ok: true, value: { doc, result: { content: doc.content, changed: false, applied: [] } } };
}

/**
 * Apply = preview + compare-and-swap commit. The same engine call decides what
 * would change, so a successful preview and the commit cannot disagree. If a
 * writer sneaks in between our read and our commit, the CAS fails and we report
 * a conflict instead of applying positions resolved against stale text.
 */
export async function apply(store: Store, id: string, req: ChangeRequest): Promise<Result<Receipt, DomainError>> {
  const p = await preview(store, id, req);
  if (!p.ok) return p;
  const { doc, result } = p.value;
  if (doc.sample) return fail({ type: "SAMPLE_READ_ONLY", id });

  if (!result.changed) {
    return {
      ok: true,
      value: { id, title: doc.title, content: doc.content, previousVersion: doc.version, version: doc.version, changed: false, beforeHash: doc.contentHash, afterHash: doc.contentHash, applied: result.applied },
    };
  }

  const big = tooLarge(store, result.content);
  if (big) return fail(big);

  const committed = await guarded(store, result.content, () => store.commitRevision({ id, expectedVersion: doc.version, content: result.content, summary: summarize(result.applied) }));
  if (isTooLarge(committed)) return fail(committed.tooLarge);
  if (committed === "conflict") return conflictFor(store, id, doc, req.ifMatch);
  return {
    ok: true,
    value: { id, title: committed.title, content: committed.content, previousVersion: doc.version, version: committed.version, changed: true, beforeHash: doc.contentHash, afterHash: committed.contentHash, applied: result.applied },
  };
}

export interface RevertRequest {
  /** The old version whose text should become current again. */
  toVersion: number;
  expectedVersion?: number | undefined;
  ifMatch?: string | undefined;
}

/**
 * Undo = restore an old version's text as a NEW version. History is never rewritten or deleted: after reverting
 * v5 back to v2 you have v1..v6, where v6 has the same text as v2. It uses the same preconditions and the same
 * compare-and-swap commit as an ordinary edit, so a revert can't overwrite someone else's newer change either.
 */
export async function revert(store: Store, id: string, req: RevertRequest): Promise<Result<Receipt, DomainError>> {
  const doc = await store.getDocument(id);
  if (!doc) return fail({ type: "DOCUMENT_NOT_FOUND", id });
  if (doc.sample) return fail({ type: "SAMPLE_READ_ONLY", id });
  const pre = checkPreconditions(doc, req);
  if (pre) return fail(pre);
  const target = await store.getRevision(id, req.toVersion);
  if (!target) return fail({ type: "REVISION_NOT_FOUND", id, version: req.toVersion });

  // Same no-op policy as edits: restoring the text that is already current creates no new version.
  if (target.content === doc.content) {
    return { ok: true, value: { id, title: doc.title, content: doc.content, previousVersion: doc.version, version: doc.version, changed: false, beforeHash: doc.contentHash, afterHash: doc.contentHash, applied: [], revertedTo: req.toVersion } };
  }

  const big = tooLarge(store, target.content);
  if (big) return fail(big);

  const committed = await guarded(store, target.content, () => store.commitRevision({ id, expectedVersion: doc.version, content: target.content, summary: JSON.stringify([{ revertedTo: req.toVersion }]) }));
  if (isTooLarge(committed)) return fail(committed.tooLarge);
  if (committed === "conflict") return conflictFor(store, id, doc, req.ifMatch);
  return { ok: true, value: { id, title: committed.title, content: committed.content, previousVersion: doc.version, version: committed.version, changed: true, beforeHash: doc.contentHash, afterHash: committed.contentHash, applied: [], revertedTo: req.toVersion } };
}
