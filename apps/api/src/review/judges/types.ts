/** What a judge concluded about "does this text satisfy the requirement?". */
export type JudgeLabel = "entailed" | "contradicted" | "not_mentioned" | "unclear";

export interface JudgeAnswer {
  label: JudgeLabel;
  /** The judge's own estimate that the requirement is satisfied, when it provides one. Not shown without measured calibration. */
  pEntailed?: number;
  /** Passages the judge says support its answer. They are verified against the text before anyone relies on them. */
  quotes: string[];
  rationale: string;
}

export interface JudgeInput {
  requirement: string;
  text: string;
  /** The requirement is the stated goal of an edit rather than a standing condition. */
  isGoal: boolean;
  signal?: AbortSignal;
}

/** A single model's opinion. Implementations may throw; the evaluator turns that into "unavailable". */
export interface Judge {
  readonly id: string;
  judge(input: JudgeInput): Promise<JudgeAnswer>;
}
