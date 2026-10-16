import { analyzeUnchanged, checkAbsent, checkPresent, type AppliedChange, type Span } from "@clause/core";
import type { RequirementKind } from "../store/types.ts";
import type { Check, EvidenceSpan } from "./types.ts";

const evidence = (text: string, spans: readonly Span[]): EvidenceSpan[] => spans.map((s) => ({ ...s, quote: text.slice(s.start, s.end), verified: true }));
const places = (n: number) => `${n} place${n === 1 ? "" : "s"}`;
const names = (idx: number[]) => idx.map((i) => `#${i + 1}`).join(", ");

/** Kinds that need no model. `semantic` is handled by judges. */
export type DeterministicKind = Exclude<RequirementKind, "semantic">;

/**
 * Runs an exact requirement on the current text and on the proposed text. All of this is decided by literal matching:
 * no probability, no model, nothing to calibrate.
 */
export function evaluateDeterministic(
  kind: DeterministicKind,
  needle: string,
  before: string,
  after: string,
  applied: readonly AppliedChange[],
): { before: Check; after: Check; touchedBy: number[] } {
  if (kind === "present") {
    const b = checkPresent(before, needle);
    const a = checkPresent(after, needle);
    return {
      before: { verdict: b.passed ? "PASS" : "FAIL", detail: b.passed ? `Found in ${places(b.spans.length)}.` : "Not found in the current version.", evidence: evidence(before, b.spans) },
      after: { verdict: a.passed ? "PASS" : "FAIL", detail: a.passed ? `Found in ${places(a.spans.length)}.` : "Not found in the proposed text.", evidence: evidence(after, a.spans) },
      touchedBy: [],
    };
  }

  if (kind === "absent") {
    const b = checkAbsent(before, needle);
    const a = checkAbsent(after, needle);
    return {
      before: { verdict: b.passed ? "PASS" : "FAIL", detail: b.passed ? "Not present." : `Present in ${places(b.spans.length)}.`, evidence: evidence(before, b.spans) },
      after: { verdict: a.passed ? "PASS" : "FAIL", detail: a.passed ? "Not present." : `Present in ${places(a.spans.length)}.`, evidence: evidence(after, a.spans) },
      touchedBy: [],
    };
  }

  // unchanged: the passage must exist now AND survive verbatim; a failure names the change that altered it.
  const u = analyzeUnchanged(before, after, needle, applied);
  const beforeCheck: Check = u.presentBefore
    ? { verdict: "PASS", detail: `Passage found in ${places(u.beforeSpans.length)}.`, evidence: evidence(before, u.beforeSpans) }
    : { verdict: "FAIL", detail: "This passage is not in the current version, so there is nothing to preserve.", evidence: [] };
  const afterCheck: Check = u.presentAfter
    ? { verdict: "PASS", detail: "Passage is still present, word for word.", evidence: evidence(after, u.afterSpans) }
    : {
        verdict: "FAIL",
        detail: u.touchedBy.length ? `Passage was altered or removed by change ${names(u.touchedBy)}.` : "Passage is no longer present in the proposed text.",
        evidence: [],
      };
  return { before: beforeCheck, after: afterCheck, touchedBy: u.touchedBy };
}
