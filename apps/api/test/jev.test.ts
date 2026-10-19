import { describe, expect, it, vi } from "vitest";
import { createJevJudge, JEV_MODEL, JEV_MAX_QUESTION_CHARS, type JevChoice } from "../src/review/judges/jev.ts";
import { createJevRolloutEvaluator, evaluatorFromEnv } from "../src/review/evaluator.ts";
import type { Judge, JudgeAnswer } from "../src/review/judges/types.ts";
import type { Check, SemanticEvaluator } from "../src/review/types.ts";

const choice = (label: string, probabilities: Record<string, number> = { entailed: 0.05, contradicted: 0.05, not_mentioned: 0.85, unclear: 0.05 }, confidence = 0.9): JevChoice => ({ choice: label, probabilities, confidence });
const answer = (label: JudgeAnswer["label"], extra: Partial<JudgeAnswer> = {}): JudgeAnswer => ({ label, quotes: [], rationale: "", ...extra });

describe("Jev batched Choice judge", () => {
  it("reuses one document state for a single batched provider call and maps probabilities separately from confidence", async () => {
    const request = vi.fn(async (input) => ({ model: JEV_MODEL, usage: { input_tokens: 80, output_tokens: 10 }, answers: Object.fromEntries(Object.keys(input.questions).map((key) => [key, choice("entailed", { entailed: 0.72, contradicted: 0.08, not_mentioned: 0.1, unclear: 0.1 }, 0.44)])) }));
    const judge = createJevJudge({ request });
    const results = await judge.judgeBatch!([
      { requirement: "A cap applies", text: "The agreement caps liability.", isGoal: false },
      { requirement: "Notice is required", text: "The agreement caps liability.", isGoal: true },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0].state).toBe("The agreement caps liability.");
    expect(Object.keys(request.mock.calls[0]![0].questions)).toHaveLength(2);
    expect(results[0]).toMatchObject({ label: "entailed", pEntailed: 0.72, choiceProbability: 0.72, decisionConfidence: 0.44, quotes: [], rationale: "" });
  });

  it("rejects a wrong model id, missing answers and malformed probability/confidence values", async () => {
    const input = [{ requirement: "r", text: "t", isGoal: false }];
    await expect(createJevJudge({ request: async () => ({ model: "jev-latest", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }) }).judgeBatch!(input)).rejects.toThrow("different model");
    await expect(createJevJudge({ request: async () => ({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }) }).judgeBatch!(input)).rejects.toThrow("omitted");
    await expect(createJevJudge({ request: async (_r) => ({ model: JEV_MODEL, answers: { requirement_0: choice("other") }, usage: { input_tokens: 1, output_tokens: 1 } }) }).judgeBatch!(input)).rejects.toThrow("malformed Choice");
    await expect(createJevJudge({ request: async () => ({ model: JEV_MODEL, answers: { requirement_0: choice("entailed", { entailed: 0.5, contradicted: 0.5, not_mentioned: 0, unclear: 0 }, 1.2) }, usage: { input_tokens: 1, output_tokens: 1 } }) }).judgeBatch!(input)).rejects.toThrow("malformed Choice");
    await expect(createJevJudge({ request: async () => ({ model: JEV_MODEL, answers: { requirement_0: choice("entailed", { entailed: 0.2, contradicted: 0.2, not_mentioned: 0.2, unclear: 0.2 }) }, usage: { input_tokens: 1, output_tokens: 1 } }) }).judgeBatch!(input)).rejects.toThrow("malformed Choice probabilities");
  });

  it("enforces text and per-question context limits before sending", async () => {
    const request = vi.fn();
    const judge = createJevJudge({ request });
    await expect(judge.judge({ requirement: "r".repeat(JEV_MAX_QUESTION_CHARS + 1), text: "t", isGoal: false })).rejects.toThrow("standard context limits");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects batches that mix document states or exceed the shared request budget", async () => {
    const request = vi.fn();
    const judge = createJevJudge({ request });
    await expect(judge.judgeBatch!([
      { requirement: "one", text: "document A", isGoal: false },
      { requirement: "two", text: "document B", isGoal: false },
    ])).rejects.toThrow("one document state");
    await expect(judge.judgeBatch!(Array.from({ length: 7 }, (_, index) => ({ requirement: `requirement ${index}`.repeat(300), text: "t".repeat(24_000), isGoal: false })))).rejects.toThrow("request context limit");
    expect(request).not.toHaveBeenCalled();
  });

  it("passes abort signals through and surfaces cancellation, timeout, rate-limit and provider failures for fallback", async () => {
    for (const failure of [new DOMException("cancelled", "AbortError"), new Error("timeout"), new Error("429 rate limit"), new Error("provider unavailable")]) {
      const request = vi.fn(async (_input, signal) => { expect(signal).toBeDefined(); throw failure; });
      const judge = createJevJudge({ request });
      await expect(judge.judge({ requirement: "r", text: "t", isGoal: false, signal: new AbortController().signal })).rejects.toBe(failure);
    }
  });
});

describe("Jev rollout policy", () => {
  const baseCheck: Check = { verdict: "PASS", detail: "Current judge verified it.", evidence: [{ start: 0, end: 20, quote: "Verified contractual clause", verified: true }], judges: [{ id: "current", label: "entailed", probability: 0.94 }] };
  const base = (evaluateBatch: NonNullable<SemanticEvaluator["evaluateBatch"]>): SemanticEvaluator => ({ models: ["current"], evaluateBatch, async evaluate() { return baseCheck; } });
  const makeJev = (result: JudgeAnswer): Judge => ({ id: JEV_MODEL, async judge() { return result; }, async judgeBatch(inputs) { return inputs.map(() => result); } });

  it("keeps the current result authoritative in shadow while still invoking one Jev batch", async () => {
    const request = vi.fn(async ({ requirements }: { requirements: { requirement: string; isGoal: boolean }[] }) => requirements.map(() => baseCheck));
    const jev = makeJev(answer("not_mentioned", { choiceProbability: 0.99, decisionConfidence: 0.98 }));
    const out = await createJevRolloutEvaluator({ base: base(request), jev, mode: "shadow", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(out[0]).toBe(baseCheck);
    expect(request).toHaveBeenCalledTimes(1);
    expect(jev.judgeBatch).toBeDefined();
  });

  it("uses only confident Jev negatives directly and sends positives through the quote-producing judge", async () => {
    const current = vi.fn(async ({ requirements }: { requirements: { requirement: string; isGoal: boolean }[] }) => requirements.map(() => baseCheck));
    const negative = await createJevRolloutEvaluator({ base: base(current), jev: makeJev(answer("not_mentioned", { pEntailed: 0.05, choiceProbability: 0.9, decisionConfidence: 0.2 })), mode: "pilot", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(negative[0]?.verdict).toBe("FAIL");
    expect(negative[0]?.judges?.[0]).toMatchObject({ id: JEV_MODEL, probability: 0.05, decisionConfidence: 0.2 });
    expect(current).not.toHaveBeenCalled();

    const positive = await createJevRolloutEvaluator({ base: base(current), jev: makeJev(answer("entailed", { pEntailed: 0.97, decisionConfidence: 0.9 })), mode: "pilot", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(positive[0]).toMatchObject({ verdict: "PASS", judges: [{ id: "current" }, { id: JEV_MODEL, probability: 0.97, decisionConfidence: 0.9 }] });
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("uses the current judge on Jev errors or uncertain decisions and demotes disagreement to review", async () => {
    const current = vi.fn(async ({ requirements }: { requirements: { requirement: string; isGoal: boolean }[] }) => requirements.map(() => ({ ...baseCheck, verdict: "FAIL" as const })));
    const jev = { id: JEV_MODEL, async judge() { return answer("entailed"); }, async judgeBatch() { throw new Error("provider unavailable"); } };
    const fallback = await createJevRolloutEvaluator({ base: base(current), jev, mode: "pilot", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(fallback[0]?.verdict).toBe("FAIL");
    expect(current).toHaveBeenCalledTimes(1);
    const conflict = await createJevRolloutEvaluator({ base: base(current), jev: makeJev(answer("entailed")), mode: "pilot", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(conflict[0]?.verdict).toBe("NEEDS_REVIEW");
  });

  it("uses single-item base evaluators, preserves Jev metadata on fallback, and tolerates shadow provider failure", async () => {
    const single = vi.fn(async () => baseCheck);
    const singleOnly: SemanticEvaluator = { models: ["current"], evaluate: single };
    const jevUncertain = makeJev(answer("unclear", { decisionConfidence: 0.25 }));
    const fallback = await createJevRolloutEvaluator({ base: singleOnly, jev: jevUncertain, mode: "pilot", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(single).toHaveBeenCalledTimes(1);
    expect(fallback[0]?.judges?.at(-1)).toMatchObject({ id: JEV_MODEL, decisionConfidence: 0.25 });

    const failedJev = { id: JEV_MODEL, async judge() { throw new Error("no provider"); }, async judgeBatch() { throw new Error("no provider"); } };
    const shadow = await createJevRolloutEvaluator({ base: singleOnly, jev: failedJev, mode: "shadow", minChoiceProbability: 0.7 }).evaluateBatch!({ text: "doc", requirements: [{ requirement: "r", isGoal: false }] });
    expect(shadow[0]).toBe(baseCheck);
  });
});

describe("Jev environment and promotion guard", () => {
  it("leaves Jev off without explicit configuration or a server key", () => {
    expect(evaluatorFromEnv({})).toBeUndefined();
    expect(evaluatorFromEnv({ CLAUSE_JEV_MODE: "shadow" })).toBeUndefined();
    expect(evaluatorFromEnv({ TYPESAFE_API_KEY: "test-only", CLAUSE_JEV_MODE: "off" })).toBeUndefined();
  });

  it("starts in shadow and refuses pilot without a passed frozen evaluation gate", () => {
    const shadow = evaluatorFromEnv({ TYPESAFE_API_KEY: "test-only", CLAUSE_JEV_MODE: "pilot" });
    expect(shadow?.jevMode).toBe("shadow");
    expect(shadow?.models).toContain(JEV_MODEL);
    const pilot = evaluatorFromEnv({ TYPESAFE_API_KEY: "test-only", CLAUSE_JEV_MODE: "pilot", CLAUSE_JEV_PILOT_GATE: "passed" });
    expect(pilot?.jevMode).toBe("pilot");
  });

  it("keeps the existing judge authoritative in shadow and exposes both judges", () => {
    const evaluator = evaluatorFromEnv({ OPENROUTER_API_KEY: "test-only", TYPESAFE_API_KEY: "test-only", CLAUSE_JEV_MODE: "shadow" });
    expect(evaluator?.models).toEqual(["anthropic/claude-sonnet-5.5", JEV_MODEL]);
    expect(evaluator?.jevMode).toBe("shadow");
  });
});
