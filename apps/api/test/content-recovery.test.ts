import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@clause/core";
import { testStore } from "./helpers.ts";
import type { Store } from "../src/store/types.ts";
import { createRecoveryManifest, pruneFromManifest, rehearseRecovery, restoreFromManifest } from "../src/content-recovery.ts";
import { runMaintenance, verifyObject } from "../src/content-maintenance.ts";
import { newContentPath, newExportPath, readStoredContent, uploadDownload, uploadToStorage } from "../src/content-storage.ts";

describe("content recovery and cleanup",()=>{
  let directory:string;
  let store:Store;
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),"clause-recovery-"));vi.stubEnv("CLAUSE_CONTENT_DIR",directory);vi.stubEnv("BLOB_READ_WRITE_TOKEN","");store=await testStore();});
  afterEach(async()=>{await store.close();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();});

  it("backfills, rehearses, prunes and restores the same immutable history",async()=>{
    const content="Confidential café 😀.\n".repeat(52_000);
    const doc=await store.insertDocument({title:"Recovery fixture",content});
    await store.commitRevision({id:doc.id,expectedVersion:1,content:`${content}UPDATED`,summary:'[{"test":"summary"}]'});
    const history=await store.listRevisions(doc.id);
    const result=await runMaintenance(store,"content_backfill");
    expect(result.changed).toBe(2);
    expect((await runMaintenance(store,"content_backfill")).checked).toBe(2);
    const manifest=await createRecoveryManifest(store);
    const proof=await rehearseRecovery(manifest.path);
    expect(proof.checked).toBe(2);
    await expect(pruneFromManifest(store,manifest.path,manifest.path)).rejects.toThrow();
    expect(await pruneFromManifest(store,manifest.path,proof.proofPath)).toEqual({pruned:2});
    expect((await store.snapshotPage(undefined,100)).map((x)=>x.hasInline)).toEqual([false,false]);
    expect((await store.getRevision(doc.id,1))?.content).toBe(content);
    const exact=await store.exactPage("café 😀",{ids:[doc.id],limit:1,offset:0,hitsPerDocument:2});
    expect(exact.items[0]?.matchCount).toBe(52_000);
    expect((await store.listRevisions(doc.id)).map(({contentPath,...rest})=>rest)).toEqual(history.map(({contentPath,...rest})=>rest));
    expect(await restoreFromManifest(store,manifest.path)).toEqual({restored:2});
    expect((await store.snapshotPage(undefined,100)).every((x)=>x.hasInline)).toBe(true);
    await store.deleteDocument(doc.id);
    expect(await store.isContentReferenced(manifest.path)).toBe(true);
    expect(await store.isContentReferenced(proof.proofPath)).toBe(true);
    const parsed=JSON.parse(await readStoredContent(manifest.path));
    expect(await store.isContentReferenced(parsed.entries[0].contentPath)).toBe(true);
  },120_000);

  it("backfills inline metadata without changing its version or hash",async()=>{
    const content="Small café 😀 contract",doc=await store.insertDocument({title:"Inline metadata",content});
    await store.setSnapshotMetadata({documentId:doc.id,version:1,contentHash:doc.contentHash,byteLength:1,utf16Length:1,wordCount:0});
    expect((await runMaintenance(store,"content_backfill")).checked).toBe(1);
    expect(await store.getDocumentMetadata(doc.id)).toMatchObject({version:1,contentHash:doc.contentHash,byteLength:Buffer.byteLength(content),utf16Length:content.length,wordCount:4});
  });

  it("refuses missing or corrupt backups before pruning a snapshot",async()=>{
    const content="x".repeat(1024*1024+1);
    await store.insertDocument({title:"Corruption fixture",content});
    await runMaintenance(store,"content_backfill");
    const manifest=await createRecoveryManifest(store);
    const proof=await rehearseRecovery(manifest.path);
    const ref=(await store.snapshotPage(undefined,1))[0]!;
    expect(ref.contentPath).toBeDefined();
    await writeFile(join(directory,ref.contentPath!),"corrupt");
    await expect(pruneFromManifest(store,manifest.path,proof.proofPath)).rejects.toThrow("CONTENT_INTEGRITY_FAILED");
    expect((await store.snapshotPage(undefined,1))[0]?.hasInline).toBe(true);
  },60_000);

  it("cleans only old unreferenced objects and expires export outputs",async()=>{
    const orphan=newContentPath(),recent=newContentPath(),backup=newContentPath();
    for(const path of [orphan,recent,backup]) await uploadToStorage(path,"fixture");
    const old=new Date(Date.now()-25*60*60*1000);
    await utimes(join(directory,orphan),old,old);await utimes(join(directory,backup),old,old);
    await store.registerRecoveryManifest(newContentPath(),sha256("manifest"),newContentPath(),[backup]);
    const output=newExportPath();await uploadDownload(output,Buffer.from("output"));
    const job=(await store.createJob({kind:"export",idempotencyKey:"expired-output"}))!.job;
    await store.claimJob(job.id,2);await store.completeJob(job.id,output,old.toISOString());
    expect((await runMaintenance(store,"orphan_cleanup")).changed).toBe(2);
    await expect(readStoredContent(orphan)).rejects.toThrow();
    expect(await readStoredContent(recent)).toBe("fixture");
    expect(await readStoredContent(backup)).toBe("fixture");
    expect((await store.getJob(job.id))?.errorCode).toBe("OUTPUT_EXPIRED");
    const valid=newContentPath();await uploadToStorage(valid,"known");
    expect(await verifyObject({contentPath:valid,contentHash:sha256("known"),byteLength:5})).toBe("known");
  });
});
