import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { snapshotOf } from "../src/review/snapshot.ts";
import type { CiReport, SemanticEvaluator } from "../src/review/types.ts";
import { DEMO_DOCUMENT_TITLE, SEED_PLAYBOOKS, SEED_REQUESTS, seedDemoRequirements } from "../src/seed-workspace.ts";
import { MAX_PLAYBOOKS, MAX_REQUIREMENTS_PER_DOCUMENT, MAX_RULES_PER_PLAYBOOK } from "../src/store/types.ts";
import { createDoc, patch, quote, sharedStores, testApp, testStore } from "./helpers.ts";

const NDA = "MUTUAL NDA\n1.1 The Receiving Party shall not disclose Confidential Information.\n1.2 These obligations survive for three (3) years.";
/** Timestamps have millisecond resolution, so ordering tests move the clock instead of sleeping. */
const tick = (ms = 1000) => vi.setSystemTime(Date.now() + ms);

const stub = (verdict: "PASS" | "FAIL"): SemanticEvaluator => ({ models: ["stub"], async evaluate() { return { verdict, detail: "stub", evidence: [], judges: [] }; } });

beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(() => void vi.useRealTimers());

describe("requests", () => {
  let app: FastifyInstance;
  beforeEach(async () => void (app = await testApp({ semanticEvaluator: stub("PASS") })));
  afterEach(async () => void (await app.close()));
  const create = (body: object) => app.inject({ method: "POST", url: "/requests", payload: body });
  const addReq = (docId: string, kind: string, text: string) => app.inject({ method: "POST", url: `/documents/${docId}/requirements`, payload: { kind, text } });

  it("creates with defaults, lists newest-updated first, filters by status", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const a = (await create({ documentId: d.id, title: "First", goal: "Do the first thing" })).json();
    expect(a).toMatchObject({ status: "inbox", priority: "medium", type: "Other", dueDate: null, ci: null, documentId: d.id });
    const b = (await create({ documentId: d.id, title: "Second", goal: "Do the second", status: "in_progress", priority: "high", type: "NDA", dueDate: "2026-12-31" })).json();
    tick();
    await app.inject({ method: "PATCH", url: `/requests/${a.id}`, payload: { priority: "low" } });
    const all = (await app.inject({ method: "GET", url: "/requests" })).json().items;
    expect(all.map((r: { id: string }) => r.id)).toEqual([a.id, b.id]); // a was touched last
    const only = (await app.inject({ method: "GET", url: "/requests?status=in_progress" })).json().items;
    expect(only.map((r: { id: string }) => r.id)).toEqual([b.id]);
    expect((await app.inject({ method: "GET", url: "/requests?status=bogus" })).statusCode).toBe(400);
  });

  it("validates input: unknown document, bad enums and dates, empty or NUL text, unknown fields, empty patch", async () => {
    expect((await create({ documentId: "doc_nope", title: "t", goal: "g" })).statusCode).toBe(404);
    const d = await createDoc(app, "NDA", NDA);
    for (const bad of [{ title: "", goal: "g" }, { title: "t", goal: "" }, { title: "t", goal: "g", status: "done" }, { title: "t", goal: "g", priority: "urgent" }, { title: "t", goal: "g", dueDate: "tomorrow" }, { title: "t", goal: "g", dueDate: "2026-02-31" }, { title: "a\u0000b", goal: "g" }, { title: "t", goal: "g", extra: 1 }, { title: "t", goal: "x".repeat(501) }]) {
      expect((await create({ documentId: d.id, ...bad })).statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    const r = (await create({ documentId: d.id, title: "t", goal: "g" })).json();
    expect((await app.inject({ method: "PATCH", url: `/requests/${r.id}`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/requests/${r.id}`, payload: { ci: null } })).statusCode).toBe(400); // clients cannot write the audit result
    expect((await app.inject({ method: "PATCH", url: "/requests/wrq_nope", payload: { priority: "low" } })).statusCode).toBe(404);
  });

  it("patches individual fields, clears the due date, and deletes", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const r = (await create({ documentId: d.id, title: "t", goal: "g", dueDate: "2026-11-01" })).json();
    const p = (await app.inject({ method: "PATCH", url: `/requests/${r.id}`, payload: { status: "needs_review", dueDate: null, title: "renamed" } })).json();
    expect(p).toMatchObject({ status: "needs_review", dueDate: null, title: "renamed", goal: "g" });
    expect((await app.inject({ method: "DELETE", url: `/requests/${r.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/requests/${r.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/requests/${r.id}` })).statusCode).toBe(404);
  });

  it("keeps a request when its document is deleted, with the link cleared", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const r = (await create({ documentId: d.id, title: "t", goal: "g" })).json();
    await app.inject({ method: "DELETE", url: `/documents/${d.id}` });
    const after = (await app.inject({ method: "GET", url: `/requests/${r.id}` })).json();
    expect(after.documentId).toBeNull();
    expect((await app.inject({ method: "POST", url: `/requests/${r.id}/check` })).json().type).toBe("REQUEST_HAS_NO_DOCUMENT");
  });

  it("check audits the CURRENT text, stores what it found, moves open requests with problems to Needs review, and writes nothing to the document", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await addReq(d.id, "present", "three (3) years");
    await addReq(d.id, "absent", "Confidential Information"); // present in the text: fails
    const r = (await create({ documentId: d.id, title: "t", goal: "Make it mutual" })).json();
    const res = await app.inject({ method: "POST", url: `/requests/${r.id}/check` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.moved).toBe(true);
    expect(body.request.status).toBe("needs_review");
    expect(body.request.ci).toMatchObject({ version: 1, total: 2, holding: 1, attention: 1, goal: "PASS", judges: ["stub"] });
    expect(body.request.ci.requirements.map((x: { verdict: string }) => x.verdict)).toEqual(["PASS", "FAIL"]);
    expect((await app.inject({ method: "GET", url: `/documents/${d.id}` })).json().version).toBe(1);
  });

  it("check never completes a request, and leaves a completed one where it is", async () => {
    const d = await createDoc(app, "NDA", NDA);
    await addReq(d.id, "present", "three (3) years");
    const open = (await create({ documentId: d.id, title: "open", goal: "g" })).json();
    const done = (await create({ documentId: d.id, title: "done", goal: "g", status: "completed" })).json();
    const a = (await app.inject({ method: "POST", url: `/requests/${open.id}/check` })).json();
    expect(a).toMatchObject({ moved: false, request: { status: "inbox", ci: { attention: 0 } } });
    await addReq(d.id, "absent", "MUTUAL");
    const b = (await app.inject({ method: "POST", url: `/requests/${done.id}/check` })).json();
    expect(b.request.status).toBe("completed");
    expect(b.request.ci.attention).toBe(1);
  });

  it("without a judge the goal is UNAVAILABLE, never pass or fail", async () => {
    await app.close();
    app = await testApp();
    const d = await createDoc(app, "NDA", NDA);
    const r = (await create({ documentId: d.id, title: "t", goal: "g" })).json();
    expect((await app.inject({ method: "POST", url: `/requests/${r.id}/check` })).json().request.ci.goal).toBe("UNAVAILABLE");
  });
});

describe("snapshotOf", () => {
  it("counts only saved requirements, keeps the goal apart, and clips long text", () => {
    const check = (verdict: "PASS" | "FAIL") => ({ verdict, detail: "", evidence: [] });
    const report = {
      documentId: "d", version: 3, mechanical: { valid: true, wouldChange: false, changes: 0 }, judges: ["m"], elapsedMs: 1, summary: { held: 0, regressed: 0, achieved: 0, still_failing: 0, uncertain: 0 },
      requirements: [
        { id: "goal", kind: "goal", text: "g", before: check("PASS"), after: check("FAIL"), delta: "regressed", touchedBy: [] },
        { id: "1", kind: "present", text: "x".repeat(400), before: check("PASS"), after: check("PASS"), delta: "held", touchedBy: [] },
        { id: "2", kind: "absent", text: "y", before: check("PASS"), after: check("FAIL"), delta: "regressed", touchedBy: [] },
      ],
    } as unknown as CiReport;
    const s = snapshotOf(report, new Date("2026-10-15T00:00:00Z"));
    expect(s).toMatchObject({ version: 3, total: 2, holding: 1, attention: 1, goal: "FAIL", checkedAt: "2026-10-15T00:00:00.000Z" });
    expect(s.requirements[0]!.text.length).toBe(301);
    expect(s.requirements.map((r) => r.kind)).toEqual(["present", "absent"]);
  });
});

describe("playbooks", () => {
  let app: FastifyInstance;
  beforeEach(async () => void (app = await testApp()));
  afterEach(async () => void (await app.close()));
  const mk = async (name = "NDA") => (await app.inject({ method: "POST", url: "/playbooks", payload: { name } })).json() as { id: string };
  const rule = (id: string, body: object) => app.inject({ method: "POST", url: `/playbooks/${id}/rules`, payload: body });

  it("creates, lists with rule counts, reads with ordered rules, renames and deletes (rules go with it)", async () => {
    const p = await mk("NDA");
    await rule(p.id, { title: "A", kind: "semantic", text: "first" });
    await rule(p.id, { title: "B", kind: "present", text: "second" });
    expect((await app.inject({ method: "GET", url: "/playbooks" })).json().items[0]).toMatchObject({ name: "NDA", ruleCount: 2, description: "" });
    const detail = (await app.inject({ method: "GET", url: `/playbooks/${p.id}` })).json();
    expect(detail.rules.map((r: { title: string }) => r.title)).toEqual(["A", "B"]);
    expect((await app.inject({ method: "PATCH", url: `/playbooks/${p.id}`, payload: { name: "Renamed", description: "d" } })).json()).toMatchObject({ name: "Renamed", description: "d" });
    expect((await app.inject({ method: "DELETE", url: `/playbooks/${p.id}/rules/${detail.rules[0].id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/playbooks/${p.id}` })).json().rules).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/playbooks/${p.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/playbooks/${p.id}` })).statusCode).toBe(404);
  });

  it("rejects bad input and unknown ids", async () => {
    expect((await app.inject({ method: "POST", url: "/playbooks", payload: { name: "" } })).statusCode).toBe(400);
    const p = await mk();
    expect((await rule(p.id, { title: "t", kind: "regex", text: "x" })).statusCode).toBe(400);
    expect((await rule(p.id, { title: "", kind: "present", text: "x" })).statusCode).toBe(400);
    expect((await rule("pbk_nope", { title: "t", kind: "present", text: "x" })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/playbooks/${p.id}/rules/rul_nope` })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/playbooks/${p.id}`, payload: {} })).statusCode).toBe(400);
  });

  it("applies rules as ordinary requirements, skipping duplicates, and stops at the per-document limit saying so", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const p = await mk();
    await rule(p.id, { title: "Years", kind: "present", text: "three (3) years" });
    await rule(p.id, { title: "Not perpetual", kind: "absent", text: "perpetual" });
    const first = (await app.inject({ method: "POST", url: `/documents/${d.id}/apply-playbook`, payload: { playbookId: p.id } })).json();
    expect(first.added.map((r: { text: string }) => r.text)).toEqual(["three (3) years", "perpetual"]);
    const again = (await app.inject({ method: "POST", url: `/documents/${d.id}/apply-playbook`, payload: { playbookId: p.id } })).json();
    expect(again.added).toEqual([]);
    expect(again.skipped).toEqual([{ title: "Years", reason: "duplicate" }, { title: "Not perpetual", reason: "duplicate" }]);

    const big = await mk("Big");
    for (let i = 0; i < MAX_REQUIREMENTS_PER_DOCUMENT; i++) await rule(big.id, { title: `r${i}`, kind: "present", text: `clause ${i}` });
    const res = (await app.inject({ method: "POST", url: `/documents/${d.id}/apply-playbook`, payload: { playbookId: big.id } })).json();
    expect(res.added).toHaveLength(MAX_REQUIREMENTS_PER_DOCUMENT - 2);
    expect(res.skipped.every((s: { reason: string }) => s.reason === "limit")).toBe(true);
    const reqs = (await app.inject({ method: "GET", url: `/documents/${d.id}/requirements` })).json();
    expect(reqs.items).toHaveLength(MAX_REQUIREMENTS_PER_DOCUMENT);
  });

  it("apply reports unknown documents and playbooks as 404", async () => {
    const p = await mk();
    const d = await createDoc(app, "NDA", NDA);
    expect((await app.inject({ method: "POST", url: `/documents/doc_nope/apply-playbook`, payload: { playbookId: p.id } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/documents/${d.id}/apply-playbook`, payload: { playbookId: "pbk_nope" } })).statusCode).toBe(404);
  });
});

describe("atomic workspace caps", () => {
  it("keeps every cap under concurrent writes across two store connections", async () => {
    const { a, b, cleanup } = await sharedStores();
    try {
      const doc = await a.insertDocument({ title: "caps", content: "text" });
      const reqAdds = await Promise.all(Array.from({ length: MAX_REQUIREMENTS_PER_DOCUMENT + 5 }, (_, i) => (i % 2 ? a : b).addRequirement(doc.id, { kind: "present", text: `r${i}` })));
      expect(reqAdds.filter(Boolean)).toHaveLength(MAX_REQUIREMENTS_PER_DOCUMENT);
      expect(await a.listRequirements(doc.id)).toHaveLength(MAX_REQUIREMENTS_PER_DOCUMENT);

      const playbooks = await Promise.all(Array.from({ length: MAX_PLAYBOOKS + 5 }, (_, i) => (i % 2 ? a : b).insertPlaybook({ name: `pb${i}`, description: "" })));
      expect(playbooks.filter(Boolean)).toHaveLength(MAX_PLAYBOOKS);
      const pb = playbooks.find(Boolean)!;
      const rules = await Promise.all(Array.from({ length: MAX_RULES_PER_PLAYBOOK + 5 }, (_, i) => (i % 2 ? a : b).addPlaybookRule(pb.id, { title: `rule${i}`, kind: "present", text: `r${i}` })));
      expect(rules.filter(Boolean)).toHaveLength(MAX_RULES_PER_PLAYBOOK);
      expect((await a.getPlaybook(pb.id))?.rules).toHaveLength(MAX_RULES_PER_PLAYBOOK);
    } finally { await cleanup(); }
  });

  it("rolls document copy and requirements back as one write", async () => {
    const store = await testStore();
    try {
      const before = (await store.listDocuments(100, 0)).total;
      await expect(store.insertDocumentWithRequirements({
        title: "must roll back", content: "copy",
        requirements: [{ kind: "not-a-kind" as never, text: "invalid" }],
      })).rejects.toThrow();
      expect((await store.listDocuments(100, 0)).total).toBe(before);
    } finally { await store.close(); }
  });
});

describe("activity across documents", () => {
  let app: FastifyInstance;
  beforeEach(async () => void (app = await testApp()));
  afterEach(async () => void (await app.close()));

  it("lists the newest versions of every document first, with titles, and honours the limit", async () => {
    const a = await createDoc(app, "Alpha", NDA);
    tick();
    const b = await createDoc(app, "Beta", NDA);
    tick();
    expect((await patch(app, a.id, { expectedVersion: 1, changes: [quote("MUTUAL", "BILATERAL")] })).statusCode).toBe(200);
    const items = (await app.inject({ method: "GET", url: "/activity" })).json().items as { title: string; version: number; documentId: string }[];
    expect(items.map((i) => `${i.title} v${i.version}`)).toEqual(["Alpha v2", "Beta v1", "Alpha v1"]);
    expect(items[0]!.documentId).toBe(a.id);
    expect(((await app.inject({ method: "GET", url: "/activity?limit=1" })).json().items as unknown[]).length).toBe(1);
    for (const bad of ["limit=0", "limit=101", "limit=", "limit=1e1", "limit= 1"]) expect((await app.inject({ method: "GET", url: `/activity?${bad}` })).statusCode, bad).toBe(400);
    void b;
  });
});

describe("sample workspace seeding (runs on whichever backend the suite uses)", () => {
  it("fills empty playbook and request tables once, skips requests whose document is missing, and never touches existing rows", async () => {
    const store = await testStore();
    try {
      await store.ensureSamples([{ title: "Mutual NDA - Acme Corp", content: "text" }]);
      expect(await store.seedPlaybooksIfEmpty(SEED_PLAYBOOKS)).toBe(SEED_PLAYBOOKS.length);
      expect(await store.seedPlaybooksIfEmpty(SEED_PLAYBOOKS)).toBe(0);
      expect((await store.listPlaybooks()).map((p) => p.ruleCount)).toEqual(SEED_PLAYBOOKS.map((p) => p.rules.length));
      const n = await store.seedRequestsIfEmpty(SEED_REQUESTS);
      expect(n).toBe(SEED_REQUESTS.filter((r) => r.documentTitle === "Mutual NDA - Acme Corp").length);
      expect(await store.seedRequestsIfEmpty(SEED_REQUESTS)).toBe(0);
      const reqs = await store.listRequests();
      expect(reqs.every((r) => r.documentId !== null)).toBe(true);
    } finally {
      await store.close();
    }
  });
});

describe("seedDemoRequirements", () => {
  it("applies the NDA playbook to the sample NDA once, and leaves a document that already has requirements alone", async () => {
    const store = await testStore();
    try {
      expect(await seedDemoRequirements(store)).toBe(0); // no document, no playbook yet
      await store.ensureSamples([{ title: DEMO_DOCUMENT_TITLE, content: "text" }, { title: "Other", content: "text" }]);
      expect(await seedDemoRequirements(store)).toBe(0); // no playbook yet
      await store.seedPlaybooksIfEmpty(SEED_PLAYBOOKS);
      const nda = SEED_PLAYBOOKS.find((p) => p.name === "NDA Playbook")!;
      expect(await seedDemoRequirements(store)).toBe(nda.rules.length);
      expect(await seedDemoRequirements(store)).toBe(0); // second run changes nothing
      const docs = (await store.listDocuments(10, 0)).items;
      const demo = docs.find((d) => d.title === DEMO_DOCUMENT_TITLE)!;
      expect((await store.listRequirements(demo.id)).map((r) => r.text)).toEqual(nda.rules.map((r) => r.text));
      expect(await store.listRequirements(docs.find((d) => d.title === "Other")!.id)).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
