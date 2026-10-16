import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { deltaOf, summarize } from "../src/review/delta.ts";
import type { Check, SemanticEvaluator, Verdict } from "../src/review/types.ts";
import { createDoc, patch, quote, testApp } from "./helpers.ts";

const NDA = [
  "MUTUAL NDA",
  "1.1 The Receiving Party shall not disclose Confidential Information.",
  "1.2 The Receiving Party may disclose Confidential Information if required by law, after prompt written notice.",
  "1.3 These obligations survive for three (3) years.",
].join("\n");

describe("deltaOf", () => {
  const V: Verdict[] = ["PASS", "FAIL", "NEEDS_REVIEW", "UNAVAILABLE"];
  it("is decided by this table, and uncertainty is never rounded into pass or fail", () => {
    expect(deltaOf("PASS", "PASS")).toBe("held");
    expect(deltaOf("PASS", "FAIL")).toBe("regressed");
    expect(deltaOf("FAIL", "PASS")).toBe("achieved");
    expect(deltaOf("FAIL", "FAIL")).toBe("still_failing");
    for (const a of V) for (const b of V) {
      if (a === "NEEDS_REVIEW" || a === "UNAVAILABLE" || b === "NEEDS_REVIEW" || b === "UNAVAILABLE") expect(deltaOf(a, b), `${a}->${b}`).toBe("uncertain");
    }
  });
  it("summarises counts", () => {
    expect(summarize(["held", "held", "regressed", "uncertain"])).toEqual({ held: 2, regressed: 1, achieved: 0, still_failing: 0, uncertain: 1 });
  });
});

describe("requirements API", () => {
  let app: FastifyInstance;
  beforeEach(async () => void (app = await testApp()));
  afterEach(async () => void (await app.close()));
  const add = (id: string, body: unknown) => app.inject({ method: "POST", url: `/documents/${id}/requirements`, payload: body as object });
  const list = async (id: string) => (await app.inject({ method: "GET", url: `/documents/${id}/requirements` })).json();

  it("adds, lists in order, and deletes requirements", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const a = await add(d.id, { kind: "present", text: "three (3) years" });
    const b = await add(d.id, { kind: "semantic", text: "Compelled disclosure is permitted" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ kind: "present", text: "three (3) years", documentId: d.id });
    expect(a.headers.location).toContain(`/documents/${d.id}/requirements/`);
    const l = await list(d.id);
    expect(l.items.map((r: { id: string }) => r.id)).toEqual([a.json().id, b.json().id]);
    expect(l.max).toBe(8);
    expect((await app.inject({ method: "DELETE", url: `/documents/${d.id}/requirements/${a.json().id}` })).statusCode).toBe(204);
    expect((await list(d.id)).items).toHaveLength(1);
  });

  it("caps requirements per document, and each document has its own", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const other = await createDoc(app, "Other", "x");
    for (let i = 0; i < 8; i++) expect((await add(d.id, { kind: "present", text: `t${i}` })).statusCode).toBe(201);
    const over = await add(d.id, { kind: "present", text: "one too many" });
    expect(over.statusCode).toBe(422);
    expect(over.json()).toMatchObject({ code: 422, type: "REQUIREMENT_LIMIT", details: { max: 8 } });
    expect((await list(other.id)).items).toHaveLength(0);
    expect((await add(other.id, { kind: "absent", text: "ok" })).statusCode).toBe(201);
  });

  it("validates input and reports missing things", async () => {
    const d = await createDoc(app, "NDA", NDA);
    for (const body of [{}, { kind: "present" }, { kind: "present", text: "" }, { kind: "bogus", text: "x" }, { kind: "present", text: "x", extra: 1 }, { kind: "present", text: "a\u0000b" }, { kind: "present", text: "x".repeat(2001) }]) {
      const res = await add(d.id, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await add("doc_nope", { kind: "present", text: "x" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/documents/doc_nope/requirements" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/documents/${d.id}/requirements/req_nope` })).json()).toMatchObject({ code: 404, type: "REQUIREMENT_NOT_FOUND" });
  });

  it("requirements survive edits to the document and are removed with it", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, { kind: "present", text: "three (3) years" });
    await patch(app, d.id, { changes: [quote("MUTUAL NDA", "NDA")] });
    expect((await list(d.id)).items).toHaveLength(1);
    await app.inject({ method: "DELETE", url: `/documents/${d.id}` });
    expect((await app.inject({ method: "GET", url: `/documents/${d.id}/requirements` })).statusCode).toBe(404);
  });
});

describe("POST /documents/:id/changes/check (deterministic requirements)", () => {
  let app: FastifyInstance;
  beforeEach(async () => void (app = await testApp()));
  afterEach(async () => void (await app.close()));
  const add = (id: string, kind: string, text: string) => app.inject({ method: "POST", url: `/documents/${id}/requirements`, payload: { kind, text } });
  const check = (id: string, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/documents/${id}/changes/check`, payload: body as object, headers });
  const byText = (report: { requirements: { text: string }[] }, text: string) => report.requirements.find((r) => r.text === text) as any;

  it("an unrelated edit leaves every requirement held, and the mechanical verdict stands on its own", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "present", "three (3) years");
    await add(d.id, "absent", "perpetual");
    await add(d.id, "unchanged", "may disclose Confidential Information if required by law");
    const res = await check(d.id, { expectedVersion: 1, changes: [quote("MUTUAL NDA", "MUTUAL NON-DISCLOSURE AGREEMENT")] });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.mechanical).toEqual({ valid: true, wouldChange: true, changes: 1 });
    expect(r.summary).toEqual({ held: 3, regressed: 0, achieved: 0, still_failing: 0, uncertain: 0 });
    expect(r.version).toBe(1);
    expect(r.judges).toEqual([]);
  });

  it("flags a regression: the edit breaks a requirement that held, with evidence", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "present", "three (3) years");
    const r = (await check(d.id, { changes: [quote("three (3) years", "two (2) years")] })).json();
    const item = byText(r, "three (3) years");
    expect(item).toMatchObject({ delta: "regressed", before: { verdict: "PASS" }, after: { verdict: "FAIL" } });
    expect(item.before.evidence[0]).toMatchObject({ verified: true, quote: "three (3) years" });
    expect(NDA.slice(item.before.evidence[0].start, item.before.evidence[0].end)).toBe("three (3) years"); // offsets index the current text
    expect(r.summary.regressed).toBe(1);
  });

  it("flags an absent-requirement regression and points at the offending text in the PROPOSED text", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "absent", "perpetual");
    const r = (await check(d.id, { changes: [quote("three (3) years", "a perpetual term")] })).json();
    const item = byText(r, "perpetual");
    expect(item).toMatchObject({ delta: "regressed", after: { verdict: "FAIL" } });
    const proposed = NDA.replace("three (3) years", "a perpetual term");
    expect(proposed.slice(item.after.evidence[0].start, item.after.evidence[0].end)).toBe("perpetual");
  });

  it("`unchanged` names the change that altered the passage; an edit elsewhere leaves it held", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "unchanged", "may disclose Confidential Information if required by law");
    const broken = (await check(d.id, { changes: [quote("MUTUAL NDA", "NDA"), quote("if required by law", "never")] })).json();
    const item = byText(broken, "may disclose Confidential Information if required by law");
    expect(item).toMatchObject({ delta: "regressed", touchedBy: [1] });
    expect(item.after.detail).toContain("#2");
    const fine = (await check(d.id, { changes: [quote("MUTUAL NDA", "NDA")] })).json();
    expect(byText(fine, "may disclose Confidential Information if required by law")).toMatchObject({ delta: "held", touchedBy: [] });
  });

  it("recognises a requirement the edit newly satisfies, and one that was already failing", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "present", "indemnify");
    await add(d.id, "present", "arbitration");
    const r = (await check(d.id, { changes: [quote("MUTUAL NDA", "MUTUAL NDA; each party shall indemnify the other")] })).json();
    expect(byText(r, "indemnify")).toMatchObject({ delta: "achieved", before: { verdict: "FAIL" }, after: { verdict: "PASS" } });
    expect(byText(r, "arbitration")).toMatchObject({ delta: "still_failing" });
  });

  it("an `unchanged` passage that was never in the document fails honestly before any edit", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "unchanged", "This sentence does not exist.");
    const item = byText((await check(d.id, { changes: [quote("MUTUAL NDA", "NDA")] })).json(), "This sentence does not exist.");
    expect(item).toMatchObject({ delta: "still_failing", before: { verdict: "FAIL" } });
    expect(item.before.detail).toContain("nothing to preserve");
  });

  it("is read-only: no version, content or history changes", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "present", "three (3) years");
    await check(d.id, { changes: [quote("three (3) years", "two (2) years")] });
    expect((await app.inject({ method: "GET", url: `/documents/${d.id}` })).json()).toMatchObject({ version: 1, content: NDA });
    expect((await app.inject({ method: "GET", url: `/documents/${d.id}/revisions` })).json().items).toHaveLength(1);
  });

  it("an edit that is not mechanically valid gets the usual error and no report", async () => {
    const d = await createDoc(app, "NDA", NDA + "\n1.4 The Receiving Party shall not disclose Trade Secrets.");
    await add(d.id, "present", "three (3) years");
    const ambiguous = await check(d.id, { changes: [quote("shall not disclose", "may disclose")] });
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json().type).toBe("AMBIGUOUS_TARGET");
    expect((await check(d.id, { expectedVersion: 7, changes: [quote("MUTUAL NDA", "x")] })).json().type).toBe("VERSION_CONFLICT");
    expect((await check(d.id, { changes: [quote("not in the doc", "x")] })).json().type).toBe("TARGET_NOT_FOUND");
    expect((await check("doc_nope", { changes: [quote("a", "b")] })).statusCode).toBe(404);
    expect((await check(d.id, { changes: [] })).statusCode).toBe(400);
  });

  it("a semantic requirement or goal with no judge configured is UNAVAILABLE and uncertain, never pass or fail", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await add(d.id, "semantic", "Compelled disclosure is permitted");
    const r = (await check(d.id, { goal: "Make confidentiality mutual", changes: [quote("MUTUAL NDA", "NDA")] })).json();
    expect(r.requirements.map((x: { kind: string }) => x.kind)).toEqual(["goal", "semantic"]);
    for (const item of r.requirements) expect(item).toMatchObject({ delta: "uncertain", before: { verdict: "UNAVAILABLE" }, after: { verdict: "UNAVAILABLE" } });
    expect(r.summary).toMatchObject({ uncertain: 2, held: 0, regressed: 0 });
  });

  it("rate limits the check route per client", async () => {
    await app.close();
    app = await testApp({ checkRateLimit: { max: 2, timeWindow: "1 minute" } });
    const d = await createDoc(app, "NDA", NDA);
    const go = () => check(d.id, { changes: [quote("MUTUAL NDA", "NDA")] });
    expect((await go()).statusCode).toBe(200);
    expect((await go()).statusCode).toBe(200);
    expect((await go()).json()).toMatchObject({ code: 429, type: "RATE_LIMITED" });
  });
});

describe("semantic evaluator integration (stub judge)", () => {
  let app: FastifyInstance;
  afterEach(async () => void (await app?.close()));

  /** A judge that says a requirement holds only when the text contains a marker; records what it was asked. */
  function stubJudge(calls: { requirement: string; text: string; isGoal: boolean }[], behaviour: "marker" | "throw" = "marker"): SemanticEvaluator {
    return {
      models: ["stub-judge-1"],
      async evaluate(args): Promise<Check> {
        calls.push(args);
        if (behaviour === "throw") throw new Error("boom");
        const holds = args.text.includes("MUTUAL");
        return { verdict: holds ? "PASS" : "FAIL", detail: holds ? "found marker" : "no marker", evidence: [] };
      },
    };
  }

  it("judges the goal on the current text and on the proposed text, and reports it as achieved", async () => {
    const calls: { requirement: string; text: string; isGoal: boolean }[] = [];
    app = await testApp({ semanticEvaluator: stubJudge(calls) });
    const d = await createDoc(app, "NDA", "Plain NDA.");
    const r = (await app.inject({ method: "POST", url: `/documents/${d.id}/changes/check`, payload: { goal: "Make it mutual", changes: [quote("Plain", "MUTUAL")] } })).json();
    expect(r.judges).toEqual(["stub-judge-1"]);
    expect(r.requirements[0]).toMatchObject({ kind: "goal", delta: "achieved", before: { verdict: "FAIL" }, after: { verdict: "PASS" } });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.text).sort()).toEqual(["MUTUAL NDA.", "Plain NDA."]);
    expect(calls.every((c) => c.isGoal && c.requirement === "Make it mutual")).toBe(true);
  });

  it("a judge that throws degrades to UNAVAILABLE instead of a 500, and exact requirements still report", async () => {
    app = await testApp({ semanticEvaluator: stubJudge([], "throw") });
    const d = await createDoc(app, "NDA", NDA);
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "semantic", text: "x" } });
    await app.inject({ method: "POST", url: `/documents/${d.id}/requirements`, payload: { kind: "present", text: "three (3) years" } });
    const res = await app.inject({ method: "POST", url: `/documents/${d.id}/changes/check`, payload: { changes: [quote("MUTUAL NDA", "NDA")] } });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.requirements[0]).toMatchObject({ kind: "semantic", delta: "uncertain", before: { verdict: "UNAVAILABLE" } });
    expect(r.requirements[1]).toMatchObject({ kind: "present", delta: "held" });
  });
});
