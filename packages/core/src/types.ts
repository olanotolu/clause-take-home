/**
 * Offsets everywhere in CLAUSE are UTF-16 code units (what JS `string.length`,
 * `slice` and `indexOf` use), half-open: [start, end). They are NOT code points,
 * grapheme clusters or UTF-8 bytes. A span that starts or ends between the two
 * halves of a surrogate pair is rejected rather than silently corrupting text.
 */

/** W3C TextQuoteSelector-inspired. Literal, case-sensitive; never a regex. */
export interface QuoteSelector {
  exact: string;
  prefix?: string | undefined;
  suffix?: string | undefined;
  /** 1-based, counted among matches that satisfy prefix/suffix. */
  occurrence?: number | undefined;
}

/** W3C TextPositionSelector-inspired. `expectedText` is mandatory: no blind writes. */
export interface PositionSelector {
  start: number;
  end: number;
  expectedText: string;
}

export type Target = { quote: QuoteSelector } | { position: PositionSelector };

/**
 * Delete = replacement "". Insert = position selector with start === end
 * (and expectedText "").
 */
export interface Change {
  operation: "replace";
  target: Target;
  replacement: string;
}

export interface Candidate {
  start: number;
  end: number;
  /** A little surrounding text so a client can pick one and retry. */
  context: string;
}

export type EditError =
  | { type: "EMPTY_BATCH" }
  | { type: "EMPTY_TARGET"; index: number }
  | { type: "TARGET_NOT_FOUND"; index: number; exact: string; exactMatchCount: number }
  | { type: "AMBIGUOUS_TARGET"; index: number; matchCount: number; candidates: Candidate[] }
  | { type: "OCCURRENCE_OUT_OF_RANGE"; index: number; occurrence: number; matchCount: number }
  | { type: "INVALID_RANGE"; index: number; reason: string }
  | { type: "TEXT_MISMATCH"; index: number; expected: string; actual: string }
  | { type: "SPLIT_SURROGATE"; index: number; offset: number }
  | { type: "OVERLAPPING_CHANGES"; indices: [number, number] }
  | { type: "AMBIGUOUS_INSERT_ORDER"; indices: [number, number]; offset: number };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** A change after resolution against the snapshot: where it lands, nothing else. */
export interface ResolvedSpan {
  /** Position of the change in the request. */
  index: number;
  start: number;
  end: number;
  replacement: string;
}

export interface AppliedChange {
  index: number;
  /** Offsets in the ORIGINAL (snapshot) text. */
  start: number;
  end: number;
  before: string;
  after: string;
  /** Offsets of `after` in the NEW text. */
  newStart: number;
  newEnd: number;
}

export interface EditResult {
  content: string;
  /** Ordered by position in the document. */
  applied: AppliedChange[];
  /** False when every replacement equals the text it replaces. */
  changed: boolean;
}
