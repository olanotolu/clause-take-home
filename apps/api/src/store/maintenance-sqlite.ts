import { z } from "zod";
import { transaction, type Db } from "../db.ts";
import type { Store } from "./types.ts";
import { JobCancelledError } from "../jobs/types.ts";

export const SnapshotRow = z.object({ documentId:z.string(),version:z.number(),contentHash:z.string(),createdAt:z.string(),summary:z.string(),contentPath:z.string().nullable(),byteLength:z.coerce.number(),utf16Length:z.coerce.number(),wordCount:z.coerce.number(),hasInline:z.coerce.boolean() });
export const snapshot = (row:unknown) => { const {contentPath,...rest}=SnapshotRow.parse(row); return {...rest,...(contentPath?{contentPath}:{})}; };
export type MaintenanceStore = Pick<Store,"leaseJob"|"releaseJob"|"finishJob"|"snapshotPage"|"setSnapshotObject"|"setSnapshotMetadata"|"registerRecoveryManifest"|"pruneSnapshot"|"restoreSnapshot"|"isContentReferenced"|"hasOtherActiveJobs">;

export function sqliteMaintenance(db:Db):MaintenanceStore {
  return {
    async leaseJob(id,owner) {
      return db.prepare("UPDATE clause_jobs SET lease_owner=?,lease_until=? WHERE id=? AND status='running' AND (lease_until IS NULL OR lease_until<?)").run(owner,new Date(Date.now()+600_000).toISOString(),id,new Date().toISOString()).changes===1;
    },
    async releaseJob(id,owner) { db.prepare("UPDATE clause_jobs SET lease_owner=NULL,lease_until=NULL WHERE id=? AND lease_owner=?").run(id,owner); },
    async finishJob(id,output) { return db.prepare("UPDATE clause_jobs SET status='succeeded',progress=100,output=?,updated_at=? WHERE id=? AND status='running'").run(JSON.stringify(output),new Date().toISOString(),id).changes===1; },
    async snapshotPage(after,limit) {
      return db.prepare(`SELECT document_id AS documentId,version,content_hash AS contentHash,created_at AS createdAt,summary,content_path AS contentPath,
        COALESCE(content_bytes,length(CAST(content AS BLOB))) AS byteLength,COALESCE(content_utf16,length(content)) AS utf16Length,COALESCE(word_count,0) AS wordCount,length(content)>0 AS hasInline
        FROM revisions WHERE (? IS NULL OR (document_id,version)>(?,?)) ORDER BY document_id,version LIMIT ?`)
        .all(after?.documentId??null,after?.documentId??null,after?.version??0,Math.min(100,Math.max(1,limit))).map(snapshot);
    },
    async setSnapshotMetadata(ref,jobId) {
      return transaction(db,()=>{
        if(jobId && !db.prepare("SELECT 1 FROM clause_jobs WHERE id=? AND status='running'").get(jobId)) throw new JobCancelledError();
        const updated=db.prepare("UPDATE revisions SET content_bytes=?,content_utf16=?,word_count=? WHERE document_id=? AND version=? AND content_hash=?").run(ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash).changes===1;
        if(updated)db.prepare("UPDATE documents SET content_bytes=?,content_utf16=?,word_count=? WHERE id=? AND version=? AND content_hash=?").run(ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash);
        return updated;
      });
    },
    async setSnapshotObject(ref,jobId) {
      return transaction(db,()=>{
        if(jobId && !db.prepare("SELECT 1 FROM clause_jobs WHERE id=? AND status='running'").get(jobId)) throw new JobCancelledError();
        const updated=db.prepare("UPDATE revisions SET content_path=?,content_bytes=?,content_utf16=?,word_count=? WHERE document_id=? AND version=? AND content_hash=? AND (content_path IS NULL OR content_path=?)").run(ref.contentPath,ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash,ref.contentPath).changes===1;
        if(updated) db.prepare("UPDATE documents SET content_path=?,content_bytes=?,content_utf16=?,word_count=? WHERE id=? AND version=? AND content_hash=?").run(ref.contentPath,ref.byteLength,ref.utf16Length,ref.wordCount,ref.documentId,ref.version,ref.contentHash);
        return updated;
      });
    },
    async registerRecoveryManifest(path,hash,proofPath,objects) {
      transaction(db,()=>{
        db.prepare("INSERT INTO content_recovery_manifests(path,content_hash,proof_path) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET proof_path=excluded.proof_path").run(path,hash,proofPath);
        for(const object of objects) db.prepare("INSERT OR IGNORE INTO content_recovery_objects(manifest_path,path) VALUES(?,?)").run(path,object);
      });
    },
    async pruneSnapshot(ref,manifestPath) {
      return db.prepare(`UPDATE revisions SET content='' WHERE document_id=? AND version=? AND content_hash=? AND content_path=? AND EXISTS
        (SELECT 1 FROM content_recovery_objects WHERE manifest_path=? AND path=?)`).run(ref.documentId,ref.version,ref.contentHash,ref.contentPath,manifestPath,ref.contentPath).changes===1;
    },
    async restoreSnapshot(ref,content) {
      return db.prepare("UPDATE revisions SET content=? WHERE document_id=? AND version=? AND content_hash=? AND content_path=?").run(content,ref.documentId,ref.version,ref.contentHash,ref.contentPath).changes===1;
    },
    async isContentReferenced(path) {
      return Boolean(db.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM revisions WHERE content_path=?) OR EXISTS(SELECT 1 FROM documents WHERE content_path=?)
        OR EXISTS(SELECT 1 FROM clause_jobs WHERE result_ref=? OR (status IN ('queued','running') AND (payload LIKE ? OR checkpoint LIKE ?)))
        OR EXISTS(SELECT 1 FROM content_recovery_manifests WHERE path=? OR proof_path=?) OR EXISTS(SELECT 1 FROM content_recovery_objects WHERE path=?)`).get(path,path,path,`%${path}%`,`%${path}%`,path,path,path));
    },
    async hasOtherActiveJobs(id) { return Boolean(db.prepare("SELECT 1 FROM clause_jobs WHERE status IN ('queued','running') AND kind<>'orphan_cleanup' AND id<>? LIMIT 1").get(id??"")); },
  };
}
