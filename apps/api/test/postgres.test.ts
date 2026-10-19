import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import * as docs from "../src/documents.ts";
import { SEED_DOCUMENTS } from "../src/seed-data.ts";
import { createPostgresStore } from "../src/store/postgres.ts";
import { MAX_CONTENT_BYTES } from "../src/content-storage.ts";
import { runtimeDiagnostics } from "../src/telemetry.ts";
import { createDoc, TEST_PG_URL, testApp, usingPostgres } from "./helpers.ts";

/** Runs only when CLAUSE_TEST_DATABASE_URL points at a Postgres. */
describe.skipIf(!usingPostgres)("Postgres backend", () => {
  const schema = () => `t_${randomBytes(6).toString("hex")}`;

  it("uploads, indexes, and searches a document exactly at the UTF-8 byte cap", async () => {
    const app = await testApp({logger:Boolean(process.env.CLAUSE_TEST_VERBOSE)});
    const phrase="The Receiving Party shall maintain strict confidentiality. ";
    const text=phrase.repeat(Math.floor(MAX_CONTENT_BYTES/Buffer.byteLength(phrase)))+"x".repeat(MAX_CONTENT_BYTES%Buffer.byteLength(phrase));
    expect(Buffer.byteLength(text,"utf8")).toBe(MAX_CONTENT_BYTES);
    const issued=(await app.inject({method:"POST",url:"/documents/uploads/intents",payload:{size:MAX_CONTENT_BYTES}})).json();
    expect((await app.inject({method:"POST",url:`${issued.uploadUrl}?intent=${encodeURIComponent(issued.intent)}`,headers:{"content-type":"text/plain; charset=utf-8"},payload:text})).statusCode).toBe(204);
    const created=await app.inject({method:"POST",url:"/documents/uploads/complete",payload:{intent:issued.intent,title:"At the cap",sha256:(await import("@clause/core")).sha256(text)}});
    expect(created.statusCode, created.body).toBe(201);
    const d=created.json() as {id:string};
    expect((await app.store.getDocument(d.id))?.content).toBe(text);
    expect((await app.store.getRevision(d.id,1))?.content).toBe(text);
    const res = (await app.inject({ method: "GET", url: "/documents/search?q=confidentiality" })).json();
    expect(res.results[0].documentId).toBe(d.id);
    const exact = (await app.inject({ method: "GET", url: `/documents/${d.id}/search?q=Receiving%20Party&mode=exact&limit=2` })).json();
    expect(exact.result.matchCount).toBeGreaterThan(1000);
    await app.close();
  // This exact-cap integration case builds several million indexed trigrams;
  // keep it independent of the machine load used for correctness checks.
  },300_000);

  it("preserves unchanged chunk rows after an equal-length edit",async()=>{
    const name=schema(),store=await createPostgresStore({connectionString:TEST_PG_URL!,schema:name,dropSchemaOnClose:true});
    const observer=new pg.Pool({connectionString:TEST_PG_URL!,max:1});
    try {
      const content="START_A\n"+Array.from({length:300},(_,i)=>`Paragraph ${i}: confidentiality and agreement terms.\n`).join("");
      const doc=await store.insertDocument({title:"Stable index",content});
      const before=(await observer.query<{chunk_id:string;stamp:string}>(`SELECT chunk_id,xmin::text AS stamp FROM ${name}.document_chunks WHERE document_id=$1`,[doc.id])).rows;
      await store.commitRevision({id:doc.id,expectedVersion:1,content:content.replace("START_A","START_B"),summary:"[]"});
      const after=(await observer.query<{chunk_id:string;stamp:string}>(`SELECT chunk_id,xmin::text AS stamp FROM ${name}.document_chunks WHERE document_id=$1`,[doc.id])).rows;
      const stamps=new Map(before.map(x=>[x.chunk_id,x.stamp]));
      expect(after.filter(x=>stamps.get(x.chunk_id)===x.stamp).length).toBeGreaterThan(0);
      expect((await store.exactPage("START_B",{ids:[doc.id],limit:1,offset:0,hitsPerDocument:1})).items[0]?.matchCount).toBe(1);
    } finally {await observer.end();await store.close();}
  },60_000);

  it("loads the edit body only when the version and hash preconditions match",async()=>{
    const store=await createPostgresStore({connectionString:TEST_PG_URL!,schema:schema(),dropSchemaOnClose:true});
    try {
      const doc=await store.insertDocument({title:"Edit precondition",content:"Confidentiality survives."});
      const current=await store.getDocumentForEdit(doc.id,{expectedVersion:1,contentHashPrefix:doc.contentHash.slice(0,12)});
      expect(current).toHaveProperty("content","Confidentiality survives.");
      const stale=await store.getDocumentForEdit(doc.id,{expectedVersion:2});
      expect(stale).toMatchObject({version:1,contentHash:doc.contentHash});
      expect(stale).not.toHaveProperty("content");
      const wrongHashPrefix=`${doc.contentHash[0]==="0"?"1":"0"}${doc.contentHash.slice(1,12)}`;
      const mismatchedHash=await store.getDocumentForEdit(doc.id,{expectedVersion:1,contentHashPrefix:wrongHashPrefix});
      expect(mismatchedHash).toMatchObject({version:1,contentHash:doc.contentHash});
      expect(mismatchedHash).not.toHaveProperty("content");
    } finally {await store.close();}
  },60_000);

  it("rejects content one UTF-8 byte over the cap before any database write", async () => {
    const store = await createPostgresStore({ connectionString: TEST_PG_URL!, schema: schema(), dropSchemaOnClose: true });
    const content="x".repeat(MAX_CONTENT_BYTES+1);
    const r = await docs.createDocument(store, { title: "over cap", content });
    expect(r).toMatchObject({ ok: false, error: { type: "TOO_LARGE_FOR_BACKEND" } });
    expect((await store.listDocuments(10, 0)).total).toBe(0);
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

  it("records dropped idle connections instead of letting pg pool errors terminate the API",async()=>{
    let observed:pg.Pool|undefined;
    const store=await createPostgresStore({connectionString:TEST_PG_URL!,schema:schema(),dropSchemaOnClose:true,onPool:(pool)=>{observed=pool;}});
    try {
      expect(observed).toBeDefined();
      const before=runtimeDiagnostics().queryErrors;
      expect(()=>observed!.emit("error",new Error("synthetic connection failure"),{} as pg.PoolClient)).not.toThrow();
      expect(runtimeDiagnostics().queryErrors).toBe(before+1);
    } finally {await store.close();}
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

  it("preserves document-level AND and phrases that cross indexed chunk boundaries",async()=>{
    const app=await testApp();
    try {
      const marker='"shall not disclose"';
      const prefix="x ".repeat(3995);
      const text=prefix+"shall not disclose confidential alpha "+"boilerplate ".repeat(900)+"beta";
      const created=await createDoc(app,"Chunk boundary",text);
      const phrase=(await app.inject({method:"GET",url:`/documents/search?q=${encodeURIComponent(marker)}`})).json();
      expect(phrase.total).toBe(1);
      expect(phrase.results[0].documentId).toBe(created.id);
      expect(text.slice(phrase.results[0].hits[0].start,phrase.results[0].hits[0].end)).toBe("shall not disclose");
      const and=(await app.inject({method:"GET",url:"/documents/search?q=alpha%20beta"})).json();
      expect(and.total).toBe(1);
      expect(and.results[0].documentId).toBe(created.id);
    } finally {await app.close();}
  },60_000);
});
