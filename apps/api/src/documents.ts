import { applyChanges, type AppliedChange, type Change, type EditResult, type Result } from "@clause/core";
import type { Db } from "./db.ts";
import type { DomainError } from "./errors.ts";
import * as repo from "./repo.ts";
import type { DocumentRecord } from "./repo.ts";

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

export function createDocument(db: Db, input: { title: string; content: string }): DocumentRecord {
  return repo.insertDocument(db, input);
}

/** Resolves and validates the request against the current version without writing anything. */
export function preview(db: Db, id: string, req: ChangeRequest): Result<{ doc: DocumentRecord; result: EditResult }, DomainError> {
  const doc = repo.getDocument(db, id);
  if (!doc) return fail({ type: "DOCUMENT_NOT_FOUND", id });
  const pre = checkPreconditions(doc, req);
  if (pre) return fail(pre);
  const edit = applyChanges(doc.content, req.changes);
  if (!edit.ok) return edit;
  return { ok: true, value: { doc, result: edit.value } };
}

/**
 * Apply = preview + compare-and-swap commit. The same engine call decides what
 * would change, so a successful preview and the commit cannot disagree. If a
 * writer sneaks in between our read and our commit, the CAS fails and we report
 * a conflict instead of applying positions resolved against stale text.
 */
export function apply(db: Db, id: string, req: ChangeRequest): Result<Receipt, DomainError> {
  const p = preview(db, id, req);
  if (!p.ok) return p;
  const { doc, result } = p.value;

  if (!result.changed) {
    return {
      ok: true,
      value: { id, title: doc.title, content: doc.content, previousVersion: doc.version, version: doc.version, changed: false, beforeHash: doc.contentHash, afterHash: doc.contentHash, applied: result.applied },
    };
  }

  const committed = repo.commitRevision(db, { id, expectedVersion: doc.version, content: result.content, summary: repo.summarize(result.applied) });
  if (committed === "conflict") {
    const current = repo.getDocument(db, id);
    if (!current) return fail({ type: "DOCUMENT_NOT_FOUND", id });
    return fail(
      req.ifMatch !== undefined
        ? { type: "PRECONDITION_FAILED", expected: req.ifMatch, current: etagOf(current) }
        : { type: "VERSION_CONFLICT", expectedVersion: doc.version, currentVersion: current.version },
    );
  }
  return {
    ok: true,
    value: {
      id,
      title: committed.title,
      content: committed.content,
      previousVersion: doc.version,
      version: committed.version,
      changed: true,
      beforeHash: doc.contentHash,
      afterHash: committed.contentHash,
      applied: result.applied,
    },
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
export function revert(db: Db, id: string, req: RevertRequest): Result<Receipt, DomainError> {
  const doc = repo.getDocument(db, id);
  if (!doc) return fail({ type: "DOCUMENT_NOT_FOUND", id });
  const pre = checkPreconditions(doc, req);
  if (pre) return fail(pre);
  const target = repo.getRevision(db, id, req.toVersion);
  if (!target) return fail({ type: "REVISION_NOT_FOUND", id, version: req.toVersion });

  // Same no-op policy as edits: restoring the text that is already current creates no new version.
  if (target.content === doc.content) {
    return { ok: true, value: { id, title: doc.title, content: doc.content, previousVersion: doc.version, version: doc.version, changed: false, beforeHash: doc.contentHash, afterHash: doc.contentHash, applied: [], revertedTo: req.toVersion } };
  }

  const committed = repo.commitRevision(db, { id, expectedVersion: doc.version, content: target.content, summary: JSON.stringify([{ revertedTo: req.toVersion }]) });
  if (committed === "conflict") {
    const current = repo.getDocument(db, id);
    if (!current) return fail({ type: "DOCUMENT_NOT_FOUND", id });
    return fail(
      req.ifMatch !== undefined
        ? { type: "PRECONDITION_FAILED", expected: req.ifMatch, current: etagOf(current) }
        : { type: "VERSION_CONFLICT", expectedVersion: doc.version, currentVersion: current.version },
    );
  }
  return { ok: true, value: { id, title: committed.title, content: committed.content, previousVersion: doc.version, version: committed.version, changed: true, beforeHash: doc.contentHash, afterHash: committed.contentHash, applied: [], revertedTo: req.toVersion } };
}
