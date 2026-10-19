import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@clause/core";
import { testApp } from "./helpers.ts";
import { readStoredContent } from "../src/content-storage.ts";
import { toHttp } from "../src/errors.ts";

describe("direct revision and preview uploads",()=>{
  let directory:string;
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"clause-upload-revision-"));vi.stubEnv("CLAUSE_CONTENT_DIR",directory);vi.stubEnv("BLOB_READ_WRITE_TOKEN","");});
  afterEach(async()=>{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
  it("commits verified replacements using CAS and keeps committed objects safe from replay",async()=>{
    const app=await testApp();
    try {
      const doc=await app.store.insertDocument({title:"Replacement",content:"Original."}),content="Confidential clause. ".repeat(100000);
      const issued=await app.inject({method:"POST",url:"/documents/uploads/intents",payload:{operation:"revision",documentId:doc.id,expectedVersion:1,size:Buffer.byteLength(content)}});
      expect(issued.statusCode).toBe(201);const intent=issued.json();
      expect((await app.inject({method:"POST",url:`${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,headers:{"content-type":"text/plain"},payload:content})).statusCode).toBe(204);
      const request={method:"POST",url:"/documents/uploads/complete",headers:{Prefer:"return=minimal"},payload:{intent:intent.intent,sha256:sha256(content)}} as const;
      const committed=await app.inject(request);expect(committed.statusCode,committed.body).toBe(200);
      expect(committed.json()).toMatchObject({version:2,afterHash:sha256(content)});expect(committed.body.length).toBeLessThan(10000);
      expect((await app.store.getRevision(doc.id,2))?.content).toBe(content);
      expect((await app.inject({...request,payload:{...request.payload,sha256:sha256("wrong")}})).statusCode).toBe(422);
      expect(await readStoredContent(intent.pathname)).toBe(content);
      expect((await app.inject(request)).statusCode).toBe(409);
      expect(await readStoredContent(intent.pathname)).toBe(content);
      expect((await app.inject({method:"POST",url:"/documents/uploads/intents",payload:{operation:"revision",documentId:doc.id,expectedVersion:1,size:10}})).statusCode).toBe(409);
    } finally {await app.close();}
  },120000);

  it("removes a verified replacement when another writer wins before completion",async()=>{
    const app=await testApp();
    try {
      const doc=await app.store.insertDocument({title:"Conflict",content:"Original."}),content="Replacement.";
      const intent=(await app.inject({method:"POST",url:"/documents/uploads/intents",payload:{operation:"revision",documentId:doc.id,expectedVersion:1,size:Buffer.byteLength(content)}})).json();
      await app.inject({method:"POST",url:`${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,headers:{"content-type":"text/plain"},payload:content});
      await app.store.commitRevision({id:doc.id,expectedVersion:1,content:"Other writer.",summary:"[]"});
      const response=await app.inject({method:"POST",url:"/documents/uploads/complete",payload:{intent:intent.intent,sha256:sha256(content)}});
      expect(response.statusCode).toBe(409);await expect(readStoredContent(intent.pathname)).rejects.toThrow();
      expect((await app.store.getDocument(doc.id))?.content).toBe("Other writer.");
      const expired=await app.inject({method:"POST",url:"/documents/uploads/complete",payload:{intent:"not-a-token",sha256:sha256(content)}});
      expect(expired.statusCode).toBe(400);expect(expired.json().type).toBe("UPLOAD_INTENT_INVALID");
    } finally {await app.close();}
  });

  it("checks an uploaded preview without creating a revision and then removes the object",async()=>{
    const app=await testApp();
    try {
      const doc=await app.store.insertDocument({title:"Preview",content:"Original."}),content="Confidential replacement.";
      await app.store.addRequirement(doc.id,{kind:"present",text:"Confidential"});
      const intent=(await app.inject({method:"POST",url:"/documents/uploads/intents",payload:{operation:"preview",documentId:doc.id,expectedVersion:1,size:Buffer.byteLength(content)}})).json();
      await app.inject({method:"POST",url:`${intent.uploadUrl}?intent=${encodeURIComponent(intent.intent)}`,headers:{"content-type":"text/plain"},payload:content});
      expect((await app.inject({method:"POST",url:"/documents/uploads/complete",payload:{intent:intent.intent,title:"Invalid commit",sha256:sha256(content)}})).statusCode).toBe(400);
      const response=await app.inject({method:"POST",url:`/documents/${doc.id}/changes/check`,payload:{expectedVersion:1,changes:[],uploadedContent:{intent:intent.intent,sha256:sha256(content)}}});
      expect(response.statusCode,response.body).toBe(200);expect(response.json().requirements[0].after.verdict).toBe("PASS");
      expect((await app.store.getDocumentMetadata(doc.id))?.version).toBe(1);await expect(readStoredContent(intent.pathname)).rejects.toThrow();
    } finally {await app.close();}
  });

  it("bounds changed spans, unified diffs and mismatch diagnostics",async()=>{
    const app=await testApp();
    try {
      const content="Boilerplate clause. ".repeat(8000),doc=await app.store.insertDocument({title:"Bounded spans",content});
      const changes=[{operation:"replace",target:{position:{start:0,end:content.length,expectedText:content}},replacement:"Short."}];
      const preview=await app.inject({method:"POST",url:`/documents/${doc.id}/changes/preview`,payload:{expectedVersion:1,changes}});
      expect(preview.statusCode).toBe(200);expect(preview.json().applied[0]).not.toHaveProperty("before");expect(preview.body.length).toBeLessThan(1024*1024);
      const response=await app.inject({method:"PATCH",url:`/documents/${doc.id}`,payload:{expectedVersion:1,changes}});
      expect(response.statusCode).toBe(200);expect(response.body.length).toBeLessThan(10000);
      expect(toHttp({type:"TEXT_MISMATCH",index:0,expected:"x".repeat(200000),actual:"y".repeat(200000)}).details?.actual).toHaveLength(4096);
    } finally {await app.close();}
  });
});
