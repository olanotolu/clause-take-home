import { afterEach,describe,expect,it } from "vitest";
import type { Store } from "../src/store/types.ts";
import { testApp, testStore } from "./helpers.ts";

describe("persistent job queue",()=>{
  let store:Store|undefined;
  afterEach(async()=>{await store?.close();store=undefined;});

  it("deduplicates requests and refuses work beyond the 100 item queue cap",async()=>{
    store=await testStore();
    const first=await store.createJob({idempotencyKey:"export:one",kind:"export"});
    const retry=await store.createJob({idempotencyKey:"export:one",kind:"export"});
    expect(first?.created).toBe(true);
    expect(retry).toMatchObject({created:false,job:{id:first!.job.id,status:"queued"}});
    for(let i=1;i<100;i++) expect(await store.createJob({idempotencyKey:`export:${i}`,kind:"export"})).toBeDefined();
    expect(await store.createJob({idempotencyKey:"export:overflow",kind:"export"})).toBeUndefined();
  });

  it("limits active jobs to two and prevents completion after cancellation",async()=>{
    store=await testStore();
    const jobs=await Promise.all([0,1,2].map((i)=>store!.createJob({idempotencyKey:`job:${i}`,kind:"export"})));
    const claimed=await Promise.all(jobs.map((job)=>store!.claimJob(job!.job.id,2)));
    expect(claimed.filter(Boolean)).toHaveLength(2);
    const running=jobs[claimed.findIndex(Boolean)]!.job;
    expect((await store.getJob(running.id))?.status).toBe("running");
    await store.cancelJob(running.id);
    expect(await store.completeJob(running.id,"content/output.docx",new Date(Date.now()+60_000).toISOString())).toBe(false);
    expect((await store.getJob(running.id))?.status).toBe("cancelled");
  });

  it("completes a claimed job with a reference, never a signed URL",async()=>{
    store=await testStore();
    const created=await store.createJob({idempotencyKey:"export:complete",kind:"export"});
    expect(await store.claimJob(created!.job.id,2)).toBe(true);
    const expiresAt=new Date(Date.now()+24*60*60*1000).toISOString();
    expect(await store.completeJob(created!.job.id,"content/immutable.docx",expiresAt)).toBe(true);
    expect(await store.getJob(created!.job.id)).toMatchObject({status:"succeeded",progress:100,resultRef:"content/immutable.docx",expiresAt});
  });

  it("returns a durable export handle for large revision pairs",async()=>{
    const started:{jobId:string;documentId:string;fromVersion:number;toVersion:number}[]=[];
    const app=await testApp({startExportWorkflow:async(args)=>{started.push(args);}});
    try {
      const body="x".repeat(1024*1024+1);
      const doc=await app.store.insertDocument({title:"Large agreement",content:body});
      await app.store.commitRevision({id:doc.id,expectedVersion:1,content:`${body} updated`,summary:"[]"});
      const first=await app.inject({method:"GET",url:`/documents/${doc.id}/export.docx?from=1&to=2`});
      const second=await app.inject({method:"GET",url:`/documents/${doc.id}/export.docx?from=1&to=2`});
      expect(first.statusCode,first.body).toBe(202);
      expect(second.json().jobId).toBe(first.json().jobId);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({documentId:doc.id,fromVersion:1,toVersion:2});
      expect((await app.inject({method:"GET",url:first.json().statusUrl})).json()).toMatchObject({status:"queued",progress:0});
    } finally { await app.close(); }
  },120_000);
});
