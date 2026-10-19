import { recordJobQueueAge } from "../telemetry.ts";
import { createHash, randomUUID } from "node:crypto";
import { sha256 } from "@clause/core";
import { z } from "zod";
import type { Store } from "../store/types.ts";
import { extractText, IntegrationError } from "../integrations/service.ts";
import { INLINE_CONTENT_BYTES, MAX_CONTENT_BYTES, newContentPath, readStoredBuffer, removeStoredContent, uploadDownload, uploadToStorage } from "../content-storage.ts";
import { redlineOffThread } from "./export-worker.ts";
import { cleanupBatch, initialProgress, MaintenanceCheckpoint, requireRunning, snapshotBatch, verifyObject } from "../content-maintenance.ts";
import { JobCancelledError, type JobPayload } from "./types.ts";

export type BatchResult={state:"done"|"continue"|"waiting"}|{state:"retry";code:string};
const Stage=z.object({kind:z.literal("provider_stage"),contentPath:z.string(),contentHash:z.string(),byteLength:z.number()});

export function transientJobError(error:unknown):boolean {
  if(error instanceof IntegrationError) return error.status>=500;
  if(!(error instanceof Error)) return false;
  const code="code" in error?String(error.code):"";
  return ["ECONNRESET","ETIMEDOUT","ECONNREFUSED","EAI_AGAIN","57P01","53300","40001","40P01"].includes(code)||code.startsWith("08")||error.name==="TimeoutError";
}

async function providerImport(store:Store,jobId:string,payload:Extract<JobPayload,{kind:"provider_import"}>):Promise<void> {
  const prior=await store.getIntegrationImport(payload.provider,payload.file.id);
  const existing=prior?await store.getDocumentMetadata(prior.documentId):undefined;
  if(existing) { await store.finishJob(jobId,{kind:"provider_import",imported:false,document:{id:existing.id,title:existing.title,version:existing.version}}); return; }
  const checkpoint=(await store.getJob(jobId))?.checkpoint;
  let stage=checkpoint?Stage.parse(JSON.parse(checkpoint)):undefined;
  if(!stage) {
    const content=await extractText(store,payload.provider,payload.file);
    if(!content.trim()) throw new IntegrationError(415,"EMPTY_DOCUMENT","No readable text was found in this file.");
    if(Buffer.byteLength(content,"utf8")>MAX_CONTENT_BYTES) throw new IntegrationError(413,"DOCUMENT_TOO_LARGE","This file exceeds the 25 MiB document limit.");
    await requireRunning(store,jobId);
    stage={kind:"provider_stage",contentPath:newContentPath(),contentHash:sha256(content),byteLength:Buffer.byteLength(content,"utf8")};
    try {
      await uploadToStorage(stage.contentPath,content);
      await verifyObject(stage);
      await requireRunning(store,jobId);
      await store.updateJob(jobId,{checkpoint:JSON.stringify(stage),progress:55});
    } catch(error) {
      if(!await store.isContentReferenced(stage.contentPath)) await removeStoredContent(stage.contentPath).catch(()=>undefined);
      throw error;
    }
  }
  const content=await verifyObject(stage);
  await requireRunning(store,jobId);
  const result=await store.insertImportedDocument({title:payload.file.name,content,provider:payload.provider,fileId:payload.file.id,jobId,...(stage.byteLength>INLINE_CONTENT_BYTES?{contentPath:stage.contentPath}:{})});
  await store.finishJob(jobId,{kind:"provider_import",imported:result.imported,document:{id:result.doc.id,title:result.doc.title,version:result.doc.version}});
  if(!await store.isContentReferenced(stage.contentPath)) await removeStoredContent(stage.contentPath);
}

async function exportDocument(store:Store,jobId:string,payload:Extract<JobPayload,{kind:"export"}>):Promise<void> {
  const doc=await store.getDocumentMetadata(payload.documentId);
  const from=await store.getRevision(payload.documentId,payload.fromVersion);
  const to=await store.getRevision(payload.documentId,payload.toVersion);
  if(!doc||!from||!to||from.contentHash!==payload.fromHash||to.contentHash!==payload.toHash) throw new Error("REVISION_MISSING_OR_CHANGED");
  await store.updateJob(jobId,{progress:30});
  const buffer=await redlineOffThread({title:doc.title,from,to},async()=>(await store.getJob(jobId))?.status==="cancelled");
  await requireRunning(store,jobId);
  await store.updateJob(jobId,{progress:75});
  // A replay may find an uncommitted output from an earlier attempt. The lease
  // permits only this executor to replace it, and committed results are terminal.
  await removeStoredContent(payload.outputPath).catch(()=>undefined);
  await uploadDownload(payload.outputPath,buffer);
  if(createHash("sha256").update(await readStoredBuffer(payload.outputPath,process.env,false)).digest("hex")!==createHash("sha256").update(buffer).digest("hex")) throw new Error("EXPORT_INTEGRITY_FAILED");
  await requireRunning(store,jobId);
  if(!await store.completeJob(jobId,payload.outputPath,new Date(Date.now()+24*60*60*1000).toISOString()) && !await store.isContentReferenced(payload.outputPath)) await removeStoredContent(payload.outputPath);
}

export async function cleanupJobOutputs(store:Store,jobId:string):Promise<void> {
  const job=await store.getJob(jobId);
  if(!job||!["cancelled","failed"].includes(job.status)) return;
  const stage=job.checkpoint?Stage.safeParse(JSON.parse(job.checkpoint)):undefined;
  const paths=[...(job.payload?.kind==="export"?[job.payload.outputPath]:[]),...(stage?.success?[stage.data.contentPath]:[])];
  for(const path of paths) if(!await store.isContentReferenced(path)) await removeStoredContent(path).catch(()=>undefined);
}

export async function executeJobBatch(store:Store,jobId:string):Promise<BatchResult> {
  const job=await store.getJob(jobId);
  if(!job||["succeeded","failed","cancelled"].includes(job.status)) return {state:"done"};
  recordJobQueueAge(job.kind,job.createdAt);
  if(!await store.claimJob(jobId,2)) return {state:"waiting"};
  const owner=randomUUID();
  if(!await store.leaseJob(jobId,owner)) return {state:"waiting"};
  try {
    const payload=job.payload;
    if(!payload) throw new Error("JOB_PAYLOAD_MISSING");
    await requireRunning(store,jobId);
    switch(payload.kind) {
      case "export": await exportDocument(store,jobId,payload); return {state:"done"};
      case "provider_import": await providerImport(store,jobId,payload); return {state:"done"};
      case "content_backfill":
      case "integrity_sweep":
      case "orphan_cleanup": {
        if(payload.kind==="orphan_cleanup"&&await store.hasOtherActiveJobs(jobId)) return {state:"waiting"};
        const progress=job.checkpoint?MaintenanceCheckpoint.parse(JSON.parse(job.checkpoint)):initialProgress();
        const next=payload.kind==="orphan_cleanup"?await cleanupBatch(store,progress,jobId):await snapshotBatch(store,payload.kind,progress,jobId);
        await store.updateJob(jobId,{checkpoint:JSON.stringify(next),progress:Math.min(95,10+Math.floor(next.checked/4))});
        if(next.done) { await store.finishJob(jobId,{kind:"maintenance",checked:next.checked,changed:next.changed}); return {state:"done"}; }
        return {state:"continue"};
      }
      default: { const exhaustive:never=payload; throw new Error(`Unsupported job ${exhaustive}`); }
    }
  } catch(error) {
    if(error instanceof JobCancelledError) return {state:"done"};
    const code=error instanceof IntegrationError?error.code:"JOB_EXECUTION_FAILED";
    if(transientJobError(error)) return {state:"retry",code};
    await store.failJob(jobId,code);
    return {state:"done"};
  } finally {
    await store.releaseJob(jobId,owner);
    await cleanupJobOutputs(store,jobId);
  }
}
