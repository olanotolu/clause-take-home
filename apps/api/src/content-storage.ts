import { IntegrationError } from "./integrations/service.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, stat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { del, get, issueSignedToken, presignUrl, put, list } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { SignJWT, jwtVerify } from "jose";
import { recordBlob } from "./telemetry.ts";

export const INLINE_CONTENT_BYTES = 1024 * 1024;
export const MAX_CONTENT_BYTES = 25 * 1024 * 1024;
const INTENT_TTL_MS = 10 * 60 * 1000;
export type UploadOperation = "create" | "revision" | "preview";
export type UploadScope = {op:"create"}|{op:"revision"|"preview";id:string;version:number};
export type UploadClaims = UploadScope & {path:string;size:number;exp?:number};

const secret = (env: Record<string, string | undefined>) => {
  const value = env.CLAUSE_UPLOAD_INTENT_SECRET || env.BLOB_READ_WRITE_TOKEN || (env.VERCEL ? undefined : "clause-local-upload-intent-secret-for-development-only");
  if (!value || value.length < 32) throw new Error("CLAUSE_UPLOAD_INTENT_SECRET (32+ chars) or BLOB_READ_WRITE_TOKEN is required for upload intents");
  return new TextEncoder().encode(value);
};
const localRoot = (env: Record<string, string | undefined>) => resolve(env.CLAUSE_CONTENT_DIR ?? join(import.meta.dirname, "../../../data/content"));
const remote = (env: Record<string, string | undefined>) => Boolean(env.BLOB_READ_WRITE_TOKEN);
const blobToken = (env: Record<string, string | undefined>) => {
  const value = env.BLOB_READ_WRITE_TOKEN;
  if (!value) throw new Error("BLOB_READ_WRITE_TOKEN is required for Vercel Blob storage");
  return value;
};

async function measureBlob<T>(operation:string,bytes:number,run:()=>Promise<T>):Promise<T> {
  const start=performance.now();
  try { const value=await run(); const observed=bytes || (typeof value==="string" ? Buffer.byteLength(value,"utf8") : Buffer.isBuffer(value) ? value.byteLength : 0); recordBlob(operation,performance.now()-start,observed); return value; }
  catch(error) { recordBlob(operation,performance.now()-start,bytes,true); throw error; }
}

function localPath(path: string, env: Record<string, string | undefined>) {
  if (!/^content\/[a-z0-9_-]+\.(txt|docx)$/.test(path)) throw new Error("invalid content object path");
  const root = localRoot(env);
  const file = resolve(root, path);
  if (!file.startsWith(`${root}/`)) throw new Error("invalid content object path");
  return file;
}

export async function issueUpload(path: string, maxSize: number, env = process.env, scope:UploadScope={op:"create"}): Promise<{ token: string; clientToken?: string; uploadUrl?: string; expiresAt: string }> {
  const expiresAtMs = Date.now() + INTENT_TTL_MS;
  const intent = await new SignJWT({ ...scope, path, size: maxSize } satisfies UploadClaims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(Math.floor(expiresAtMs / 1000)).sign(secret(env));
  if (remote(env)) {
    const token = await generateClientTokenFromReadWriteToken({ token: blobToken(env), pathname: path, allowedContentTypes: ["text/plain", "text/markdown", "application/octet-stream"], maximumSizeInBytes: maxSize, validUntil: expiresAtMs, addRandomSuffix:false, allowOverwrite: false });
    return { token: intent, clientToken: token, expiresAt: new Date(expiresAtMs).toISOString() };
  }
  return { token: intent, uploadUrl: "/documents/uploads/local", expiresAt: new Date(expiresAtMs).toISOString() };
}

export async function verifyIntent(token: string, env = process.env): Promise<UploadClaims> {
  let payload:Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {({payload}=await jwtVerify(token,secret(env)));}catch {throw new IntegrationError(400,"UPLOAD_INTENT_INVALID","The upload intent is invalid or expired.");}
  if (typeof payload.path !== "string" || !/^content\/[a-z0-9_-]+\.txt$/.test(payload.path) || (payload.op !== "create" && payload.op !== "revision" && payload.op !== "preview") || typeof payload.size !== "number" || payload.size < 1 || payload.size > MAX_CONTENT_BYTES) throw new IntegrationError(400,"UPLOAD_INTENT_INVALID","The upload intent is invalid");
  const metadata={path:payload.path,size:payload.size,...(typeof payload.exp==="number"?{exp:payload.exp}:{})};
  if(payload.op==="revision"||payload.op==="preview") {
    if(typeof payload.id!=="string"||!/^doc_[a-z0-9]+$/.test(payload.id)||typeof payload.version!=="number"||!Number.isSafeInteger(payload.version)||payload.version<1)throw new IntegrationError(400,"UPLOAD_INTENT_INVALID","The upload intent has an invalid revision scope");
    return {...metadata,op:payload.op,id:payload.id,version:payload.version};
  }
  return {...metadata,op:"create"};
}

export async function uploadToStorage(path: string, content: string, env = process.env): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new Error("content exceeds 25 MiB");
  const bytes=Buffer.byteLength(content,"utf8");
  await measureBlob("upload",bytes,async()=>{
    if (remote(env)) { await put(path, content, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "text/plain; charset=utf-8", token: blobToken(env) }); return; }
    const file = localPath(path, env);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, { flag: "wx" });
  });
}

export async function readStoredBuffer(path: string, env = process.env, useCache = true): Promise<Buffer> {
  return measureBlob("read",0,async()=>{
    if (remote(env)) {
      const result = await get(path, { access: "private", useCache, token: blobToken(env) });
      if (result?.statusCode !== 200 || !result.stream) throw new Error("content object unavailable");
      const response = new Response(result.stream);
      return Buffer.from(await response.arrayBuffer());
    }
    return readFile(localPath(path, env));
  });
}

export async function readStoredContent(path: string, env = process.env, useCache = true): Promise<string> {
  const bytes=await readStoredBuffer(path,env,useCache);
  return bytes.toString("utf8");
}

export async function storedContentSize(path: string, env = process.env): Promise<number> {
  return measureBlob("head",0,async()=>{
    if (remote(env)) { const { head } = await import("@vercel/blob"); return (await head(path, { token: blobToken(env) })).size; }
    return (await stat(localPath(path, env))).size;
  });
}

export async function signedReadUrl(path: string, env = process.env): Promise<{ url: string; expiresAt: string } | undefined> {
  if (!remote(env)) return undefined;
  return measureBlob("sign",0,async()=>{
    const expiresAtMs = Date.now() + 5 * 60 * 1000;
    const signed = await issueSignedToken({ token: blobToken(env), pathname: path, operations: ["get"], validUntil: expiresAtMs });
    const { presignedUrl } = await presignUrl(signed, { access: "private", operation: "get", pathname: path, validUntil: expiresAtMs, useCache: true });
    return { url: presignedUrl, expiresAt: new Date(expiresAtMs).toISOString() };
  });
}

export async function removeStoredContent(path: string, env = process.env): Promise<void> {
  await measureBlob("delete",0,async()=>{
    if (remote(env)) { await del(path, { token: blobToken(env) }); return; }
    await unlink(localPath(path, env)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  });
}

export function newContentPath(): string { return `content/${randomUUID()}.txt`; }

export function newExportPath(): string { return `content/${randomUUID()}.docx`; }

export async function listContentObjects(cursor?:string,env=process.env):Promise<{items:{path:string;uploadedAt:string}[];cursor?:string}> {
  if(remote(env)) {
    const page=await list({prefix:"content/",limit:100,...(cursor?{cursor}:{}),token:blobToken(env)});
    return {items:page.blobs.map((b)=>({path:b.pathname,uploadedAt:b.uploadedAt.toISOString()})),...(page.hasMore&&page.cursor?{cursor:page.cursor}:{})};
  }
  const directory=join(localRoot(env),"content");
  let names:string[];
  try { names=await readdir(directory); }
  catch(error) { if(error instanceof Error && "code" in error && error.code==="ENOENT") return {items:[]}; throw error; }
  names=names.filter((name)=>/^[a-z0-9_-]+\.(txt|docx)$/.test(name)&&(!cursor||name>cursor)).sort();
  const selected=names.slice(0,100);
  const items=await Promise.all(selected.map(async(name)=>({path:`content/${name}`,uploadedAt:(await stat(join(directory,name))).mtime.toISOString()})));
  const last=selected.at(-1);
  return {items,...(names.length>100&&last?{cursor:last}:{})};
}

export async function uploadDownload(path: string, data: Buffer, env = process.env): Promise<void> {
  await measureBlob("export_upload",data.byteLength,async()=>{
    if(remote(env)) { await put(path, data, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", token: blobToken(env) }); return; }
    const file=localPath(path,env); await mkdir(dirname(file),{recursive:true}); await writeFile(file,data,{flag:"wx"});
  });
}
