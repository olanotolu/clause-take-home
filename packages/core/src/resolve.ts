import type { Candidate, Change, EditError, QuoteSelector, ResolvedSpan, Result } from "./types.ts";

const MAX_CANDIDATES = 10;
const CONTEXT_CHARS = 24;

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = (error: EditError): Result<never, EditError> => ({ ok: false, error });

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** True when `offset` sits between the two halves of a surrogate pair. */
export function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  return isHigh(text.charCodeAt(offset - 1)) && isLow(text.charCodeAt(offset));
}

function contextAround(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - CONTEXT_CHARS), Math.min(text.length, end + CONTEXT_CHARS));
}

/**
 * Walks non-overlapping literal matches of `sel.exact` left to right, keeping
 * those whose surrounding text equals prefix/suffix. Overlapping raw matches
 * ("aa" in "aaa") are intentionally not enumerated.
 *
 * Cost: one pass, O(n) for V8's indexOf on typical text; no regex, no
 * allocation proportional to the match count (only MAX_CANDIDATES are kept).
 */
function findMatches(text: string, sel: QuoteSelector) {
  const { exact, prefix = "", suffix = "", occurrence } = sel;
  const candidates: Candidate[] = [];
  let matchCount = 0;
  let exactMatchCount = 0;
  let chosen: { start: number; end: number } | undefined;

  let from = 0;
  for (;;) {
    const start = text.indexOf(exact, from);
    if (start === -1) break;
    const end = start + exact.length;
    from = end;
    exactMatchCount++;
    if (prefix && !(start >= prefix.length && text.startsWith(prefix, start - prefix.length))) continue;
    if (suffix && !text.startsWith(suffix, end)) continue;
    matchCount++;
    if (candidates.length < MAX_CANDIDATES) {
      candidates.push({ start, end, context: contextAround(text, start, end) });
    }
    if (occurrence !== undefined && matchCount === occurrence) {
      chosen = { start, end };
      break; // no need to count the rest: the request named its target
    }
  }
  return { candidates, matchCount, exactMatchCount, chosen };
}

function resolveOne(text: string, change: Change, index: number): Result<ResolvedSpan, EditError> {
  const { target, replacement } = change;

  if ("position" in target) {
    const { start, end, expectedText } = target.position;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return fail({ type: "INVALID_RANGE", index, reason: "start and end must be integers" });
    }
    if (start < 0) return fail({ type: "INVALID_RANGE", index, reason: "start must be >= 0" });
    if (end < start) return fail({ type: "INVALID_RANGE", index, reason: "end must be >= start" });
    if (end > text.length) {
      return fail({ type: "INVALID_RANGE", index, reason: `end ${end} is beyond document length ${text.length}` });
    }
    for (const offset of [start, end]) {
      if (splitsSurrogate(text, offset)) return fail({ type: "SPLIT_SURROGATE", index, offset });
    }
    const actual = text.slice(start, end);
    if (actual !== expectedText) return fail({ type: "TEXT_MISMATCH", index, expected: expectedText, actual });
    return ok({ index, start, end, replacement });
  }

  const sel = target.quote;
  if (sel.exact.length === 0) return fail({ type: "EMPTY_TARGET", index });
  if (sel.occurrence !== undefined && (!Number.isInteger(sel.occurrence) || sel.occurrence < 1)) {
    return fail({ type: "INVALID_RANGE", index, reason: "occurrence must be an integer >= 1" });
  }

  const { candidates, matchCount, exactMatchCount, chosen } = findMatches(text, sel);

  if (sel.occurrence !== undefined) {
    if (!chosen) {
      return matchCount === 0
        ? fail({ type: "TARGET_NOT_FOUND", index, exact: sel.exact, exactMatchCount })
        : fail({ type: "OCCURRENCE_OUT_OF_RANGE", index, occurrence: sel.occurrence, matchCount });
    }
    return ok({ index, ...chosen, replacement });
  }

  if (matchCount === 0) return fail({ type: "TARGET_NOT_FOUND", index, exact: sel.exact, exactMatchCount });
  if (matchCount > 1) return fail({ type: "AMBIGUOUS_TARGET", index, matchCount, candidates });
  const only = candidates[0]!;
  return ok({ index, start: only.start, end: only.end, replacement });
}

/**
 * Resolve every change against the SAME snapshot. Nothing is applied here, so
 * a later change can never be interpreted against text an earlier one altered.
 * Fails fast on the first invalid change.
 */
export function resolveChanges(text: string, changes: readonly Change[]): Result<ResolvedSpan[], EditError> {
  if (changes.length === 0) return fail({ type: "EMPTY_BATCH" });
  const spans: ResolvedSpan[] = [];
  for (let i = 0; i < changes.length; i++) {
    const r = resolveOne(text, changes[i]!, i);
    if (!r.ok) return r;
    spans.push(r.value);
  }
  return ok(spans);
}
