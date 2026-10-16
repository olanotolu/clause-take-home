import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import * as docs from "../src/documents.ts";
import { SEED_DOCUMENTS } from "../src/seed-data.ts";
import { createPostgresStore, POSTGRES_MAX_CONTENT_CHARS } from "../src/store/postgres.ts";
import { createDoc, patch, quote, TEST_PG_URL, testApp, usingPostgres } from "./helpers.ts";

/** Runs only when CLAUSE_TEST_DATABASE_URL points at a Postgres. */
describe.skipIf(!usingPostgres)("Postgres backend", () => {
  const schema = () => `t_${randomBytes(6).toString("hex")}`;

  it("indexes and searches a document exactly at the character cap", async () => {
    const app = await testApp();
    const text = "The Receiving Party shall maintain strict confidentiality. ".repeat(9091).slice(0, POSTGRES_MAX_CONTENT_CHARS);
    expect(text.length).toBe(POSTGRES_MAX_CONTENT_CHARS);
    const d = await createDoc(app, "At the cap", text);
    const res = (await app.inject({ method: "GET", url: "/documents/search?q=confidentiality" })).json();
    expect(res.results[0].documentId).toBe(d.id);
    const exact = (await app.inject({ method: "GET", url: `/documents/${d.id}/search?q=Receiving%20Party&mode=exact&limit=2` })).json();
    expect(exact.result.matchCount).toBeGreaterThan(1000);
    await app.close();
  });

  it("refuses text over the cap with 413, on create and on an edit that would grow past it, changing nothing", async () => {
    const app = await testApp();
    const tooBig = await app.inject({ method: "POST", url: "/documents", payload: { title: "big", content: "x".repeat(POSTGRES_MAX_CONTENT_CHARS + 1) } });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json()).toMatchObject({ code: 413, type: "TOO_LARGE_FOR_BACKEND" });

    const d = await createDoc(app, "near", "MARK " + "y".repeat(POSTGRES_MAX_CONTENT_CHARS - 10));
    const grow = await patch(app, d.id, { changes: [quote("MARK", "z".repeat(50))] });
    expect(grow.statusCode).toBe(413);
    expect((await app.inject({ method: "GET", url: `/documents/${d.id}` })).json()).toMatchObject({ version: 1 });
    await app.close();
  });

  it("maps the database's own tsvector limit to the same clean 413 instead of a 500", async () => {
    // Lift our cap so the DATABASE'S limit is what refuses (~690k chars of all-unique words overflows a tsvector).
    const store = await createPostgresStore({ connectionString: TEST_PG_URL!, schema: schema(), dropSchemaOnClose: true, maxContentChars: 5_000_000 });
    const words: string[] = [];
    for (let n = 0, len = 0; len < 900_000; n++) {
      const w = `w${n.toString(36)}q`;
      words.push(w);
      len += w.length + 1;
    }
    const r = await docs.createDocument(store, { title: "pathological", content: words.join(" ") });
    expect(r).toMatchObject({ ok: false, error: { type: "TOO_LARGE_FOR_BACKEND" } });
    expect((await store.listDocuments(10, 0)).total).toBe(0); // nothing half-written
    await store.close();
  });

  it("a query made only of stop words returns no results rather than an error", async () => {
    const app = await testApp();
    await createDoc(app, "NDA", "The agreement is for the benefit of the parties.");
    const res = await app.inject({ method: "GET", url: "/documents/search?q=the" });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(0);
    await app.close();
  });

  it("several instances starting at once migrate a fresh database exactly once (advisory lock)", async () => {
    const name = schema();
    // Create the schema up front: `CREATE SCHEMA IF NOT EXISTS` itself races (test scaffolding, not production), and
    // the thing under test is the MIGRATION racing on an empty schema.
    const boot = new pg.Pool({ connectionString: TEST_PG_URL!, max: 1 });
    await boot.query(`CREATE SCHEMA ${name}`);
    await boot.end();
    const opts = { connectionString: TEST_PG_URL!, schema: name, max: 2 };
    const stores = await Promise.all([createPostgresStore(opts), createPostgresStore(opts), createPostgresStore(opts)]);
    const d = await stores[0]!.insertDocument({ title: "t", content: "shared" });
    expect((await stores[2]!.getDocument(d.id))?.content).toBe("shared");
    await Promise.all(stores.map((s) => s.close()));
    const cleaner = await createPostgresStore({ ...opts, dropSchemaOnClose: true });
    await cleaner.close();
  });

  it("several cold starts seeding at once produce exactly one copy of the sample data", async () => {
    const name = schema();
    const boot = new pg.Pool({ connectionString: TEST_PG_URL!, max: 1 });
    await boot.query(`CREATE SCHEMA ${name}`);
    await boot.end();
    const opts = { connectionString: TEST_PG_URL!, schema: name, max: 2 };
    const stores = await Promise.all([createPostgresStore(opts), createPostgresStore(opts), createPostgresStore(opts), createPostgresStore(opts)]);
    const inserted = await Promise.all(stores.map((s) => s.ensureSamples(SEED_DOCUMENTS)));
    expect(inserted.sort()).toEqual([0, 0, 0, 5]); // one winner, three no-ops (the advisory lock and the unique sample key)
    expect((await stores[0]!.listDocuments(50, 0)).total).toBe(5);
    await Promise.all(stores.map((s) => s.close()));
    const cleaner = await createPostgresStore({ ...opts, dropSchemaOnClose: true });
    await cleaner.close();
  });

  it("relevance is a positive number and a title match outranks a body-only match", async () => {
    const app = await testApp();
    const body = await createDoc(app, "Unrelated", "The vendor will provide indemnification when asked.");
    const title = await createDoc(app, "Indemnification Agreement", "Boilerplate text.");
    const res = (await app.inject({ method: "GET", url: "/documents/search?q=indemnification" })).json();
    expect(res.results.map((r: { documentId: string }) => r.documentId)).toEqual([title.id, body.id]);
    expect(res.results[0].relevance).toBeGreaterThan(0);
    await app.close();
  });
});
