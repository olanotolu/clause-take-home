import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Check, SemanticEvaluator } from "../src/review/types.ts";
import { createDoc, quote, testApp } from "./helpers.ts";

/**
 * Every Clause CI result says HOW it was decided: "exact" (literal text matching, no model) or "model" (a judge's
 * opinion), and which judges actually answered. A model PASS is advisory; the report must never let it pass for an exact one.
 */
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const judge = (answer: Check, id = "stub-judge"): SemanticEvaluator => ({ models: [id, "configured-but-silent"], async evaluate() { return { ...answer, judges: [{ id, label: "entailed", probability: 0.9, rationale: "r" }] }; } });

describe("CI report provenance", () => {
  it("labels exact checks 'exact' with no judges, and judged ones 'model' with the judges that answered", async () => {
    app = await testApp({ semanticEvaluator: judge({ verdict: "PASS", detail: "ok", evidence: [] }) });
    const d = await createDoc(app, "NDA", "The Receiving Party shall not disclose Confidential Information. Term: three (3) years.");
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "present", text: "three (3) years" } });
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "absent", text: "perpetual" } });
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "unchanged", text: "shall not disclose" } });
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "semantic", text: "Both parties are bound" } });
    const res = await app.inject({ method: "POST", url: `/documents/${d.id}/changes/check`, payload: { goal: "Make it mutual", changes: [quote("Receiving", "Each")] } });
    expect(res.statusCode).toBe(200);
    const reqs = res.json().requirements as { kind: string; method: string; answeredBy: string[] }[];
    for (const r of reqs.filter((x) => ["present", "absent", "unchanged"].includes(x.kind))) expect(r).toMatchObject({ method: "exact", answeredBy: [] });
    for (const r of reqs.filter((x) => ["semantic", "goal"].includes(x.kind))) expect(r).toMatchObject({ method: "model", answeredBy: ["stub-judge"] });
    expect(reqs.some((r) => r.kind === "goal")).toBe(true);
  });

  it("a model requirement nobody answered says so: method 'model', answeredBy empty", async () => {
    app = await testApp();
    const d = await createDoc(app, "NDA", "Plain text.");
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "semantic", text: "x" } });
    const r = (await app.inject({ method: "POST", url: `/documents/${d.id}/changes/check`, payload: { changes: [quote("Plain", "Simple")] } })).json().requirements[0];
    expect(r).toMatchObject({ kind: "semantic", method: "model", answeredBy: [], before: { verdict: "UNAVAILABLE" } });
  });
});
