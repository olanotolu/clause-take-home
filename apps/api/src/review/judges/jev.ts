import { experimental_decide } from "ai";
import type { Judge, JudgeAnswer, JudgeLabel } from "./types.ts";

/**
 * Below this probability on its chosen option, Jev's answer is treated as "unclear" rather than acted on. Fixed BEFORE
 * the benchmark is run and changed only on the dev split (see bench/ci).
 */
export const JEV_MIN_CHOICE_PROBABILITY = 0.7;

/** Pinned: the `jev-latest` alias moves, and a report must say exactly which model produced it. */
export const DEFAULT_JEV_MODEL = "typesafe-ai/jev-1.14.0";

export interface DecideInput {
  model: string;
  /** The document. Passed as data, separate from the question, but remains untrusted and may influence the answer adversarially. */
  state: string;
  instructions: string;
  criteria: Record<"entailed" | "contradicted" | "not_mentioned", string>;
  signal?: AbortSignal;
  questions?: { instructions: string; criteria: DecideInput["criteria"] }[];
}

export interface DecideOutput {
  choice: string;
  probabilities?: Record<string, number>;
  batch?: DecideOutput[];
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

/** A decision model (Jev) as one judge. It returns selected-option probabilities but no prose and no quotes. */
export function createJevJudge(opts: { id: string; decide: DecideFn }): Judge {
  const answer = (out: DecideOutput): JudgeAnswer => {
    const known = out.choice === "entailed" || out.choice === "contradicted" || out.choice === "not_mentioned";
    const probability = out.probabilities?.[out.choice];
    const valid = probability !== undefined && Number.isFinite(probability) && probability >= JEV_MIN_CHOICE_PROBABILITY && probability <= 1;
    const p = out.probabilities?.entailed;
    return { label: known && valid ? out.choice as JudgeLabel : "unclear", ...(p !== undefined && Number.isFinite(p) && p >= 0 && p <= 1 && { pEntailed: p }), quotes: [], rationale: "" };
  };
  return {
    id: opts.id,
    async judge(input) {
      return answer(await opts.decide({ model: opts.id, state: input.text, ...buildJevQuestion(input.requirement, input.isGoal), ...(input.signal && { signal: input.signal }) }));
    },
    async judgeBatch(inputs) {
      if (!inputs.length) return [];
      const first = inputs[0]!;
      if (inputs.some((input) => input.text !== first.text)) throw new Error("A Jev batch must share one document state");
      const out = await opts.decide({ model: opts.id, state: first.text, ...buildJevQuestion(first.requirement, first.isGoal), questions: inputs.map((input) => buildJevQuestion(input.requirement, input.isGoal)), ...(first.signal && { signal: first.signal }) });
      if (!out.batch || out.batch.length !== inputs.length) throw new Error("Incomplete Jev batch");
      return out.batch.map(answer);
    },
  };
}

/** The real call: AI SDK 7 `experimental_decide`; a string model id resolves through Vercel AI Gateway (API key or OIDC). */
export const gatewayDecide: DecideFn = async ({ model, state, instructions, criteria, signal, questions }) => {
  const r = await experimental_decide({
    model,
    state,
    questions: Object.fromEntries((questions ?? [{ instructions, criteria }]).map((q, i) => [`q${i}`, { type: "choice" as const, ...q } ])),
    maxRetries: 0,
    ...(signal && { abortSignal: signal }),
  });
  const batch = (questions ?? [{ instructions, criteria }]).map((_, i): DecideOutput => {
    const a = r.answers[`q${i}`]!;
    if (a.type !== "choice") throw new Error("Unexpected Jev answer type");
    return { choice: a.choice, ...(a.probabilities && { probabilities: a.probabilities }) };
  });
  return { ...batch[0]!, ...(questions && { batch }) };
};
