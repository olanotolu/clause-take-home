import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { applyStrictness, STRICT_MIN_P } from "../src/review/ensemble.ts";
import type { Check } from "../src/review/types.ts";
import { testApp } from "./helpers.ts";

const check = (verdict: Check["verdict"], ps: number[] = []): Check => ({
  verdict,
  detail: "d",
  evidence: [],
  judges: ps.map((p, i) => ({ id: `j${i}`, label: "entailed", probability: p })),
});

describe("applyStrictness", () => {
  it("balanced (and unset) returns the check untouched", () => {
    const c = check("PASS", [0.5]);
    expect(applyStrictness(c, "balanced")).toBe(c);
    expect(applyStrictness(c, undefined)).toBe(c);
  });

  it("strict demotes a PASS when any judge is below the bar, naming who", () => {
    const r = applyStrictness(check("PASS", [0.95, 0.6]), "strict");
    expect(r.verdict).toBe("NEEDS_REVIEW");
    expect(r.detail).toContain("j1 60%");
    expect(r.detail).not.toContain("j0");
  });

  it("strict keeps a PASS that every judge is sure about, including exactly at the bar", () => {
    expect(applyStrictness(check("PASS", [0.95, STRICT_MIN_P]), "strict").verdict).toBe("PASS");
  });

  it("strict leaves a PASS with no probabilities alone (nothing to compare)", () => {
    expect(applyStrictness(check("PASS"), "strict").verdict).toBe("PASS");
  });

  it("strict can only make a check more cautious: other verdicts never change", () => {
    for (const v of ["FAIL", "NEEDS_REVIEW", "UNAVAILABLE"] as const) {
      const c = check(v, [0.1]);
      expect(applyStrictness(c, "strict")).toBe(c);
    }
  });
});

describe("GET /settings/status", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("reports facts about the server, and is read-only", async () => {
    app = await testApp();
    const r = await app.inject({ method: "GET", url: "/settings/status" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ access: "open", storage: expect.stringMatching(/sqlite|postgres/), ai: { judges: [], suggestions: false } });
    expect(body.limits.maxRequirementsPerDocument).toBeGreaterThan(0);
    expect((await app.inject({ method: "PUT", url: "/settings/status", payload: {} })).statusCode).toBe(404);
  });

  it("never contains a secret from the environment", async () => {
    const secret = "sk-or-v1-SECRET-SHOULD-NEVER-APPEAR";
    process.env.OPENROUTER_API_KEY = secret;
    try {
      app = await testApp();
      expect((await app.inject({ method: "GET", url: "/settings/status" })).body).not.toContain(secret);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("rejects an unknown strictness on /changes/check", async () => {
    app = await testApp();
    const doc = (await app.inject({ method: "POST", url: "/documents", payload: { title: "t", content: "hello world text" } })).json();
    const r = await app.inject({ method: "POST", url: `/documents/${doc.id}/changes/check`, payload: { expectedVersion: 1, changes: [], strictness: "paranoid" } });
    expect(r.statusCode).toBe(400);
  });
});

describe("GET /templates", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("lists the sample contracts with a category, and 'using' one is an ordinary create", async () => {
    app = await testApp();
    const r = await app.inject({ method: "GET", url: "/templates" });
    expect(r.statusCode).toBe(200);
    const { items } = r.json() as { items: { id: string; title: string; category: string }[] };
    expect(items.length).toBeGreaterThanOrEqual(5);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.find((i) => i.title.startsWith("Mutual NDA"))?.category).toBe("NDA");
    const t = (await app.inject({ method: "GET", url: `/templates/${items[0]!.id}` })).json() as { title: string; content: string };
    const created = await app.inject({ method: "POST", url: "/documents", payload: { title: t.title, content: t.content } });
    expect(created.statusCode).toBe(201);
    expect(created.json().content).toBe(t.content);
  });
});

describe("POST /documents/:id/changes/check with no changes", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("checks the current text against the requirements and proposes nothing", async () => {
    app = await testApp();
    const doc = (await app.inject({ method: "POST", url: "/documents", payload: { title: "t", content: "The Receiving Party shall not disclose Confidential Information." } })).json();
    await app.inject({ method: "POST", url: `/documents/${doc.id}/requirements`, payload: { kind: "present", text: "shall not disclose" } });
    await app.inject({ method: "POST", url: `/documents/${doc.id}/requirements`, payload: { kind: "absent", text: "indemnify" } });
    const r = await app.inject({ method: "POST", url: `/documents/${doc.id}/changes/check`, payload: { expectedVersion: 1, changes: [] } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mechanical).toEqual({ valid: true, wouldChange: false, changes: 0 });
    expect(body.requirements).toHaveLength(2);
    expect(body.requirements.every((q: { before: { verdict: string }; after: { verdict: string }; delta: string }) => q.before.verdict === "PASS" && q.after.verdict === "PASS" && q.delta === "held")).toBe(true);
    // nothing was written
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}` })).json().version).toBe(1);
  });

  it("still requires at least one change for PATCH and preview", async () => {
    app = await testApp();
    const doc = (await app.inject({ method: "POST", url: "/documents", payload: { title: "t", content: "hello there world" } })).json();
    expect((await app.inject({ method: "PATCH", url: `/documents/${doc.id}`, payload: { changes: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/documents/${doc.id}/changes/preview`, payload: { changes: [] } })).statusCode).toBe(400);
  });
});
