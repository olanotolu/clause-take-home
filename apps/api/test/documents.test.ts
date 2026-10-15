import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createDoc, NDA, patch, quote, testApp } from "./helpers.ts";

let app: FastifyInstance;
beforeEach(async () => void (app = await testApp()));
afterEach(async () => void (await app.close()));

describe("create / read / list / delete", () => {
  it("creates at version 1 with an ETag and Location", async () => {
    const res = await app.inject({ method: "POST", url: "/documents", payload: { title: "NDA", content: "hello" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ title: "NDA", content: "hello", version: 1 });
    expect(res.headers.etag).toMatch(/^"v1-[0-9a-f]{12}"$/);
    expect(res.headers.location).toBe(`/documents/${body.id}`);
  });

  it("reads a document back and supports If-None-Match", async () => {
    const doc = await createDoc(app, "NDA", "hello");
    const res = await app.inject({ method: "GET", url: `/documents/${doc.id}` });
    expect(res.json()).toMatchObject({ id: doc.id, content: "hello", version: 1 });
    const cached = await app.inject({ method: "GET", url: `/documents/${doc.id}`, headers: { "if-none-match": res.headers.etag as string } });
    expect(cached.statusCode).toBe(304);
  });

  it("lists metadata without bodies, newest first, with pagination", async () => {
    for (const t of ["a", "b", "c"]) await createDoc(app, t, `body ${t}`);
    const res = await app.inject({ method: "GET", url: "/documents?limit=2&offset=0" });
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.items.map((i: { title: string }) => i.title)).toEqual(["c", "b"]);
    expect(body.items[0]).not.toHaveProperty("content");
    expect(body.items[0].size).toBe(6);
  });

  it("deletes a document", async () => {
    const doc = await createDoc(app, "x", "y");
    expect((await app.inject({ method: "DELETE", url: `/documents/${doc.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}` })).statusCode).toBe(404);
  });
});

describe("PATCH /documents/:id", () => {
  it("applies a change and returns the full updated text, new version and a receipt", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const res = await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "Trade Secrets and Know-How")] });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toBe(NDA.replace("Trade Secrets", "Trade Secrets and Know-How"));
    expect(body).toMatchObject({ previousVersion: 1, version: 2, changed: true });
    expect(body.beforeHash).toBe(doc.contentHash);
    expect(body.afterHash).not.toBe(body.beforeHash);
    expect(body.applied[0]).toMatchObject({ before: "Trade Secrets", after: "Trade Secrets and Know-How" });
    expect(res.headers.etag).toMatch(/^"v2-/);
    const reread = (await app.inject({ method: "GET", url: `/documents/${doc.id}` })).json();
    expect(reread).toMatchObject({ version: 2, content: body.content });
  });

  it("rejects an ambiguous target with candidates and leaves the document untouched", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const res = await patch(app, doc.id, { changes: [quote("shall not disclose", "may disclose")] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 409, type: "AMBIGUOUS_TARGET", details: { matchCount: 3 } });
    expect(res.json().details.candidates).toHaveLength(3);
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}` })).json()).toMatchObject({ version: 1, content: NDA });
  });

  it("resolves the ambiguity with an occurrence or with context", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const a = await patch(app, doc.id, { changes: [quote("shall not disclose", "may disclose", { occurrence: 2 })] });
    expect(a.json().content).toContain("Disclosing Party may disclose Trade Secrets");
    const b = await patch(app, doc.id, { changes: [quote("shall not disclose", "WILL", { prefix: "Neither party " })] });
    expect(b.json().content).toContain("Neither party WILL the Term");
    expect(b.json().version).toBe(3);
  });

  it("a failing change in a batch applies none of them", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const res = await patch(app, doc.id, { changes: [quote("Trade Secrets", "TS"), quote("not in doc", "x")] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ type: "TARGET_NOT_FOUND", details: { index: 1 } });
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}` })).json().content).toBe(NDA);
  });

  it("maps engine errors to 4xx with the { error, code, type } body", async () => {
    const doc = await createDoc(app, "t", "abcdef");
    const overlap = await patch(app, doc.id, {
      changes: [
        { operation: "replace", target: { position: { start: 0, end: 4, expectedText: "abcd" } }, replacement: "X" },
        { operation: "replace", target: { position: { start: 2, end: 5, expectedText: "cde" } }, replacement: "Y" },
      ],
    });
    expect(overlap.statusCode).toBe(422);
    expect(overlap.json()).toMatchObject({ code: 422, type: "OVERLAPPING_CHANGES", details: { indices: [0, 1] } });
    expect(typeof overlap.json().error).toBe("string");

    const mismatch = await patch(app, doc.id, {
      changes: [{ operation: "replace", target: { position: { start: 0, end: 2, expectedText: "zz" } }, replacement: "X" }],
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().type).toBe("TEXT_MISMATCH");

    const oob = await patch(app, doc.id, {
      changes: [{ operation: "replace", target: { position: { start: 0, end: 99, expectedText: "abcdef" } }, replacement: "X" }],
    });
    expect(oob.json()).toMatchObject({ code: 422, type: "INVALID_RANGE" });
  });

  it("404s for a missing document", async () => {
    const res = await patch(app, "doc_nope", { changes: [quote("a", "b")] });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 404, type: "DOCUMENT_NOT_FOUND" });
  });

  it("400s for malformed JSON, invalid shapes and unsupported operations", async () => {
    const doc = await createDoc(app, "t", "abc");
    const bad = await app.inject({ method: "PATCH", url: `/documents/${doc.id}`, payload: "{not json", headers: { "content-type": "application/json" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 400 });

    for (const payload of [{}, { changes: [] }, { changes: [{ operation: "delete", target: { quote: { exact: "a" } }, replacement: "" }] }, { changes: [{ operation: "replace", target: {}, replacement: "x" }] }, { changes: [quote("a", "b")], surprise: true }]) {
      const res = await patch(app, doc.id, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().type).toBe("VALIDATION_ERROR");
    }
  });

  it("413s when the body exceeds the configured limit", async () => {
    const small = await testApp({ bodyLimit: 1024 });
    const res = await small.inject({ method: "POST", url: "/documents", payload: { title: "big", content: "x".repeat(5000) } });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 413, type: "PAYLOAD_TOO_LARGE" });
    await small.close();
  });
});

describe("versions and preconditions", () => {
  it("rejects a stale expectedVersion with 409 and does not write", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "TS")] });
    const stale = await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Term", "Duration")] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ type: "VERSION_CONFLICT", details: { expectedVersion: 1, currentVersion: 2 } });
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}` })).json().version).toBe(2);
  });

  it("supports If-Match: stale -> 412, fresh -> applies", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const etag1 = (await app.inject({ method: "GET", url: `/documents/${doc.id}` })).headers.etag as string;
    const ok = await patch(app, doc.id, { changes: [quote("Trade Secrets", "TS")] }, { "if-match": etag1 });
    expect(ok.statusCode).toBe(200);
    const stale = await patch(app, doc.id, { changes: [quote("Term", "Duration")] }, { "if-match": etag1 });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().type).toBe("PRECONDITION_FAILED");
  });

  it("rejects contradictory or malformed preconditions with 400", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const etag = (await app.inject({ method: "GET", url: `/documents/${doc.id}` })).headers.etag as string;
    const contradictory = await patch(app, doc.id, { expectedVersion: 7, changes: [quote("Term", "T")] }, { "if-match": etag });
    expect(contradictory.statusCode).toBe(400);
    expect(contradictory.json().type).toBe("CONTRADICTORY_PRECONDITIONS");
    const malformed = await patch(app, doc.id, { changes: [quote("Term", "T")] }, { "if-match": "banana" });
    expect(malformed.json().type).toBe("INVALID_PRECONDITION");
  });

  it("a replacement identical to the existing text is a no-op: 200, changed:false, no new version", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const res = await patch(app, doc.id, { changes: [quote("Trade Secrets", "Trade Secrets")] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: false, version: 1, previousVersion: 1 });
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}/revisions` })).json().items).toHaveLength(1);
  });

  it("keeps a contiguous revision history with restorable snapshots", async () => {
    const doc = await createDoc(app, "t", "one two three");
    await patch(app, doc.id, { changes: [quote("one", "1")] });
    await patch(app, doc.id, { changes: [quote("three", "3")] });
    const revs = (await app.inject({ method: "GET", url: `/documents/${doc.id}/revisions` })).json().items;
    expect(revs.map((r: { version: number }) => r.version)).toEqual([3, 2, 1]);
    const v2 = (await app.inject({ method: "GET", url: `/documents/${doc.id}/revisions/2` })).json();
    expect(v2.content).toBe("1 two three");
    expect((await app.inject({ method: "GET", url: `/documents/${doc.id}/revisions/9` })).statusCode).toBe(404);
  });
});

describe("POST /documents/:id/changes/preview", () => {
  it("returns the proposed text and a diff without persisting anything", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const res = await app.inject({ method: "POST", url: `/documents/${doc.id}/changes/preview`, payload: { expectedVersion: 1, changes: [quote("Trade Secrets", "Know-How")] } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ version: 1, wouldChange: true });
    expect(body.proposedContent).toContain("Know-How");
    expect(body.diff).toContain("-Receiving Party");
    expect(body.diff).toContain("+Receiving Party");
    const after = (await app.inject({ method: "GET", url: `/documents/${doc.id}` })).json();
    expect(after).toMatchObject({ version: 1, content: NDA });
  });

  it("surfaces the same errors as PATCH", async () => {
    const doc = await createDoc(app, "NDA", NDA);
    const res = await app.inject({ method: "POST", url: `/documents/${doc.id}/changes/preview`, payload: { changes: [quote("shall not disclose", "x")] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().type).toBe("AMBIGUOUS_TARGET");
  });
});

describe("API surface", () => {
  it("serves a generated OpenAPI document and a JSON 404", async () => {
    const spec = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(Object.keys(spec.paths)).toContain("/documents/{id}");
    const nf = await app.inject({ method: "GET", url: "/nope" });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toMatchObject({ code: 404 });
  });
});
