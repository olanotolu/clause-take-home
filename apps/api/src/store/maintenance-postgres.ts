import { query as dbQuery } from "./pg-query.ts";
import type pg from "pg";
import { JobCancelledError } from "../jobs/types.ts";
import { snapshot, type MaintenanceStore } from "./maintenance-sqlite.ts";

export function postgresMaintenance(pool:pg.Pool,tx:<T>(fn:(c:pg.PoolClient)=>Promise<T>)=>Promise<T>):MaintenanceStore {
  return {
    async leaseJob(id,owner) { return (await dbQuery(pool,"UPDATE clause_jobs SET lease_owner=$2,lease_until=$3 WHERE id=$1 AND status='running' AND (lease_until IS NULL OR lease_until<$4)",[id,owner,new Date(Date.now()+600_000).toISOString(),new Date().toISOString()])).rowCount===1; },
    async releaseJob(id,owner) { await dbQuery(pool,"UPDATE clause_jobs SET lease_owner=NULL,lease_until=NULL WHERE id=$1 AND lease_owner=$2",[id,owner]); },
    async finishJob(id,output) { return (await dbQuery(pool,"UPDATE clause_jobs SET status='succeeded',progress=100,output=$2,updated_at=$3 WHERE id=$1 AND status='running'",[id,JSON.stringify(output),new Date().toISOString()])).rowCount===1; },
    async snapshotPage(after,limit) {
      return (await dbQuery(pool,`SELECT document_id AS "documentId",version,content_hash AS "contentHash",created_at AS "createdAt",summary,content_path AS "contentPath",
        COALESCE(content_bytes,octet_length(content)) AS "byteLength",COALESCE(content_utf16,length(content)) AS "utf16Length",COALESCE(word_count,0) AS "wordCount",length(content)>0 AS "hasInline"
        FROM revisions WHERE ($1::text IS NULL OR (document_id,version)>($1,$2)) ORDER BY document_id,version LIMIT $3`,[after?.documentId??null,after?.version??0,Math.min(100,Math.max(1,limit))])).rows.map(snapshot);
    },
    async setSnapshotMetadata(ref,jobId) {
      return tx(async(c)=>{
        if(jobId && !(await dbQuery(c,"SELECT 1 FROM clause_jobs WHERE id=$1 AND status='running' FOR UPDATE",[jobId])).rowCount) throw new JobCancelledError();
        const updated=(await dbQuery(c,"UPDATE revisions SET content_bytes=$1,content_utf16=$2,word_count=$3 WHERE document_id=$4 AND version=$5 AND content_hash=$6",[ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash])).rowCount===1;
        if(updated)await dbQuery(c,"UPDATE documents SET content_bytes=$1,content_utf16=$2,word_count=$3 WHERE id=$4 AND version=$5 AND content_hash=$6",[ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash]);
        return updated;
      });
    },
    async setSnapshotObject(ref,jobId) {
      return tx(async(c)=>{
        if(jobId && !(await dbQuery(c,"SELECT 1 FROM clause_jobs WHERE id=$1 AND status='running' FOR UPDATE",[jobId])).rowCount) throw new JobCancelledError();
        const updated=(await dbQuery(c,"UPDATE revisions SET content_path=$1,content_bytes=$2,content_utf16=$3,word_count=$4 WHERE document_id=$5 AND version=$6 AND content_hash=$7 AND (content_path IS NULL OR content_path=$1)",[ref.contentPath,ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash])).rowCount===1;
        if(updated) await dbQuery(c,"UPDATE documents SET content_path=$1,content_bytes=$2,content_utf16=$3,word_count=$4 WHERE id=$5 AND version=$6 AND content_hash=$7",[ref.contentPath,ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash]);
        if(updated) {
          const current=(await dbQuery(c,"SELECT 1 FROM documents WHERE id=$1 AND version=$2 AND content_hash=$3 FOR UPDATE",[ref.documentId,ref.version,ref.contentHash])).rowCount;
          if(current) {
            const chunks=(await dbQuery<{chunk_id:string;content:string;start_offset:number;end_offset:number}>(c,"SELECT chunk_id,content,start_offset,end_offset FROM document_chunks WHERE document_id=$1 AND core_content IS NULL",[ref.documentId])).rows;
            let page:{id:string;core:string}[]=[],bytes=0;
            const flush=async()=>{if(page.length)await dbQuery(c,"UPDATE document_chunks c SET core_content=x.core FROM unnest($1::text[],$2::text[]) AS x(id,core) WHERE c.document_id=$3 AND c.chunk_id=x.id",[page.map(x=>x.id),page.map(x=>x.core),ref.documentId]);page=[];bytes=0;};
            for(const chunk of chunks) {
              const start=Math.min(chunk.start_offset,200),core=chunk.content.slice(start,start+chunk.end_offset-chunk.start_offset),size=Buffer.byteLength(JSON.stringify([core,chunk.chunk_id]))+64;
              if(page.length>=256||bytes+size>2*1024*1024)await flush();
              page.push({id:chunk.chunk_id,core});bytes+=size;
            }
            await flush();
          }
        }
        return updated;
      });
    },
    async registerRecoveryManifest(path,hash,proofPath,objects) {
      await tx(async(c)=>{
        await dbQuery(c,"INSERT INTO content_recovery_manifests(path,content_hash,proof_path) VALUES($1,$2,$3) ON CONFLICT(path) DO UPDATE SET proof_path=excluded.proof_path",[path,hash,proofPath]);
        for(let i=0;i<objects.length;i+=256) await dbQuery(c,"INSERT INTO content_recovery_objects(manifest_path,path) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING",[path,objects.slice(i,i+256)]);
      });
    },
    async pruneSnapshot(ref,manifestPath) {
      return tx(async(c)=>{
        const changed=(await dbQuery(c,`UPDATE revisions SET content='' WHERE document_id=$1 AND version=$2 AND content_hash=$3 AND content_path=$4 AND EXISTS
          (SELECT 1 FROM content_recovery_objects WHERE manifest_path=$5 AND path=$4)`,[ref.documentId,ref.version,ref.contentHash,ref.contentPath,manifestPath])).rowCount===1;
        if(changed) await dbQuery(c,"UPDATE documents SET content='' WHERE id=$1 AND version=$2 AND content_hash=$3 AND content_path=$4",[ref.documentId,ref.version,ref.contentHash,ref.contentPath]);
        return changed;
      });
    },
    async restoreSnapshot(ref,content) {
      return tx(async(c)=>{
        const changed=(await dbQuery(c,"UPDATE revisions SET content=$1 WHERE document_id=$2 AND version=$3 AND content_hash=$4 AND content_path=$5",[content,ref.documentId,ref.version,ref.contentHash,ref.contentPath])).rowCount===1;
        if(changed) await dbQuery(c,"UPDATE documents SET content=$1 WHERE id=$2 AND version=$3 AND content_hash=$4 AND content_path=$5",[content,ref.documentId,ref.version,ref.contentHash,ref.contentPath]);
        return changed;
      });
    },
    async isContentReferenced(path) {
      return Boolean((await dbQuery(pool,`SELECT 1 WHERE EXISTS(SELECT 1 FROM revisions WHERE content_path=$1) OR EXISTS(SELECT 1 FROM documents WHERE content_path=$1)
        OR EXISTS(SELECT 1 FROM clause_jobs WHERE result_ref=$1 OR (status IN ('queued','running') AND (payload LIKE $2 OR checkpoint LIKE $2)))
        OR EXISTS(SELECT 1 FROM content_recovery_manifests WHERE path=$1 OR proof_path=$1) OR EXISTS(SELECT 1 FROM content_recovery_objects WHERE path=$1)`,[path,`%${path}%`])).rowCount);
    },
    async hasOtherActiveJobs(id) { return Boolean((await dbQuery(pool,"SELECT 1 FROM clause_jobs WHERE status IN ('queued','running') AND kind<>'orphan_cleanup' AND id<>$1 LIMIT 1",[id??""])).rowCount); },
  };
}
