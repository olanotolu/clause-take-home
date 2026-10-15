import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openDb } from "../src/db.ts";
import * as docs from "../src/documents.ts";
import { createDoc, patch, quote, testApp } from "./helpers.ts";

let app: FastifyInstance;
beforeEach(async () => void (app = await testApp()));
afterEach(async () => void (await app.close()));

const revert = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url: `/documents/${id}/revert`, payload: body as object, headers });
const get = async (id: string) => (await app.inject({ method: "GET", url: `/documents/${id}` })).json();
const versions = async (id: string) => (await app.inject({ method: "GET", url: `/documents/${id}/revisions` })).json().items.map((r: { version: number }) => r.version);

/** v1 "alpha beta gamma" -> v2 "ALPHA beta gamma" -> v3 "ALPHA BETA gamma" */
async function threeVersions() {
  const d = await createDoc(app, "t", "alpha beta gamma");
  await patch(app, d.id, { changes: [quote("alpha", "ALPHA")] });
  await patch(app, d.id, { changes: [quote("beta", "BETA")] });
  return d.id;
}

describe("POST /documents/:id/revert", () => {
  it("restores an old version's text as a NEW version and never rewrites history", async () => {
    const id = await threeVersions();
    const res = await revert(id, { toVersion: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ content: "alpha beta gamma", previousVersion: 3, version: 4, changed: true, revertedTo: 1 });
    expect(await versions(id)).toEqual([4, 3, 2, 1]); // grew, nothing removed
    // the old snapshots are untouched
    const v3 = (await app.inject({ method: "GET", url: `/documents/${id}/revisions/3` })).json();
    expect(v3.content).toBe("ALPHA BETA gamma");
    // and the new revision records WHY it exists
    const history = (await app.inject({ method: "GET", url: `/documents/${id}/revisions` })).json().items;
    expect(history[0].summary).toEqual([{ revertedTo: 1 }]);
  });

  it("the restored text has the same hash as the version it came from", async () => {
    const id = await threeVersions();
    const v1 = (await app.inject({ method: "GET", url: `/documents/${id}/revisions/1` })).json();
    const res = (await revert(id, { toVersion: 1 })).json();
    expect(res.afterHash).toBe(v1.contentHash);
  });

  it("search follows the restored text immediately", async () => {
    const id = await threeVersions();
    const search = async (q: string) => (await app.inject({ method: "GET", url: `/documents/search?q=${q}&mode=exact` })).json().total;
    expect(await search("ALPHA")).toBe(1);
    expect(await search("gamma")).toBe(1);
    await revert(id, { toVersion: 1 });
    expect(await search("ALPHA")).toBe(0); // the text that was undone is gone from the index
    expect(await search("alpha")).toBe(1);
  });

  it("can be undone itself (a revert of a revert)", async () => {
    const id = await threeVersions();
    await revert(id, { toVersion: 1 }); // v4 == v1
    const back = await revert(id, { toVersion: 3 }); // v5 == v3
    expect(back.json()).toMatchObject({ content: "ALPHA BETA gamma", version: 5 });
    expect(await versions(id)).toEqual([5, 4, 3, 2, 1]);
  });

  it("is a no-op when the target text is already current: 200, changed:false, no new version", async () => {
    const id = await threeVersions();
    const res = await revert(id, { toVersion: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ changed: false, version: 3, previousVersion: 3 });
    expect(await versions(id)).toEqual([3, 2, 1]);
  });

  it("a no-op is detected by text, not by version number", async () => {
    const d = await createDoc(app, "t", "one two");
    await patch(app, d.id, { changes: [quote("one", "1")] }); // v2 "1 two"
    await patch(app, d.id, { changes: [quote("1", "one")] }); // v3 "one two" == v1
    const res = await revert(d.id, { toVersion: 1 });
    expect(res.json()).toMatchObject({ changed: false, version: 3 });
  });

  it("404s for a missing document or a version that never existed", async () => {
    const id = await threeVersions();
    expect((await revert("doc_nope", { toVersion: 1 })).json()).toMatchObject({ code: 404, type: "DOCUMENT_NOT_FOUND" });
    expect((await revert(id, { toVersion: 99 })).json()).toMatchObject({ code: 404, type: "REVISION_NOT_FOUND" });
    expect(await versions(id)).toEqual([3, 2, 1]);
  });

  it("400s for a malformed body", async () => {
    const id = await threeVersions();
    for (const body of [{}, { toVersion: 0 }, { toVersion: 1.5 }, { toVersion: "1" }, { toVersion: 1, surprise: true }]) {
      const res = await revert(id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("honours expectedVersion and If-Match like any other write", async () => {
    const id = await threeVersions();
    const stale = await revert(id, { toVersion: 1, expectedVersion: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ type: "VERSION_CONFLICT", details: { expectedVersion: 2, currentVersion: 3 } });

    const staleTag = await revert(id, { toVersion: 1 }, { "if-match": '"v2-000000000000"' });
    expect(staleTag.statusCode).toBe(412);

    const etag = (await app.inject({ method: "GET", url: `/documents/${id}` })).headers.etag as string;
    const ok = await revert(id, { toVersion: 1, expectedVersion: 3 }, { "if-match": etag });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toMatch(/^"v4-/);
    expect(await versions(id)).toEqual([4, 3, 2, 1]);
  });

  it("restores the right text after an edit that came later (undo only my change by restoring before it)", async () => {
    const id = await threeVersions();
    expect((await get(id)).content).toBe("ALPHA BETA gamma");
    await revert(id, { toVersion: 2 });
    expect((await get(id)).content).toBe("ALPHA beta gamma");
  });
});

describe("revert races with another writer", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "clause-revert-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a revert prepared against a stale version is refused and the other writer's edit survives", () => {
    const a = openDb(join(dir, "t.db"));
    const b = openDb(join(dir, "t.db"));
    const doc = docs.createDocument(a, { title: "t", content: "alpha beta" });
    docs.apply(a, doc.id, { changes: [quote("alpha", "ALPHA")] }); // v2

    // Writer B decides to revert to v1 while looking at v2...
    // ...but writer A commits v3 first.
    docs.apply(a, doc.id, { expectedVersion: 2, changes: [quote("beta", "BETA")] });
    const late = docs.revert(b, doc.id, { toVersion: 1, expectedVersion: 2 });

    expect(late).toEqual({ ok: false, error: { type: "VERSION_CONFLICT", expectedVersion: 2, currentVersion: 3 } });
    expect(docs.revert(b, doc.id, { toVersion: 1, expectedVersion: 3 }).ok).toBe(true); // retry with fresh version works
    a.close();
    b.close();
  });
});
