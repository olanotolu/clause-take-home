import { describe, expect, it } from "vitest";
import { createSemanticEvaluator } from "../src/review/evaluator.ts";
import { testApp, createDoc } from "./helpers.ts";
import type { Judge } from "../src/review/judges/types.ts";
import { buildApp } from "../src/app.ts";
import { testStore } from "./helpers.ts";

describe("AI request budgets", () => {
  it("keeps liveness independent from database readiness", async () => {
    const store = await testStore();
    store.checkReady = async () => { throw new Error("database unavailable"); };
    const app = await buildApp({ store });
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    expect(await (await app.inject({ method: "GET", url: "/ready" })).json()).toEqual({ status: "not_ready" });
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    await app.close();
  });

  it("times out a hung suggestion, cancels the provider, redacts details, and writes nothing", async () => {
    let aborted = false;
    const app = await testApp({ aiTimeoutMs: 20, suggestionProvider: { kind: "fixture", model: "hung", suggest: (_input, options) => new Promise(() => options?.signal.addEventListener("abort", () => { aborted = true; })) } });
    const doc = await createDoc(app, "NDA", "The contract is confidential.");
    const response = await app.inject({ method: "POST", url: `/documents/${doc.id}/suggest`, payload: { instruction: "edit" } });
    expect(response.statusCode).toBe(504);
    expect(response.json()).toEqual({ error: "The AI suggestion took too long. Try again.", code: 504, type: "AI_TIMEOUT" });
    expect(aborted).toBe(true);
    expect((await app.store.getDocument(doc.id))?.version).toBe(1);
    await app.close();
  });
  it("returns the proposal without CI when the remaining budget expires", async () => {
    const app = await testApp({ aiTimeoutMs: 25, suggestionProvider: { kind: "fixture", model: "fixture", suggest: async () => ({ changes: [{ exact: "confidential", replacement: "private" }], rationale: "Change the term." }) }, semanticEvaluator: { models: ["hung"], evaluate: () => new Promise(() => {}) } });
    const doc = await createDoc(app, "NDA", "The contract is confidential.");
    const response = await app.inject({ method: "POST", url: `/documents/${doc.id}/suggest`, payload: { instruction: "edit" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ validation: { valid: true }, ci: null, applied: false });
    await app.close();
  });
  it("rejects oversized replacements instead of truncating them", async () => {
    const app = await testApp({ suggestionProvider: { kind: "fixture", model: "fixture", suggest: async () => ({ changes: [{ exact: "confidential", replacement: "x".repeat(2001) }], rationale: "Change." }) } });
    const doc = await createDoc(app, "NDA", "The contract is confidential.");
    const response = await app.inject({ method: "POST", url: `/documents/${doc.id}/suggest`, payload: { instruction: "edit" } });
    expect(response.json().validation.error.type).toBe("SCOPE_EXCEEDED");
    expect((await app.store.getDocument(doc.id))?.version).toBe(1);
    await app.close();
  });
  it("rejects an oversized rationale before previewing or applying", async () => {
    const app = await testApp({ suggestionProvider: { kind: "fixture", model: "fixture", suggest: async () => ({ changes: [{ exact: "confidential", replacement: "private" }], rationale: "x".repeat(401) }) } });
    const doc = await createDoc(app, "NDA", "The contract is confidential.");
    const response = await app.inject({ method: "POST", url: `/documents/${doc.id}/suggest`, payload: { instruction: "edit" } });
    expect(response.json().validation.error.type).toBe("SCOPE_EXCEEDED");
    expect((await app.store.getDocument(doc.id))?.version).toBe(1);
    await app.close();
  });
  it("expires queued work without starting it", async () => {
    let calls = 0;
    const judge: Judge = { id: "hung", judge: () => { calls++; return new Promise(() => {}); } };
    const evaluator = createSemanticEvaluator({ judges: [judge], concurrency: 1, timeoutMs: 25 });
    const result = await evaluator.evaluateBatch!({ text: "contract", requirements: Array.from({ length: 8 }, (_, i) => ({ requirement: `rule ${i}`, isGoal: false })) });
    expect(calls).toBe(1);
    expect(result.every((r) => r.verdict === "UNAVAILABLE")).toBe(true);
  });
  it("keeps independent callers alive when another caller cancels", async () => {
    const controller = new AbortController();
    let resolveSecond: (answer: Awaited<ReturnType<Judge["judge"]>>) => void = () => {};
    const judge: Judge = { id: "independent", judge: ({ signal }) => new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      resolveSecond = resolve;
    }) };
    const evaluator = createSemanticEvaluator({ judges: [judge] });
    const first = evaluator.evaluate({ text: "A confidential contract.", requirement: "confidential", isGoal: false, signal: controller.signal });
    const second = evaluator.evaluate({ text: "A confidential contract.", requirement: "confidential", isGoal: false, signal: new AbortController().signal });
    await Promise.resolve();
    controller.abort();
    resolveSecond({ label: "entailed", quotes: ["A confidential contract."], rationale: "Present." });
    expect((await first).verdict).toBe("UNAVAILABLE");
    expect((await second).verdict).toBe("PASS");
  });
  it("retains concurrency occupancy until a non-cooperative provider actually settles", async () => {
    let calls = 0;
    const evaluator = createSemanticEvaluator({ judges: [{ id: "hung", judge: () => { calls++; return new Promise(() => {}); } }], concurrency: 1, timeoutMs: 15 });
    await evaluator.evaluate({ text: "one", requirement: "r", isGoal: false });
    await evaluator.evaluate({ text: "two", requirement: "r", isGoal: false });
    expect(calls).toBe(1);
  });
  it("sends one batched call per distinct document state, with all rules in that call", async () => {
    let calls = 0;
    const judge: Judge = {
      id: "batcher",
      judge: async () => { throw new Error("a batching judge must not be called one rule at a time"); },
      judgeBatch: async (inputs) => { calls++; return inputs.map(() => ({ label: "entailed" as const, pEntailed: 0.95, quotes: [], rationale: "" })); },
    };
    const evaluator = createSemanticEvaluator({ judges: [judge] });
    const requirements = Array.from({ length: 9 }, (_, i) => ({ requirement: `rule ${i}`, isGoal: i === 8 }));
    const result = await Promise.all(["before", "after"].map((text) => evaluator.evaluateBatch!({ text, requirements })));
    expect(calls).toBe(2);
    expect(result.flat()).toHaveLength(18);
    expect(result.flat().every((r) => r.verdict === "NEEDS_REVIEW")).toBe(true); // no quoted evidence, so nothing can be confirmed
  });
});

it("the API keeps its search page coherent if another edit commits before snippet assembly", async () => {
  const app = await testApp();
  const doc = await createDoc(app, "snapshot", "First target snapshot.");
  const read = app.store.wordsPage.bind(app.store);
  app.store.wordsPage = async (...args) => {
    const snapshot = await read(...args);
    await app.store.commitRevision({ id: doc.id, expectedVersion: 1, content: "Completely different current content.", summary: "[]" });
    return snapshot;
  };
  const response = await app.inject({ method: "GET", url: "/documents/search?q=target" });
  expect(response.statusCode).toBe(200);
  expect(response.json().total).toBe(1);
  expect(response.json().results[0]).toMatchObject({ documentId: doc.id, version: 1 });
  const hit=response.json().results[0].hits[0];
  expect(hit.target).toBeDefined();
  if (!hit.target) throw new Error("search hit has no target");
  const target=hit.target;
  const expected="position" in target?target.position.expectedText:target.quote.exact;
  expect(expected.toLowerCase()).toContain("target");
  expect((await app.store.getDocument(doc.id))?.version).toBe(2);
  await app.close();
});


it("retains completed semantic checks when a different check misses the overall deadline", async () => {
  const evaluator = createSemanticEvaluator({ judges: [{ id: "mixed", judge: async ({ requirement }) => requirement === "slow" ? new Promise(() => {}) : { label: "entailed", quotes: ["The contract is confidential."], rationale: "Stated." } }] });
  const app = await testApp({ aiTimeoutMs: 30, semanticEvaluator: evaluator });
  const doc = await createDoc(app, "NDA", "The contract is confidential.");
  for (const text of ["fast", "slow"]) await app.store.addRequirement(doc.id, { kind: "semantic", text });
  const response = await app.inject({ method: "POST", url: `/documents/${doc.id}/changes/check`, payload: { changes: [] } });
  expect(response.statusCode).toBe(200);
  expect(response.json().requirements.map((r: { before: { verdict: string }; after: { verdict: string } }) => [r.before.verdict, r.after.verdict])).toEqual([["PASS", "PASS"], ["UNAVAILABLE", "UNAVAILABLE"]]);
  await app.close();
});
