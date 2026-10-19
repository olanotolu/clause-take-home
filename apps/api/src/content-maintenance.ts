import { countWords, sha256 } from "@clause/core";
import { z } from "zod";
import type { Store } from "./store/types.ts";
import { JobCancelledError, type SnapshotCursor, type SnapshotObject } from "./jobs/types.ts";
import { INLINE_CONTENT_BYTES, listContentObjects, newContentPath, readStoredContent, removeStoredContent, uploadToStorage } from "./content-storage.ts";

export const MaintenanceCheckpoint = z.object({cursor:z.object({documentId:z.string(),version:z.number().int()}).optional(),objectCursor:z.string().optional(),checked:z.number().default(0),changed:z.number().default(0),done:z.boolean().default(false)});
export type MaintenanceProgress=z.infer<typeof MaintenanceCheckpoint>;
export const initialProgress=():MaintenanceProgress=>({checked:0,changed:0,done:false});

export async function requireRunning(store:Store,jobId?:string):Promise<void> {
  if(jobId && (await store.getJob(jobId))?.status!=="running") throw new JobCancelledError();
}

export async function verifyObject(ref:Pick<SnapshotObject,"contentPath"|"contentHash"|"byteLength">):Promise<string> {
  const content=await readStoredContent(ref.contentPath,process.env,false);
  if(sha256(content)!==ref.contentHash||Buffer.byteLength(content,"utf8")!==ref.byteLength) throw new Error("CONTENT_INTEGRITY_FAILED");
  return content;
}

export async function snapshotBatch(store:Store,kind:"content_backfill"|"integrity_sweep",progress:MaintenanceProgress,jobId?:string):Promise<MaintenanceProgress> {
  const page=await store.snapshotPage(progress.cursor,4);
  const next={...progress};
  for(const item of page) {
    await requireRunning(store,jobId);
    if(kind==="integrity_sweep") {
      if(item.contentPath) await verifyObject({...item,contentPath:item.contentPath});
      else {
        const rev=await store.getRevision(item.documentId,item.version);
        if(!rev||sha256(rev.content)!==item.contentHash) throw new Error("CONTENT_INTEGRITY_FAILED");
      }
    } else if(item.byteLength>INLINE_CONTENT_BYTES) {
      const rev=await store.getRevision(item.documentId,item.version);
      if(!rev||sha256(rev.content)!==item.contentHash) throw new Error("CONTENT_INTEGRITY_FAILED");
      const contentPath=item.contentPath??newContentPath();
      const ref={documentId:item.documentId,version:item.version,contentHash:item.contentHash,contentPath,byteLength:Buffer.byteLength(rev.content,"utf8"),utf16Length:rev.content.length,wordCount:countWords(rev.content)};
      try {
        if(!item.contentPath) await uploadToStorage(contentPath,rev.content);
        await verifyObject(ref);
        if(await store.setSnapshotObject(ref,jobId)) next.changed++;
        else if(!item.contentPath && !await store.isContentReferenced(contentPath)) await removeStoredContent(contentPath);
      } catch(error) {
        if(!item.contentPath && !await store.isContentReferenced(contentPath)) await removeStoredContent(contentPath).catch(()=>undefined);
        throw error;
      }
    } else {
      const rev=await store.getRevision(item.documentId,item.version);
      if(!rev||sha256(rev.content)!==item.contentHash)throw new Error("CONTENT_INTEGRITY_FAILED");
      if(await store.setSnapshotMetadata({documentId:item.documentId,version:item.version,contentHash:item.contentHash,byteLength:Buffer.byteLength(rev.content,"utf8"),utf16Length:rev.content.length,wordCount:countWords(rev.content)},jobId))next.changed++;
    }
    next.checked++;
    next.cursor={documentId:item.documentId,version:item.version};
    // Commit the checkpoint after each verified snapshot. Restarting repeats at most one immutable write.
    if(jobId) await store.updateJob(jobId,{checkpoint:JSON.stringify(next)});
  }
  next.done=page.length<4;
  return next;
}

export async function cleanupBatch(store:Store,progress:MaintenanceProgress,jobId?:string):Promise<MaintenanceProgress> {
  const next={...progress};
  await requireRunning(store,jobId);
  if(await store.hasOtherActiveJobs(jobId)) return {...next,done:true};
  for(const job of await store.listExpiredExports(100)) {
    await requireRunning(store,jobId);
    if(job.resultRef) {
      await removeStoredContent(job.resultRef);
      await store.updateJob(job.id,{status:"failed",errorCode:"OUTPUT_EXPIRED",resultRef:null});
      next.changed++;
    }
  }
  const page=await listContentObjects(progress.objectCursor);
  const cutoff=Date.now()-24*60*60*1000;
  for(const object of page.items) {
    await requireRunning(store,jobId);
    if(Date.parse(object.uploadedAt)<cutoff && !await store.isContentReferenced(object.path) && !await store.hasOtherActiveJobs(jobId)) {
      await removeStoredContent(object.path);
      next.changed++;
    }
    next.checked++;
  }
  if(page.cursor) next.objectCursor=page.cursor;
  next.done=!page.cursor;
  return next;
}

export async function runMaintenance(store:Store,kind:"content_backfill"|"integrity_sweep"|"orphan_cleanup",after?:SnapshotCursor):Promise<MaintenanceProgress> {
  let progress={...initialProgress(),...(after?{cursor:after}:{})};
  while(!progress.done) progress=kind==="orphan_cleanup"?await cleanupBatch(store,progress):await snapshotBatch(store,kind,progress);
  return progress;
}
