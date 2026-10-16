import type { CiSummary, Delta, Verdict } from "./types.ts";

/**
 * How the edit moved a requirement. Uncertainty is never rounded into a pass or a fail: if either side is NEEDS_REVIEW
 * or UNAVAILABLE the honest answer is "uncertain".
 *
 * A goal ("make confidentiality mutual") is expected to become true because of the edit; a standing requirement is
 * expected to stay true. Both use the same table, only the wording of a good outcome differs.
 */
export function deltaOf(before: Verdict, after: Verdict): Delta {
  if (before === "NEEDS_REVIEW" || before === "UNAVAILABLE" || after === "NEEDS_REVIEW" || after === "UNAVAILABLE") return "uncertain";
  if (before === "PASS" && after === "PASS") return "held";
  if (before === "PASS" && after === "FAIL") return "regressed";
  if (before === "FAIL" && after === "PASS") return "achieved";
  return "still_failing";
}

export function summarize(deltas: readonly Delta[]): CiSummary {
  const s: CiSummary = { held: 0, regressed: 0, achieved: 0, still_failing: 0, uncertain: 0 };
  for (const d of deltas) s[d]++;
  return s;
}
