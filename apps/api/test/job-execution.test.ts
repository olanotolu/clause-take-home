import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testApp, testStore } from "./helpers.ts";
import type { Store } from "../src/store/types.ts";
import { cleanupJobOutputs, executeJobBatch, transientJobError } from "../src/jobs/runner.ts";
import { newContentPath, readStoredContent, uploadToStorage } from "../src/content-storage.ts";
import { sha256 } from "@clause/core";
import { encrypt, IntegrationError } from "../src/integrations/service.ts";

describe("durable job execution",()=>{
  let store:Store;let directory:string;
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),"clause-jobs-"));vi.stubEnv("CLAUSE_CONTENT_DIR",directory);vi.stubEnv("BLOB_READ_WRITE_TOKEN","");vi.stubEnv("CLAUSE_INTEGRATION_ENCRYPTION_KEY","a".repeat(64));
    store=await testStore();
    await store.saveIntegrationConnection({provider:"google_drive",accessToken:encrypt("fixture-token"),refreshToken:null,expiresAt:new Date(Date.now()+60_000).toISOString(),accountName:null,connectedAt:new Date().toISOString()});
  });
  afterEach(async()=>{await store.close();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();vi.unstubAllGlobals();});
  const payload={kind:"provider_import",provider:"google_drive",file:{id:"source-file",name:"Fixture.txt",mimeType:"text/plain",folder:false}} as const;

  it("ignores duplicate deliveries while an import is active and commits once",async()=>{
    const started=Promise.withResolvers<void>(),download=Promise.withResolvers<Response>();
    const fetcher=vi.fn(async()=>{started.resolve();return download.promise;});vi.stubGlobal("fetch",fetcher);
    const job=(await store.createJob({kind:"provider_import",idempotencyKey:"import:fixture",payload}))!.job;
    const first=executeJobBatch(store,job.id);await started.promise;
    expect(await executeJobBatch(store,job.id)).toEqual({state:"waiting"});
    download.resolve(new Response("Confidential fixture",{headers:{"content-type":"text/plain"}}));
    expect(await first).toEqual({state:"done"});expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await store.listDocuments(10,0)).toMatchObject({total:1});
    expect((await store.getJob(job.id))?.output).toMatchObject({kind:"provider_import",imported:true,document:{title:"Fixture.txt"}});
    expect(await executeJobBatch(store,job.id)).toEqual({state:"done"});
  });

  it("cancellation during a provider download prevents a later document commit",async()=>{
    const started=Promise.withResolvers<void>(),download=Promise.withResolvers<Response>();
    vi.stubGlobal("fetch",async()=>{started.resolve();return download.promise;});
    const job=(await store.createJob({kind:"provider_import",idempotencyKey:"cancel:fixture",payload}))!.job;
    const running=executeJobBatch(store,job.id);await started.promise;await store.cancelJob(job.id);
    download.resolve(new Response("Must never commit",{headers:{"content-type":"text/plain"}}));
    await running;expect((await store.getJob(job.id))?.status).toBe("cancelled");expect((await store.listDocuments(10,0)).total).toBe(0);
  });

  it("retries transient failures while validation failures terminate immediately",async()=>{
    let calls=0;vi.stubGlobal("fetch",async()=>++calls===1?new Response("unavailable",{status:503}):new Response("Good content",{headers:{"content-type":"text/plain"}}));
    const job=(await store.createJob({kind:"provider_import",idempotencyKey:"retry:fixture",payload}))!.job;
    expect(await executeJobBatch(store,job.id)).toMatchObject({state:"retry"});
    expect(await executeJobBatch(store,job.id)).toEqual({state:"done"});expect((await store.getJob(job.id))?.status).toBe("succeeded");
    vi.stubGlobal("fetch",async()=>new Response("   ",{headers:{"content-type":"text/plain"}}));
    const invalid=(await store.createJob({kind:"provider_import",idempotencyKey:"invalid:fixture",payload:{...payload,file:{...payload.file,id:"empty-file"}}}))!.job;
    expect(await executeJobBatch(store,invalid.id)).toEqual({state:"done"});expect((await store.getJob(invalid.id))?.errorCode).toBe("EMPTY_DOCUMENT");
    expect(transientJobError(new IntegrationError(413,"TOO_LARGE","invalid"))).toBe(false);
    expect(transientJobError(Object.assign(new Error("connection"),{code:"ECONNRESET"}))).toBe(true);
  });

  it("resumes an imported immutable stage without downloading it again and removes cancelled stages",async()=>{
    const path=newContentPath(),content="Recovered provider content";
    await uploadToStorage(path,content);
    const job=(await store.createJob({kind:"provider_import",idempotencyKey:"staged:fixture",payload}))!.job;
    await store.updateJob(job.id,{checkpoint:JSON.stringify({kind:"provider_stage",contentPath:path,contentHash:sha256(content),byteLength:Buffer.byteLength(content)})});
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    expect(await executeJobBatch(store,job.id)).toEqual({state:"done"});
    expect(fetcher).not.toHaveBeenCalled();expect((await store.getJob(job.id))?.status).toBe("succeeded");
    await expect(readStoredContent(path)).rejects.toThrow();
    const cancelledPath=newContentPath();await uploadToStorage(cancelledPath,content);
    const cancelled=(await store.createJob({kind:"provider_import",idempotencyKey:"staged:cancelled",payload:{...payload,file:{...payload.file,id:"cancelled"}}}))!.job;
    await store.updateJob(cancelled.id,{checkpoint:JSON.stringify({kind:"provider_stage",contentPath:cancelledPath,contentHash:sha256(content),byteLength:Buffer.byteLength(content)})});
    await store.cancelJob(cancelled.id);await cleanupJobOutputs(store,cancelled.id);
    await expect(readStoredContent(cancelledPath)).rejects.toThrow();
  });

  it("pins export inputs to immutable revision hashes and completes once",async()=>{
    const doc=await store.insertDocument({title:"Export fixture",content:"Original clause."});
    const next=await store.commitRevision({id:doc.id,expectedVersion:1,content:"Revised clause.",summary:"[]"});
    expect(next).toBeDefined();
    const from=(await store.getRevision(doc.id,1))!,to=(await store.getRevision(doc.id,2))!;
    const outputPath=newContentPath().replace(/\.txt$/,".docx");
    const exportPayload={kind:"export",documentId:doc.id,fromVersion:1,toVersion:2,fromHash:from.contentHash,toHash:to.contentHash,outputPath} as const;
    const job=(await store.createJob({kind:"export",idempotencyKey:"export:fixture",payload:exportPayload}))!.job;
    expect(await executeJobBatch(store,job.id)).toEqual({state:"done"});
    expect((await store.getJob(job.id))?.status).toBe("succeeded");
    expect(await executeJobBatch(store,job.id)).toEqual({state:"done"});
    const invalid=(await store.createJob({kind:"export",idempotencyKey:"export:invalid",payload:{...exportPayload,fromHash:"0".repeat(64)}}))!.job;
    expect(await executeJobBatch(store,invalid.id)).toEqual({state:"done"});
    expect((await store.getJob(invalid.id))?.status).toBe("failed");
  },60_000);

  it("does not deadlock when two orphan-cleanup jobs are queued together",async()=>{
    const jobs=await Promise.all(["one","two"].map(key=>store.createJob({kind:"orphan_cleanup",idempotencyKey:`cleanup:${key}`,payload:{kind:"orphan_cleanup"}})));
    for(const created of jobs)expect(await executeJobBatch(store,created!.job.id)).toEqual({state:"done"});
    for(const created of jobs)expect((await store.getJob(created!.job.id))?.status).toBe("succeeded");
  });

  it("checkpoints maintenance and protects the operational queue routes",async()=>{
    const job=(await store.createJob({kind:"integrity_sweep",idempotencyKey:"integrity:fixture",payload:{kind:"integrity_sweep"}}))!.job;
    expect(await executeJobBatch(store,job.id)).toEqual({state:"done"});expect((await store.getJob(job.id))?.output).toMatchObject({kind:"maintenance",checked:0});
    vi.stubEnv("CLAUSE_OPERATIONS_TOKEN","b".repeat(40));
    const launched:string[]=[];const app=await testApp({startJobWorkflow:async(id)=>{launched.push(id);}});
    try {
      const request={method:"POST",url:"/jobs",payload:{kind:"orphan_cleanup",idempotencyKey:"daily"}} as const;
      expect((await app.inject(request)).statusCode).toBe(401);
      const queued=await app.inject({...request,headers:{authorization:`Bearer ${"b".repeat(40)}`}});
      expect(queued.statusCode).toBe(202);expect(launched).toHaveLength(1);
      expect((await app.inject({...request,headers:{authorization:`Bearer ${"b".repeat(40)}`}})).json().jobId).toBe(queued.json().jobId);
      expect(launched).toHaveLength(1);
    } finally {await app.close();}
  });
});
