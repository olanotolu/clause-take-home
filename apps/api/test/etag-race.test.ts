import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { etagOf } from "../src/documents.ts";
import type { Store } from "../src/store/types.ts";
import { createDoc, NDA, patch, quote, testStore } from "./helpers.ts";

/**
 * A PATCH or revert answers with an ETag. It must describe the version in the receipt it returns, not whatever is
 * current by the time the response is built: a second writer (or a delete) can land in between, and the old code
 * re-read the document to compute the header.
 */
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

/** Runs `then` right after the next commit succeeds and before the route continues, which is where the race lives. */
function afterNextCommit(store: Store, then: (committed: { id: string; version: number; content: string }) => Promise<void>) {
  const real = store.commitRevision.bind(store);
  let fired = false;
  store.commitRevision = async (args) => {
    const result = await real(args);
    if (result !== "conflict" && !fired) {
      fired = true;
      await then({ id: args.id, version: result.version, content: result.content });
    }
    return result;
  };
}

const expectedEtag = (r: { version: number; afterHash: string }) => etagOf({ version: r.version, contentHash: r.afterHash });

describe("response ETag matches the receipt, not a re-read", () => {
  it("PATCH: a second writer commits between our commit and the response", async () => {
    const store = await testStore();
    app = await buildApp({ store });
    const doc = await createDoc(app, "NDA", NDA);
    afterNextCommit(store, async (c) => {
      const second = await store.commitRevision({ id: c.id, expectedVersion: c.version, content: `${c.content} (second writer)`, summary: "[]" });
      expect(second).not.toBe("conflict");
    });
    const res = await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "Trade Secrets and Know-How")] });
    expect(res.statusCode).toBe(200);
    const receipt = res.json() as { version: number; afterHash: string };
    expect(receipt.version).toBe(2);
    expect(res.headers.etag).toBe(expectedEtag(receipt));
    // The document really has moved on, so a re-read would have produced a different header.
    const current = (await app.inject({ method: "GET", url: `/documents/${doc.id}` })).headers.etag;
    expect(current).toMatch(/^"v3-/);
    expect(res.headers.etag).not.toBe(current);
  });

  it("PATCH: the document is deleted between our commit and the response (200 with its own ETag, not a 500)", async () => {
    const store = await testStore();
    app = await buildApp({ store });
    const doc = await createDoc(app, "NDA", NDA);
    afterNextCommit(store, async (c) => { await store.deleteDocument(c.id); });
    const res = await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "TS")] });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(expectedEtag(res.json()));
  });

  it("revert: a second writer commits between our commit and the response", async () => {
    const store = await testStore();
    app = await buildApp({ store });
    const doc = await createDoc(app, "NDA", NDA);
    expect((await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "TS")] })).statusCode).toBe(200);
    afterNextCommit(store, async (c) => {
      const second = await store.commitRevision({ id: c.id, expectedVersion: c.version, content: `${c.content} (second writer)`, summary: "[]" });
      expect(second).not.toBe("conflict");
    });
    const res = await app.inject({ method: "POST", url: `/documents/${doc.id}/revert`, payload: { toVersion: 1, expectedVersion: 2 } });
    expect(res.statusCode).toBe(200);
    const receipt = res.json() as { version: number; afterHash: string };
    expect(receipt.version).toBe(3);
    expect(res.headers.etag).toBe(expectedEtag(receipt));
    expect(res.headers.etag).not.toBe((await app.inject({ method: "GET", url: `/documents/${doc.id}` })).headers.etag);
  });

  it("a no-op edit still names the version it read", async () => {
    app = await buildApp({ store: await testStore() });
    const doc = await createDoc(app, "NDA", NDA);
    const res = await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "Trade Secrets")] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { changed: boolean }).changed).toBe(false);
    expect(res.headers.etag).toBe(expectedEtag(res.json()));
  });
});

describe("Prefer: return=minimal", () => {
  it("omits the text from PATCH and revert receipts, keeps everything else, and says so", async () => {
    app = await buildApp({ store: await testStore() });
    const doc = await createDoc(app, "NDA", NDA);
    const full = await patch(app, doc.id, { expectedVersion: 1, changes: [quote("Trade Secrets", "TS")] });
    expect(typeof full.json().content).toBe("string");
    expect(full.headers["preference-applied"]).toBeUndefined();
    const min = await app.inject({ method: "PATCH", url: `/documents/${doc.id}`, headers: { prefer: "return=minimal" }, payload: { expectedVersion: 2, changes: [quote("TS", "Trade Secrets")] } });
    expect(min.statusCode).toBe(200);
    expect(min.headers["preference-applied"]).toBe("return=minimal");
    expect(min.json()).not.toHaveProperty("content");
    expect(min.json()).toMatchObject({ version: 3, changed: true });
    expect(min.headers.etag).toBe(expectedEtag(min.json()));
    const rev = await app.inject({ method: "POST", url: `/documents/${doc.id}/revert`, headers: { prefer: "return=minimal" }, payload: { toVersion: 1 } });
    expect(rev.statusCode).toBe(200);
    expect(rev.json()).not.toHaveProperty("content");
  });
});
