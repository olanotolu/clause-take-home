import type { RequirementKind } from "../store/types.ts";

/**
 * PASS / FAIL are claims the checker stands behind (exact checks, or judges that agree with verified evidence).
 * NEEDS_REVIEW means "a human must look"; UNAVAILABLE means no judge could answer. There is deliberately no "SAFE".
 */
export type Verdict = "PASS" | "FAIL" | "NEEDS_REVIEW" | "UNAVAILABLE";

/** How a requirement's status moved because of the proposed edit. */
export type Delta = "held" | "regressed" | "achieved" | "still_failing" | "uncertain";

/** A passage that supports (or violates) a requirement, located in the text that was checked. */
export interface EvidenceSpan {
  start: number;
  end: number;
  quote: string;
  /** True when the quote was found verbatim in the text at [start, end). Model-quoted text that can't be found is shown but never trusted. */
  verified: boolean;
}

/** One judge's opinion, kept in the report so a reader can see who said what. */
export interface JudgeDetail {
  id: string;
  label: string;
  probability?: number;
  rationale?: string;
}

export interface Check {
  verdict: Verdict;
  detail: string;
  /** Per-judge opinions for semantic checks; absent for exact checks. */
  judges?: JudgeDetail[];
  /** Offsets index the text this check ran on: the current version for `before`, the proposed text for `after`. */
  evidence: EvidenceSpan[];
}

export interface RequirementReport {
  /** The saved requirement's id, or "goal" for the edit's stated objective. */
  id: string;
  kind: RequirementKind | "goal";
  text: string;
  before: Check;
  after: Check;
  delta: Delta;
  /** For `unchanged`: indices (request order) of the applied changes that overlap the passage. */
  touchedBy: number[];
}

export interface CiSummary {
  held: number;
  regressed: number;
  achieved: number;
  still_failing: number;
  uncertain: number;
}

export interface CiReport {
  documentId: string;
  /** The version the edit was checked against. */
  version: number;
  /** The engine's verdict. Always valid here: an invalid edit is rejected with the usual error before any requirement runs. */
  mechanical: { valid: true; wouldChange: boolean; changes: number };
  requirements: RequirementReport[];
  summary: CiSummary;
  /** Model ids that contributed, so a report records exactly what judged it. */
  judges: string[];
  elapsedMs: number;
}

/** Judges one natural-language requirement against one text. Implementations never throw: failure is an UNAVAILABLE check. */
export interface SemanticEvaluator {
  readonly models: string[];
  evaluate(args: { requirement: string; text: string; isGoal: boolean }): Promise<Check>;
}
