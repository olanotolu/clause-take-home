import type { AppliedChange } from "./types.ts";

/**
 * Deterministic requirement checks. These need no model: they are exact statements about text, so they are decided by
 * the same literal, case-sensitive, non-overlapping matching rule the edit engine uses for quote targets.
 */
export interface Span {
  start: number;
  end: number;
}

const MAX_SPANS = 10;

/** Every non-overlapping occurrence of `needle` (up to `max`), left to right. Empty needle matches nothing. */
export function findAll(text: string, needle: string, max = MAX_SPANS): Span[] {
  const spans: Span[] = [];
  if (needle.length === 0) return spans;
  for (let at = text.indexOf(needle); at !== -1 && spans.length < max; at = text.indexOf(needle, at + needle.length)) {
    spans.push({ start: at, end: at + needle.length });
  }
  return spans;
}

export interface TextCheck {
  passed: boolean;
  /** Where the text was found: the evidence for `present`, or the offending places for a failed `absent`. */
  spans: Span[];
}

/** "The document must contain `needle`." */
export function checkPresent(text: string, needle: string): TextCheck {
  const spans = findAll(text, needle);
  return { passed: spans.length > 0, spans };
}

/** "The document must NOT contain `needle`." */
export function checkAbsent(text: string, needle: string): TextCheck {
  const spans = findAll(text, needle);
  return { passed: spans.length === 0, spans };
}

export interface UnchangedCheck {
  /** The passage exists in the current text at all (otherwise the requirement is vacuous, and fails before any edit). */
  presentBefore: boolean;
  presentAfter: boolean;
  /** Where the passage sits in the CURRENT (before) text. */
  beforeSpans: Span[];
  /** Where it sits in the PROPOSED (after) text. */
  afterSpans: Span[];
  /** Indices (request order) of the applied changes that overlap the passage in the current text. */
  touchedBy: number[];
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/**
 * "This passage must survive the edit verbatim." Besides checking both texts, it reports WHICH applied changes touched
 * the passage, which the engine knows exactly (an applied span overlapping the passage), so a failure can name its
 * cause instead of just saying "it's gone".
 *
 * Invariant (property-tested): if no applied change overlaps an occurrence, that occurrence is byte-identical in the
 * new text at its shifted offset.
 */
export function analyzeUnchanged(before: string, after: string, passage: string, applied: readonly AppliedChange[]): UnchangedCheck {
  const beforeSpans = findAll(before, passage);
  const afterSpans = findAll(after, passage);
  const touchedBy = [...new Set(applied.filter((a) => beforeSpans.some((s) => overlaps(s, { start: a.start, end: a.end }))).map((a) => a.index))].sort((x, y) => x - y);
  return { presentBefore: beforeSpans.length > 0, presentAfter: afterSpans.length > 0, beforeSpans, afterSpans, touchedBy };
}

/** Offset of an untouched position in the old text, mapped into the new text (shifted by every earlier applied change). */
export function shiftedOffset(offset: number, applied: readonly AppliedChange[]): number {
  let delta = 0;
  for (const a of applied) {
    if (a.end <= offset) delta += a.after.length - (a.end - a.start);
  }
  return offset + delta;
}
