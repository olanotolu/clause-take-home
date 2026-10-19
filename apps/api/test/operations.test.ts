import { afterEach, describe, expect, it, vi } from "vitest";
import { testApp } from "./helpers.ts";

describe("operational job API",()=>{
  afterEach(()=>vi.unstubAllEnvs());
  it("keeps liveness independent from database readiness",async()=>{
    const app=await testApp();
    app.store.checkReady=async()=>{throw new Error("database unavailable");};
    try {
      expect((await app.inject({method:"GET",url:"/health"})).statusCode).toBe(200);
      const ready=await app.inject({method:"GET",url:"/ready"});
      expect(ready.statusCode).toBe(503);
      expect(ready.json()).toEqual({status:"not_ready"});
    } finally {await app.close();}
  });
  it("bounds access, retries failed dispatches and queues the daily maintenance pair",async()=>{
    const secret="ops".repeat(16);vi.stubEnv("CLAUSE_OPERATIONS_TOKEN",secret);vi.stubEnv("CRON_SECRET",secret);
    let fail=true;const started:string[]=[];
    const app=await testApp({startJobWorkflow:async(id)=>{if(fail)throw new Error("unavailable");started.push(id);}});
    try {
      const headers={authorization:`Bearer ${secret}`};
      expect((await app.inject({method:"GET",url:"/internal/diagnostics"})).statusCode).toBe(401);
      expect((await app.inject({method:"GET",url:"/internal/diagnostics",headers})).json()).toHaveProperty("queryCount");
      const queued=await app.inject({method:"POST",url:"/jobs",headers,payload:{kind:"integrity_sweep",idempotencyKey:"retry"}});
      expect(queued.statusCode).toBe(202);expect((await app.store.getJob(queued.json().jobId))?.errorCode).toBe("WORKFLOW_START_FAILED");
      expect((await app.inject({method:"POST",url:"/jobs/dispatch",headers})).json()).toEqual({dispatched:0});
      fail=false;
      expect((await app.inject({method:"POST",url:"/jobs/dispatch",headers})).json()).toEqual({dispatched:1});
      const cron=await app.inject({method:"GET",url:"/internal/maintenance",headers});expect(cron.statusCode).toBe(202);expect(cron.json().jobs).toHaveLength(2);
      expect(started.length).toBeGreaterThan(1);
      const duplicate=await app.inject({method:"GET",url:"/internal/maintenance",headers});expect(duplicate.json().jobs.map((j:{jobId:string})=>j.jobId)).toEqual(cron.json().jobs.map((j:{jobId:string})=>j.jobId));
      for(let i=(await app.store.listPendingJobs(100)).length;i<100;i++)await app.store.createJob({kind:"integrity_sweep",payload:{kind:"integrity_sweep"},idempotencyKey:`full:${i}`});
      expect((await app.inject({method:"POST",url:"/jobs",headers,payload:{kind:"orphan_cleanup",idempotencyKey:"overflow"}})).statusCode).toBe(429);
      vi.stubEnv("CLAUSE_OPERATIONS_TOKEN","");expect((await app.inject({method:"POST",url:"/jobs/dispatch",headers})).statusCode).toBe(503);
    } finally {await app.close();}
  });
});
