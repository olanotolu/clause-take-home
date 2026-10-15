import { resolveChanges } from "./resolve.ts";
import type { AppliedChange, Change, EditError, EditResult, ResolvedSpan, Result } from "./types.ts";

/**
 * Sorts spans and rejects any that collide. Adjacent spans ([0,3) and [3,5))
 * are fine. Two zero-length inserts at one offset are rejected because their
 * relative order would be arbitrary. An insert at the start of a replaced span
 * is allowed and lands before it (the sort puts the shorter span first).
 */
export function orderSpans(spans: readonly ResolvedSpan[]): Result<ResolvedSpan[], EditError> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    const indices: [number, number] = [prev.index, next.index];
    if (prev.start === prev.end && next.start === next.end && prev.start === next.start) {
      return { ok: false, error: { type: "AMBIGUOUS_INSERT_ORDER", indices, offset: prev.start } };
    }
    if (next.start < prev.end) return { ok: false, error: { type: "OVERLAPPING_CHANGES", indices } };
  }
  return { ok: true, value: sorted };
}

/**
 * Builds the new text in one forward pass from untouched slices plus
 * replacements. `ordered` must come from `orderSpans`.
 * Cost: O(n + r) for n = original length, r = total replacement length.
 */
export function applyOrderedSpans(text: string, ordered: readonly ResolvedSpan[]): EditResult {
  const parts: string[] = [];
  const applied: AppliedChange[] = [];
  let cursor = 0;
  let delta = 0;
  let changed = false;

  for (const s of ordered) {
    parts.push(text.slice(cursor, s.start), s.replacement);
    const before = text.slice(s.start, s.end);
    if (before !== s.replacement) changed = true;
    const newStart = s.start + delta;
    applied.push({
      index: s.index,
      start: s.start,
      end: s.end,
      before,
      after: s.replacement,
      newStart,
      newEnd: newStart + s.replacement.length,
    });
    delta += s.replacement.length - (s.end - s.start);
    cursor = s.end;
  }
  parts.push(text.slice(cursor));
  return { content: parts.join(""), applied, changed };
}

/**
 * The whole pipeline: resolve (against one snapshot) -> order/validate ->
 * rebuild. Pure and total for user errors: it returns a typed error instead of
 * throwing, and never touches its inputs. Preview, commit and AI suggestions
 * all go through here.
 *
 * Complexity: resolving costs one scan of the text per quote target
 * (O(k * n) worst case, not linear in n overall); ordering is O(k log k);
 * rebuilding is O(n + r).
 */
export function applyChanges(text: string, changes: readonly Change[]): Result<EditResult, EditError> {
  const resolved = resolveChanges(text, changes);
  if (!resolved.ok) return resolved;
  const ordered = orderSpans(resolved.value);
  if (!ordered.ok) return ordered;
  return { ok: true, value: applyOrderedSpans(text, ordered.value) };
}
