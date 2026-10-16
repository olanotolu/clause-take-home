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

interface Matches {
  candidates: Candidate[];
  matchCount: number;
  exactMatchCount: number;
  chosen: { start: number; end: number } | undefined;
}

/**
 * Per-selector state while matches stream in, left to right. Shared by both search strategies below, so the rules
 * (non-overlapping raw matches, then the prefix/suffix filter, then counting and the candidate cap) live in one place.
 */
class MatchState implements Matches {
  candidates: Candidate[] = [];
  matchCount = 0;
  exactMatchCount = 0;
  chosen: { start: number; end: number } | undefined;
  private lastEnd = 0;
  private readonly text: string;
  private readonly sel: QuoteSelector;

  constructor(text: string, sel: QuoteSelector) {
    this.text = text;
    this.sel = sel;
  }

  /** True once the request's occurrence has been found: later matches cannot change the result. */
  get done(): boolean {
    return this.chosen !== undefined;
  }

  /** A raw match of `exact` at [start, end). Matches must arrive in increasing start order. */
  offer(start: number, end: number): void {
    // Overlapping raw matches ("aa" in "aaa") are not enumerated: the next one must start at or after the last end.
    if (this.done || start < this.lastEnd) return;
    this.lastEnd = end;
    this.exactMatchCount++;
    const { prefix = "", suffix = "", occurrence } = this.sel;
    if (prefix && !(start >= prefix.length && this.text.startsWith(prefix, start - prefix.length))) return;
    if (suffix && !this.text.startsWith(suffix, end)) return;
    this.matchCount++;
    if (this.candidates.length < MAX_CANDIDATES) {
      this.candidates.push({ start, end, context: contextAround(this.text, start, end) });
    }
    if (occurrence !== undefined && this.matchCount === occurrence) this.chosen = { start, end };
  }
}

/**
 * One selector: walks literal matches left to right with indexOf (V8's string search is very fast for a single
 * needle). Cost: one pass, O(n); allocation is bounded by MAX_CANDIDATES, not by the match count.
 */
export function findMatches(text: string, sel: QuoteSelector): Matches {
  const state = new MatchState(text, sel);
  for (let from = 0; !state.done; ) {
    const start = text.indexOf(sel.exact, from);
    if (start === -1) break;
    state.offer(start, start + sel.exact.length);
    from = start + sel.exact.length; // no need to look for overlapping matches: offer() would skip them anyway
  }
  return state;
}

/**
 * At or above this many quote targets, one automaton pass beats one indexOf scan per target. Measured on 10 MiB with
 * targets spread through the document: 16 targets 39 vs 59 ms, 32 targets 74 vs 56 ms (indexOf vs automaton).
 */
export const MULTI_PATTERN_MIN = 24;

/**
 * Many selectors at once: an Aho-Corasick automaton over every distinct `exact` string finds all of their matches in a
 * single left-to-right pass, O(n + total pattern length + matches), instead of one O(n) scan per selector. Results are
 * identical to calling findMatches for each selector (property-tested), because matches of any one pattern are
 * reported in increasing start order, which is the order MatchState requires.
 *
 * Root transitions use a dense table (one entry per UTF-16 code unit) because almost every character of a contract
 * either starts no pattern or restarts at the root; deeper transitions are sparse, in one Map keyed by node and unit.
 */
export function findMatchesMany(text: string, selectors: readonly QuoteSelector[]): Matches[] {
  const states = selectors.map((sel) => new MatchState(text, sel));
  const root = new Int32Array(65536);
  const next = new Map<number, number>();
  const fail: number[] = [0];
  const out: number[][] = [[]]; // pattern ids that end exactly at each node
  const link: number[] = [0]; // nearest proper suffix node that ends a pattern (0 = none)
  const patterns: { length: number; states: MatchState[] }[] = [];
  const idOf = new Map<string, number>();
  const step = (node: number, unit: number) => (node === 0 ? root[unit]! : (next.get(node * 65536 + unit) ?? 0));

  // Build the trie over distinct exact strings; several selectors may share one.
  selectors.forEach((sel, i) => {
    let id = idOf.get(sel.exact);
    if (id === undefined) {
      id = patterns.length;
      idOf.set(sel.exact, id);
      patterns.push({ length: sel.exact.length, states: [] });
      let node = 0;
      for (let k = 0; k < sel.exact.length; k++) {
        const unit = sel.exact.charCodeAt(k);
        let child = step(node, unit);
        if (child === 0) {
          child = fail.length;
          fail.push(0);
          out.push([]);
          link.push(0);
          if (node === 0) root[unit] = child;
          else next.set(node * 65536 + unit, child);
        }
        node = child;
      }
      out[node]!.push(id);
    }
    patterns[id]!.states.push(states[i]!);
  });

  // Failure links, breadth first: the longest proper suffix of each node that is also a trie path.
  const queue: number[] = [];
  for (let unit = 0; unit < 65536; unit++) if (root[unit]) queue.push(root[unit]!);
  const children = new Map<number, [number, number][]>();
  for (const [key, child] of next) {
    const parent = Math.floor(key / 65536);
    const list = children.get(parent);
    if (list) list.push([key % 65536, child]);
    else children.set(parent, [[key % 65536, child]]);
  }
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    for (const [unit, child] of children.get(node) ?? []) {
      let f = fail[node]!;
      while (f !== 0 && step(f, unit) === 0) f = fail[f]!;
      const target = step(f, unit);
      fail[child] = target !== child ? target : 0;
      link[child] = out[fail[child]!]!.length > 0 ? fail[child]! : link[fail[child]!]!;
      queue.push(child);
    }
  }

  // One pass over the text.
  let node = 0;
  for (let pos = 0; pos < text.length; pos++) {
    const unit = text.charCodeAt(pos);
    let to = step(node, unit);
    while (to === 0 && node !== 0) {
      node = fail[node]!;
      to = step(node, unit);
    }
    node = to;
    for (let hit = out[node]!.length > 0 ? node : link[node]!; hit !== 0; hit = link[hit]!) {
      for (const id of out[hit]!) {
        const { length, states: owners } = patterns[id]!;
        for (const state of owners) state.offer(pos + 1 - length, pos + 1);
      }
    }
  }
  return states;
}

function resolveOne(text: string, change: Change, index: number, found?: Matches): Result<ResolvedSpan, EditError> {
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

  const { candidates, matchCount, exactMatchCount, chosen } = found ?? findMatches(text, sel);

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
 * Reports the first invalid change in request order.
 *
 * Batches with many quote targets are matched in one automaton pass (findMatchesMany); small ones use one indexOf scan
 * per target, which is faster below MULTI_PATTERN_MIN. Either way the answer is the same.
 */
export function resolveChanges(text: string, changes: readonly Change[]): Result<ResolvedSpan[], EditError> {
  if (changes.length === 0) return fail({ type: "EMPTY_BATCH" });
  const quoted: number[] = [];
  changes.forEach((c, i) => {
    if ("quote" in c.target && c.target.quote.exact.length > 0) quoted.push(i);
  });
  const found = new Map<number, Matches>();
  if (quoted.length >= MULTI_PATTERN_MIN) {
    const results = findMatchesMany(text, quoted.map((i) => (changes[i]!.target as { quote: QuoteSelector }).quote));
    for (let k = 0; k < quoted.length; k++) found.set(quoted[k]!, results[k]!);
  }
  const spans: ResolvedSpan[] = [];
  for (let i = 0; i < changes.length; i++) {
    const r = resolveOne(text, changes[i]!, i, found.get(i));
    if (!r.ok) return r;
    spans.push(r.value);
  }
  return ok(spans);
}
