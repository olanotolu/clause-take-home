import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@clause/core";
import { testApp } from "./helpers.ts";
import { executeJobBatch } from "../src/jobs/runner.ts";

describe("document size boundaries",()=>{
  let directory:string;
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"clause-boundaries-"));vi.stubEnv("CLAUSE_CONTENT_DIR",directory);vi.stubEnv("BLOB_READ_WRITE_TOKEN","");});
  afterEach(async()=>{vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
  for(const mib of [1,10,25]) it(`creates, edits, previews, searches, reverts and exports ${mib} MiB of Unicode text`,async()=>{
    const bytes=mib*1048576,prefix="CLAUSE_BOUND_A\n",line="Confidential café 😀. ".repeat(160)+"\n";
    const available=bytes-Buffer.byteLength(prefix),lineBytes=Buffer.byteLength(line);
    const content=prefix+line.repeat(Math.floor(available/lineBytes))+"x".repeat(available%lineBytes);
    expect(Buffer.byteLength(content)).toBe(bytes);
    const app=await testApp({startExportWorkflow:async()=>undefined});
    try {
      const issued=(await app.inject({method:"POST",url:"/documents/uploads/intents",payload:{size:bytes}})).json();
      expect((await app.inject({method:"POST",url:`${issued.uploadUrl}?intent=${encodeURIComponent(issued.intent)}`,headers:{"content-type":"text/plain"},payload:content})).statusCode).toBe(204);
      const create=await app.inject({method:"POST",url:"/documents/uploads/complete",payload:{intent:issued.intent,title:`Unicode ${mib} MiB`,sha256:sha256(content)}});
      expect(create.statusCode,create.body.slice(0,200)).toBe(201);
      const doc=create.json();
      const load=vi.spyOn(app.store,"getRevision");
      const metadata=await app.inject({method:"GET",url:`/documents/${doc.id}`,headers:{Prefer:"return=minimal"}});
      expect(metadata.statusCode).toBe(200);expect(metadata.json().byteLength).toBe(bytes);expect(metadata.body.length).toBeLessThan(10000);
      expect(load).not.toHaveBeenCalled();load.mockRestore();
      const changes=[{operation:"replace",target:{position:{start:0,end:"CLAUSE_BOUND_A".length,expectedText:"CLAUSE_BOUND_A"}},replacement:"CLAUSE_BOUND_B"}];
      const preview=await app.inject({method:"POST",url:`/documents/${doc.id}/changes/preview`,payload:{expectedVersion:1,changes}});
      expect(preview.statusCode,preview.body.slice(0,200)).toBe(200);
      const edited=await app.inject({method:"PATCH",url:`/documents/${doc.id}`,headers:{Prefer:"return=minimal"},payload:{expectedVersion:1,changes}});
      expect(edited.statusCode,edited.body.slice(0,200)).toBe(200);expect(edited.body.length).toBeLessThan(10000);
      const expected=content.replace("CLAUSE_BOUND_A","CLAUSE_BOUND_B");
      expect(edited.json().afterHash).toBe(sha256(expected));
      const search=await app.inject({method:"GET",url:`/documents/search?q=CLAUSE_BOUND_B&mode=exact&ids=${doc.id}`});
      expect(search.statusCode).toBe(200);expect(search.json().results[0]?.matchCount).toBe(1);
      const reverted=await app.inject({method:"POST",url:`/documents/${doc.id}/revert`,headers:{Prefer:"return=minimal"},payload:{expectedVersion:2,toVersion:1}});
      expect(reverted.statusCode).toBe(200);expect(reverted.json().afterHash).toBe(doc.contentHash);
      // An older receipt must still resolve the immutable version it described.
      const pinned=edited.json().contentUrl??`/documents/${doc.id}/revisions/2/content`;
      let download=await app.inject({method:"GET",url:pinned});
      if(download.statusCode===303)download=await app.inject({method:"GET",url:download.headers.location!});
      expect(download.statusCode).toBe(200);expect(sha256(download.body)).toBe(sha256(expected));
      const exported=await app.inject({method:"GET",url:`/documents/${doc.id}/export.docx?from=1&to=2`});
      if(exported.statusCode===202) {
        await executeJobBatch(app.store,exported.json().jobId);
        const job=(await app.inject({method:"GET",url:exported.json().statusUrl})).json();
        expect(job.status,job.errorCode).toBe("succeeded");
        const file=await app.inject({method:"GET",url:job.downloadUrl});expect(file.rawPayload.subarray(0,2).toString()).toBe("PK");
      } else {expect(exported.statusCode).toBe(200);expect(exported.rawPayload.subarray(0,2).toString()).toBe("PK");}
    } finally {await app.close();}
  },300_000);
});
