import { runtimeDiagnostics } from "../telemetry.ts";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { App } from "../types.ts";
import { IntegrationError } from "../integrations/service.ts";
import type { JobPayload } from "../jobs/types.ts";

function authorize(header:string|undefined,secret:string|undefined):void {
  if(!secret||secret.length<32) throw new IntegrationError(503,"OPERATIONS_DISABLED","Configure an operations token with at least 32 characters.");
  const value=header?.startsWith("Bearer ")?header.slice(7):"";
  if(Buffer.byteLength(value)!==Buffer.byteLength(secret)||!timingSafeEqual(Buffer.from(value),Buffer.from(secret))) throw new IntegrationError(401,"OPERATIONS_AUTH_REQUIRED","An operations token is required.");
}

export async function queueJob(app:App,payload:JobPayload,idempotencyKey:string) {
  const created=await app.store.createJob({kind:payload.kind,payload,idempotencyKey});
  if(!created) throw new IntegrationError(429,"JOB_QUEUE_FULL","The job queue is full. Try again shortly.");
  if(created.created) {
    try { await app.startJobWorkflow(created.job.id); }
    catch { await app.store.updateJob(created.job.id,{errorCode:"WORKFLOW_START_FAILED"}); }
  }
  return {jobId:created.job.id,status:created.job.status,statusUrl:`/jobs/${created.job.id}`};
}

export function registerJobRoutes(app:App):void {
  app.get("/internal/diagnostics",async(req)=>{authorize(req.headers.authorization,process.env.CLAUSE_OPERATIONS_TOKEN);return runtimeDiagnostics();});
  app.post("/jobs",{schema:{body:z.strictObject({kind:z.enum(["content_backfill","integrity_sweep","orphan_cleanup"]),idempotencyKey:z.string().min(1).max(200)})}},async(req,reply)=>{
    authorize(req.headers.authorization,process.env.CLAUSE_OPERATIONS_TOKEN);
    const result=await queueJob(app,{kind:req.body.kind},`${req.body.kind}:${req.body.idempotencyKey}`);
    return reply.code(202).header("Location",result.statusUrl).send(result);
  });
  app.post("/jobs/dispatch",async(req)=>{
    authorize(req.headers.authorization,process.env.CLAUSE_OPERATIONS_TOKEN);
    let dispatched=0;
    for(const job of await app.store.listPendingJobs(100)) {
      if(!job.payload) continue;
      try { await app.startJobWorkflow(job.id); dispatched++; }
      catch { await app.store.updateJob(job.id,{errorCode:"WORKFLOW_START_FAILED"}); }
    }
    return {dispatched};
  });
  app.get("/internal/maintenance",async(req,reply)=>{
    authorize(req.headers.authorization,process.env.CRON_SECRET);
    const day=new Date().toISOString().slice(0,10);
    const jobs=[];
    for(const kind of ["integrity_sweep","orphan_cleanup"] as const) jobs.push(await queueJob(app,{kind},`${kind}:${day}`));
    for(const job of await app.store.listPendingJobs(100)) if(job.payload) await app.startJobWorkflow(job.id).catch(()=>undefined);
    return reply.code(202).send({jobs});
  });
}
