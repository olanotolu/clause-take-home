import type { EditError } from "@clause/core";

/** Everything a client can be told went wrong with a well-formed request. */
export type DomainError =
  | EditError
  | { type: "DOCUMENT_NOT_FOUND"; id: string }
  | { type: "REVISION_NOT_FOUND"; id: string; version: number }
  | { type: "INVALID_VERSION_RANGE"; from: number; to: number }
  | { type: "TOO_LARGE_TO_EXPORT"; chars: number; max: number }
  | { type: "TOO_LARGE_FOR_BACKEND"; chars: number; max: number }
  | { type: "VERSION_CONFLICT"; expectedVersion: number; currentVersion: number }
  | { type: "PRECONDITION_FAILED"; expected: string; current: string }
  | { type: "CONTRADICTORY_PRECONDITIONS"; ifMatchVersion: number; expectedVersion: number }
  | { type: "INVALID_PRECONDITION"; header: string };

export interface HttpError {
  status: number;
  error: string;
  type: string;
  details?: Record<string, unknown>;
}

/**
 * 409 = the request is fine but the document's current state conflicts with it
 *       (stale version, ambiguity, text moved). Re-read and retry.
 * 412 = an If-Match precondition failed.
 * 422 = the request can never succeed as written (bad range, overlap, missing target).
 */
export function toHttp(e: DomainError): HttpError {
  switch (e.type) {
    case "DOCUMENT_NOT_FOUND":
      return { status: 404, type: e.type, error: `Document ${e.id} not found` };
    case "REVISION_NOT_FOUND":
      return { status: 404, type: e.type, error: `Document ${e.id} has no version ${e.version}`, details: { version: e.version } };
    case "INVALID_VERSION_RANGE":
      return { status: 422, type: e.type, error: `from (v${e.from}) must be lower than to (v${e.to})`, details: { from: e.from, to: e.to } };
    case "TOO_LARGE_TO_EXPORT":
      return { status: 413, type: e.type, error: `Those versions are ${e.chars} characters; redline export is limited to ${e.max} per version`, details: { chars: e.chars, max: e.max } };
    case "TOO_LARGE_FOR_BACKEND":
      return { status: 413, type: e.type, error: `This deployment indexes documents up to ${e.max} characters; this one is ${e.chars}`, details: { chars: e.chars, max: e.max } };
    case "VERSION_CONFLICT":
      return {
        status: 409,
        type: e.type,
        error: `Document is at version ${e.currentVersion}, request expected ${e.expectedVersion}`,
        details: { expectedVersion: e.expectedVersion, currentVersion: e.currentVersion },
      };
    case "PRECONDITION_FAILED":
      return { status: 412, type: e.type, error: "If-Match does not match the current document", details: { current: e.current } };
    case "CONTRADICTORY_PRECONDITIONS":
      return { status: 400, type: e.type, error: "If-Match and expectedVersion refer to different versions", details: { ...e } };
    case "INVALID_PRECONDITION":
      return { status: 400, type: e.type, error: `Malformed ${e.header} header` };
    case "AMBIGUOUS_TARGET":
      return {
        status: 409,
        type: e.type,
        error: `Target text matches ${e.matchCount} passages; add an occurrence, prefix or suffix`,
        details: { index: e.index, matchCount: e.matchCount, candidates: e.candidates },
      };
    case "TEXT_MISMATCH":
      return { status: 409, type: e.type, error: "Text at the given range differs from expectedText", details: { index: e.index, expected: e.expected, actual: e.actual } };
    case "TARGET_NOT_FOUND":
      return { status: 422, type: e.type, error: "Target text not found", details: { index: e.index, exactMatchCount: e.exactMatchCount } };
    case "OCCURRENCE_OUT_OF_RANGE":
      return { status: 422, type: e.type, error: `Occurrence ${e.occurrence} requested but only ${e.matchCount} match`, details: { index: e.index, matchCount: e.matchCount } };
    case "EMPTY_BATCH":
      return { status: 422, type: e.type, error: "changes must contain at least one change" };
    case "EMPTY_TARGET":
      return { status: 422, type: e.type, error: "Target text must not be empty", details: { index: e.index } };
    case "INVALID_RANGE":
      return { status: 422, type: e.type, error: e.reason, details: { index: e.index } };
    case "SPLIT_SURROGATE":
      return { status: 422, type: e.type, error: "Offset falls inside a surrogate pair (UTF-16)", details: { index: e.index, offset: e.offset } };
    case "OVERLAPPING_CHANGES":
      return { status: 422, type: e.type, error: "Changes overlap", details: { indices: e.indices } };
    case "AMBIGUOUS_INSERT_ORDER":
      return { status: 422, type: e.type, error: "Two insertions at the same offset have no defined order", details: { indices: e.indices, offset: e.offset } };
  }
}
