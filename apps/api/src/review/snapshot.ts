import type { CiSnapshot } from "../store/types.ts";
import type { CiReport } from "./types.ts";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * What a request keeps of a Clause CI audit: enough to show "2 of 3 hold" and name the ones that don't, without
 * storing evidence offsets (they index a version of the text that will move on). The goal, when present, is kept apart
 * from the saved requirements.
 */
export function snapshotOf(report: CiReport, now = new Date()): CiSnapshot {
  const rules = report.requirements.filter((r) => r.kind !== "goal");
  const goal = report.requirements.find((r) => r.kind === "goal");
  const holding = rules.filter((r) => r.after.verdict === "PASS").length;
  return {
    version: report.version,
    checkedAt: now.toISOString(),
    total: rules.length,
    holding,
    attention: rules.length - holding,
    judges: report.judges,
    ...(goal && { goal: goal.after.verdict }),
    requirements: rules.map((r) => ({ text: clip(r.text, 300), kind: r.kind as Exclude<typeof r.kind, "goal">, verdict: r.after.verdict })),
  };
}
