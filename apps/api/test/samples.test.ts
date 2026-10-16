import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { SEED_DOCUMENTS } from "../src/seed-data.ts";
import { sha256 } from "@clause/core";
import { createSqliteStore } from "../src/store/sqlite.ts";
import { createDoc, NDA, patch, quote, testStore, usingPostgres } from "./helpers.ts";

/**
 * The five sample contracts are what a reviewer opens first on a shared demo, so they must survive anyone's edits:
 * read-only through the API (403 SAMPLE_READ_ONLY), restorable by the server if one goes missing, and copyable so the
 * whole edit / conflict / history flow can be tried on a disposable document.
 */
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function withSamples() {
  const store = await testStore();
  await store.ensureSamples(SEED_DOCUMENTS);
  app = await buildApp({ store });
  const sample = (await store.listDocuments(10, 0)).items.find((d) => d.sample && d.title.startsWith("Mutual NDA"))!;
  return { store, app, sample };
}

describe("ensureSamples (store)", () => {
  it("creates the five samples once, and is idempotent", async () => {
    const store = await testStore();
    try {
      expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(5);
      expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(0);
      const { items, total } = await store.listDocuments(20, 0);
      expect(total).toBe(5);
      expect(items.every((d) => d.sample)).toBe(true);
    } finally { await store.close(); }
  });

  it("restores a sample that is deleted underneath it, without touching the rest", async () => {
    const store = await testStore();
    try {
      await store.ensureSamples(SEED_DOCUMENTS);
      const gone = (await store.listDocuments(10, 0)).items[0]!;
      expect(await store.deleteDocument(gone.id)).toBe(true);
      expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(1);
      const after = (await store.listDocuments(10, 0)).items;
      expect(after).toHaveLength(5);
      expect(after.filter((d) => d.title === gone.title)).toHaveLength(1);
    } finally { await store.close(); }
  });

  it("adopts an existing unmarked document only if its text is exactly the canonical text", async () => {
    const store = await testStore();
    try {
      const canonical = SEED_DOCUMENTS[0]!;
      const exact = await store.insertDocument({ title: canonical.title, content: canonical.content });
      const edited = await store.insertDocument({ title: SEED_DOCUMENTS[1]!.title, content: `${SEED_DOCUMENTS[1]!.content}\nEdited.` });
      expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(5);
      const items = (await store.listDocuments(20, 0)).items;
      expect(items.find((d) => d.id === exact.id)?.sample).toBe(true); // adopted, no duplicate
      expect(items.filter((d) => d.title === canonical.title)).toHaveLength(1);
      expect(items.find((d) => d.id === edited.id)?.sample).toBeFalsy(); // different text: left alone
      expect(items.filter((d) => d.title === SEED_DOCUMENTS[1]!.title)).toHaveLength(2); // plus a fresh canonical sample
      expect(sha256(exact.content)).toBe(exact.contentHash);
    } finally { await store.close(); }
  });

  it("pins samples first, so many disposable documents never push them off the list", async () => {
    const store = await testStore();
    try {
      await store.ensureSamples(SEED_DOCUMENTS);
      for (let i = 0; i < 7; i++) await store.insertDocument({ title: `Scratch ${i}`, content: "x" });
      const page = await store.listDocuments(5, 0);
      expect(page.total).toBe(12);
      expect(page.items).toHaveLength(5);
      expect(page.items.every((d) => d.sample)).toBe(true);
    } finally { await store.close(); }
  });
});

describe("samples are read-only through the API", () => {
  it("refuses every write with 403 SAMPLE_READ_ONLY and leaves the version alone", async () => {
    const { store, app: a, sample } = await withSamples();
    const playbook = await store.insertPlaybook({ name: "P", description: "" });
    const refused = [
      await patch(a, sample.id, { expectedVersion: 1, changes: [quote("MUTUAL", "BILATERAL")] }),
      await a.inject({ method: "POST", url: `/documents/${sample.id}/revert`, payload: { toVersion: 1 } }),
      await a.inject({ method: "DELETE", url: `/documents/${sample.id}` }),
      await a.inject({ method: "POST", url: `/documents/${sample.id}/requirements`, payload: { kind: "absent", text: "perpetual" } }),
      await a.inject({ method: "POST", url: `/documents/${sample.id}/apply-playbook`, payload: { playbookId: playbook.id } }),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 403, type: "SAMPLE_READ_ONLY" });
    }
    const req = (await store.listRequirements(sample.id))[0];
    if (req) {
      const del = await a.inject({ method: "DELETE", url: `/documents/${sample.id}/requirements/${req.id}` });
      expect(del.statusCode).toBe(403);
    }
    expect((await store.getDocument(sample.id))?.version).toBe(1);
  });

  it("still lets you preview, check, search and read a sample", async () => {
    const { app: a, sample } = await withSamples();
    const preview = await a.inject({ method: "POST", url: `/documents/${sample.id}/changes/preview`, payload: { changes: [quote("MUTUAL", "BILATERAL")] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().wouldChange).toBe(true);
    expect((await a.inject({ method: "POST", url: `/documents/${sample.id}/changes/check`, payload: { changes: [quote("MUTUAL", "BILATERAL")] } })).statusCode).toBe(200);
    expect((await a.inject({ method: "GET", url: `/documents/${sample.id}` })).json()).toMatchObject({ id: sample.id, sample: true });
    expect((await a.inject({ method: "GET", url: "/documents/search?q=confidential&mode=words" })).statusCode).toBe(200);
  });

  it("marks samples in the list, and not ordinary documents", async () => {
    const { app: a } = await withSamples();
    const mine = await createDoc(a, "Mine", NDA);
    const items = (await a.inject({ method: "GET", url: "/documents" })).json().items as { id: string; sample?: boolean }[];
    expect(items.filter((d) => d.sample)).toHaveLength(5);
    expect(items.find((d) => d.id === mine.id)?.sample).toBeFalsy();
  });
});

describe("POST /documents/:id/copy", () => {
  it("copies a sample's text and requirements into a normal, editable document", async () => {
    const { store, app: a, sample } = await withSamples();
    const reqs = await store.listRequirements(sample.id);
    const res = await a.inject({ method: "POST", url: `/documents/${sample.id}/copy`, payload: {} });
    expect(res.statusCode).toBe(201);
    const copy = res.json() as { id: string; title: string; content: string; version: number; sample?: boolean };
    expect(res.headers.location).toBe(`/documents/${copy.id}`);
    expect(res.headers.etag).toMatch(/^"v1-/);
    expect(copy).toMatchObject({ title: `${sample.title} (copy)`, version: 1 });
    expect(copy.sample).toBeFalsy();
    expect(copy.content).toBe((await store.getDocument(sample.id))!.content);
    expect(await store.listRequirements(copy.id)).toHaveLength(reqs.length);
    // The copy is a normal document: edit, conflict, delete all work.
    const first = await patch(a, copy.id, { expectedVersion: 1, changes: [quote("MUTUAL", "BILATERAL")] });
    expect(first.statusCode).toBe(200);
    expect((await patch(a, copy.id, { expectedVersion: 1, changes: [quote("BILATERAL", "RECIPROCAL")] })).statusCode).toBe(409);
    expect((await a.inject({ method: "DELETE", url: `/documents/${copy.id}` })).statusCode).toBe(204);
    expect((await store.getDocument(sample.id))?.version).toBe(1);
  });

  it("takes a title, and answers 404 for a document that does not exist", async () => {
    const { app: a, sample } = await withSamples();
    const named = await a.inject({ method: "POST", url: `/documents/${sample.id}/copy`, payload: { title: "My NDA" } });
    expect(named.json().title).toBe("My NDA");
    const missing = await a.inject({ method: "POST", url: "/documents/doc_nope/copy", payload: {} });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ type: "DOCUMENT_NOT_FOUND" });
  });
});

describe("migration of an existing database", () => {
  it.skipIf(usingPostgres)("a SQLite database from before sample keys migrates in place, keeps its documents, and adopts a canonical sample", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clause-mig-"));
    const file = join(dir, "old.db");
    try {
      const first = createSqliteStore(file);
      const canonical = SEED_DOCUMENTS[0]!;
      const sample = await first.insertDocument({ title: canonical.title, content: canonical.content });
      const mine = await first.insertDocument({ title: "Mine", content: "my text" });
      await first.close();
      // Put the file back the way the previous release left it: no sample_key column, schema version 5.
      const raw = new DatabaseSync(file);
      raw.exec("DROP INDEX documents_sample_key_idx; ALTER TABLE documents DROP COLUMN sample_key; PRAGMA user_version = 5;");
      raw.close();

      const upgraded = createSqliteStore(file);
      expect((await upgraded.getDocument(mine.id))?.content).toBe("my text");
      expect(await upgraded.ensureSamples(SEED_DOCUMENTS)).toBe(5);
      const items = (await upgraded.listDocuments(20, 0)).items;
      expect(items.find((d) => d.id === sample.id)?.sample).toBe(true); // adopted in place, not duplicated
      expect(items.filter((d) => d.title === canonical.title)).toHaveLength(1);
      expect(items.find((d) => d.id === mine.id)?.sample).toBeFalsy();
      await upgraded.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
