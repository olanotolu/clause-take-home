import { DatabaseSync } from "node:sqlite";
import { sha256 } from "@clause/core";
import { z } from "zod";
import type { Store } from "./store/types.ts";
import { newContentPath, readStoredContent, uploadToStorage } from "./content-storage.ts";
import { verifyObject } from "./content-maintenance.ts";

const ObjectPath=z.string().regex(/^content\/[a-z0-9_-]+\.txt$/);
const Entry=z.object({documentId:z.string(),version:z.number().int().positive(),contentHash:z.string().regex(/^[a-f0-9]{64}$/),contentPath:ObjectPath,byteLength:z.number().int().positive(),utf16Length:z.number().int().nonnegative(),wordCount:z.number().int().nonnegative(),createdAt:z.string(),summary:z.string()});
const Manifest=z.object({schema:z.literal(1),kind:z.literal("clause-content-recovery"),createdAt:z.string(),entries:z.array(Entry).max(10_000)});
const Proof=z.object({schema:z.literal(1),kind:z.literal("clause-recovery-rehearsal"),manifestPath:ObjectPath,manifestHash:z.string(),verifiedAt:z.string(),checked:z.number().int()});

async function loadManifest(path:string) {
  ObjectPath.parse(path);
  const content=await readStoredContent(path,process.env,false);
  return {manifest:Manifest.parse(JSON.parse(content)),hash:sha256(content)};
}

export async function createRecoveryManifest(store:Store):Promise<{path:string;hash:string;entries:number}> {
  const entries:z.infer<typeof Entry>[]=[];
  let cursor:{documentId:string;version:number}|undefined;
  for(;;) {
    const page=await store.snapshotPage(cursor,100);
    for(const item of page) {
      if(item.contentPath) {
        await verifyObject({...item,contentPath:item.contentPath});
        entries.push(Entry.parse(item));
        if(entries.length>10_000) throw new Error("Recovery manifest exceeds 10000 snapshots; partition this recovery operation before pruning");
      }
      cursor={documentId:item.documentId,version:item.version};
    }
    if(page.length<100) break;
  }
  const text=JSON.stringify(Manifest.parse({schema:1,kind:"clause-content-recovery",createdAt:new Date().toISOString(),entries}));
  const path=newContentPath();
  await uploadToStorage(path,text);
  if(sha256(await readStoredContent(path,process.env,false))!==sha256(text)) throw new Error("Recovery manifest verification failed");
  return {path,hash:sha256(text),entries:entries.length};
}

export async function rehearseRecovery(manifestPath:string):Promise<{proofPath:string;checked:number}> {
  const {manifest,hash}=await loadManifest(manifestPath);
  const db=new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE snapshots(document_id TEXT,version INTEGER,content TEXT,content_hash TEXT,created_at TEXT,summary TEXT,PRIMARY KEY(document_id,version))");
    for(const entry of manifest.entries) {
      const content=await verifyObject(entry);
      db.prepare("INSERT INTO snapshots VALUES(?,?,?,?,?,?)").run(entry.documentId,entry.version,content,entry.contentHash,entry.createdAt,entry.summary);
      const row=db.prepare("SELECT content,created_at,summary FROM snapshots WHERE document_id=? AND version=?").get(entry.documentId,entry.version);
      if(!row||typeof row.content!=="string"||sha256(row.content)!==entry.contentHash||row.created_at!==entry.createdAt||row.summary!==entry.summary) throw new Error("Recovery rehearsal failed");
    }
  } finally { db.close(); }
  const proofPath=newContentPath();
  await uploadToStorage(proofPath,JSON.stringify(Proof.parse({schema:1,kind:"clause-recovery-rehearsal",manifestPath,manifestHash:hash,verifiedAt:new Date().toISOString(),checked:manifest.entries.length})));
  return {proofPath,checked:manifest.entries.length};
}

export async function pruneFromManifest(store:Store,manifestPath:string,proofPath:string):Promise<{pruned:number}> {
  const {manifest,hash}=await loadManifest(manifestPath);
  const proof=Proof.parse(JSON.parse(await readStoredContent(ObjectPath.parse(proofPath),process.env,false)));
  if(proof.manifestPath!==manifestPath||proof.manifestHash!==hash||proof.checked!==manifest.entries.length) throw new Error("A successful rehearsal of this exact manifest is required before pruning");
  // Register all backups before the first prune, so interruption cannot expose them to orphan cleanup.
  await store.registerRecoveryManifest(manifestPath,hash,proofPath,manifest.entries.map((entry)=>entry.contentPath));
  let pruned=0;
  for(const entry of manifest.entries) {
    await verifyObject(entry);
    if(await store.pruneSnapshot(entry,manifestPath)) pruned++;
  }
  return {pruned};
}

export async function restoreFromManifest(store:Store,manifestPath:string):Promise<{restored:number}> {
  const {manifest}=await loadManifest(manifestPath);
  let restored=0;
  for(const entry of manifest.entries) if(await store.restoreSnapshot(entry,await verifyObject(entry))) restored++;
  return {restored};
}
