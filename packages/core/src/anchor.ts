import { resolveChanges } from "./resolve.ts";
import type { Target } from "./types.ts";

/** Context lengths to try, shortest first. Short anchors survive unrelated edits better. */
const CONTEXT_STEPS = [0, 16, 48, 128];

/**
 * Builds a selector for [start, end) of `text`, guaranteed to resolve back to
 * exactly that span against this snapshot. Prefers a quote selector with the
 * least context that is unambiguous; if none resolves (e.g. "aa" at offset 1
 * of "aaaa", which a non-overlapping scan can never produce), falls back to a
 * position selector. The guarantee is verified through the real resolver, not
 * assumed.
 */
export function selectorFor(text: string, start: number, end: number): Target {
  const exact = text.slice(start, end);
  if (exact.length > 0) {
    for (const len of CONTEXT_STEPS) {
      const prefix = text.slice(Math.max(0, start - len), start);
      const suffix = text.slice(end, end + len);
      const quote = { exact, ...(prefix && { prefix }), ...(suffix && { suffix }) };
      const r = resolveChanges(text, [{ operation: "replace", target: { quote }, replacement: "" }]);
      if (r.ok && r.value[0]!.start === start && r.value[0]!.end === end) return { quote };
    }
  }
  return { position: { start, end, expectedText: exact } };
}
