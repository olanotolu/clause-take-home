// Benchmark-only provider boundary. Uses the API package's existing dependencies; never imported by the service.
import { experimental_decide, generateText, Output } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";

export const MODELS = { jev: "typesafe-ai/jev-1.14.0", llm: "anthropic/claude-sonnet-5.5" };
export const verdictSchema = z.enum(["supported", "contradicted", "unsupported"]);
export type Label = z.infer<typeof verdictSchema>;
const schema = z.object({ verdict: verdictSchema, probability: z.number().min(0).max(1) });
const priceSchema = z.object({ data: z.array(z.object({ id: z.string(), pricing: z.object({ input: z.string().optional(), output: z.string().optional(), prompt: z.string().optional(), completion: z.string().optional() }) })) });
export async function prices(arm: keyof typeof MODELS) {
  const url = arm === "jev" ? "https://ai-gateway.vercel.sh/v1/models" : "https://openrouter.ai/api/v1/models";
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Pricing unavailable");
  const data = priceSchema.parse(await response.json());
  const model = data.data.find((m) => m.id === MODELS[arm]);
  if (!model) throw new Error("No published price for pinned model");
  const input = Number(model.pricing.input ?? model.pricing.prompt);
  const output = Number(model.pricing.output ?? model.pricing.completion);
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output < 0) throw new Error("Unknown model pricing");
  if (arm === "jev" && output !== 0) throw new Error("Jev output has no configured token cap; require zero published output price");
  return { input, output };
}
export async function citationCall(arm: keyof typeof MODELS, state: { claim: string; citation: string; passage: string }, instructions: string) {
  const abortSignal = AbortSignal.timeout(25_000);
  if (arm === "jev") {
    const result = await experimental_decide({ model: MODELS.jev, state, questions: { support: { type: "choice", instructions, criteria: {
      supported: "The passage establishes the claim, including relevant conditions.",
      contradicted: "The passage states the opposite of the claim.",
      unsupported: "The passage does not establish either the claim or its opposite.",
    } } }, maxRetries: 0, abortSignal });
    const answer = result.answers.support;
    const choice = verdictSchema.safeParse(answer.choice);
    const probability = answer.probabilities?.[answer.choice];
    const valid = probability !== undefined && Number.isFinite(probability) && probability >= .7 && probability <= 1;
    return { decision: choice.success && valid ? choice.data : "review" as const, ...(probability !== undefined && { probability }), inputTokens: result.usage.inputTokens ?? 0 };
  }
  const result = await generateText({ model: createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! })(MODELS.llm), system: instructions, prompt: JSON.stringify(state), output: Output.object({ schema }), temperature: 0, maxRetries: 0, maxOutputTokens: 200, abortSignal });
  return { decision: result.output.probability >= .7 ? result.output.verdict : "review" as const, probability: result.output.probability, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
}
