import { experimental_decide } from "ai";
import type { Judge, JudgeAnswer, JudgeLabel } from "./types.ts";

/**
 * Below this probability on its chosen option, Jev's answer is treated as "unclear" rather than acted on. Fixed BEFORE
 * the benchmark is run and changed only on the dev split (see bench/ci).
 */
export const JEV_MIN_CONFIDENCE = 0.7;

/** Pinned: the `jev-latest` alias moves, and a report must say exactly which model produced it. */
export const DEFAULT_JEV_MODEL = "typesafe-ai/jev-1.14.0";

export interface DecideInput {
  model: string;
  /** The document. Passed as data, separate from the question, so text inside it is never read as an instruction. */
  state: string;
  instructions: string;
  criteria: Record<"entailed" | "contradicted" | "not_mentioned", string>;
  signal?: AbortSignal;
}

export interface DecideOutput {
  choice: string;
  probabilities?: Record<string, number>;
}

export type DecideFn = (input: DecideInput) => Promise<DecideOutput>;

export function buildJevQuestion(requirement: string, isGoal: boolean): Pick<DecideInput, "instructions" | "criteria"> {
  const subject = isGoal ? "this goal" : "this requirement";
  return {
    instructions: `Based only on the document, does it satisfy ${subject}?\n\n${isGoal ? "Goal" : "Requirement"}: ${requirement}`,
    criteria: {
      entailed: "The document clearly satisfies it.",
      contradicted: "The document states the opposite, or something incompatible with it.",
      not_mentioned: "The document does not address it.",
    },
  };
}

/** A decision model (Jev) as one judge. It returns calibrated probabilities but no prose and no quotes. */
export function createJevJudge(opts: { id: string; decide: DecideFn }): Judge {
  return {
    id: opts.id,
    async judge({ requirement, text, isGoal, signal }): Promise<JudgeAnswer> {
      const out = await opts.decide({ model: opts.id, state: text, ...buildJevQuestion(requirement, isGoal), ...(signal && { signal }) });
      const known = out.choice === "entailed" || out.choice === "contradicted" || out.choice === "not_mentioned";
      const confidence = out.probabilities?.[out.choice];
      const label: JudgeLabel = !known || (confidence !== undefined && confidence < JEV_MIN_CONFIDENCE) ? "unclear" : (out.choice as JudgeLabel);
      const p = out.probabilities?.entailed;
      return { label, ...(p !== undefined && { pEntailed: p }), quotes: [], rationale: "" };
    },
  };
}

/** The real call: AI SDK 7 `experimental_decide`; a string model id resolves through Vercel AI Gateway (API key or OIDC). */
export const gatewayDecide: DecideFn = async ({ model, state, instructions, criteria, signal }) => {
  const r = await experimental_decide({
    model,
    state,
    questions: { verdict: { type: "choice", instructions, criteria } },
    ...(signal && { abortSignal: signal }),
  });
  const a = r.answers.verdict;
  return { choice: a.choice, ...(a.probabilities && { probabilities: a.probabilities as Record<string, number> }) };
};
