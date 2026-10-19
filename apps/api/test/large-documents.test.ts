import { getPayloadFromClientToken } from "@vercel/blob/client";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@clause/core";
import { issueUpload, MAX_CONTENT_BYTES, newContentPath, readStoredContent, removeStoredContent, signedReadUrl, storedContentSize, uploadDownload, uploadToStorage, verifyIntent } from "../src/content-storage.ts";
import { testApp } from "./helpers.ts";

describe("large document storage", () => {
  it("uploads, reads, edits, searches, and reverts a document above the inline threshold", async () => {
    const app = await testApp();
    const content = `${"The parties shall protect confidential information.\n".repeat(24_000)}FINAL-CLAUSE`;
    const bytes = Buffer.byteLength(content, "utf8");
    const intentRes = await app.inject({ method: "POST", url: "/documents/uploads/intents", payload: { size: bytes } });
    expect(intentRes.statusCode).toBe(201);
    const { intent, uploadUrl } = intentRes.json();
    const uploaded = await app.inject({ method: "POST", url: `${uploadUrl}?intent=${encodeURIComponent(intent)}`, headers: { "content-type": "text/plain; charset=utf-8" }, payload: content });
    expect(uploaded.statusCode).toBe(204);
    const created = await app.inject({ method: "POST", url: "/documents/uploads/complete", payload: { intent, title: "Large agreement", sha256: sha256(content) } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).not.toHaveProperty("content");
    expect(created.json()).toHaveProperty("contentUrl");
    const id = created.json().id as string;
    const firstRead=await app.inject({ method: "GET", url: `/documents/${id}/content` });
    expect(firstRead.statusCode).toBe(303);
    expect((await app.inject({method:"GET",url:firstRead.headers.location!})).body).toBe(content);

    const edited = await app.inject({ method: "PATCH", url: `/documents/${id}`, payload: { expectedVersion: 1, changes: [{ operation: "replace", target: { quote: { exact: "FINAL-CLAUSE" } }, replacement: "REVISED-CLAUSE" }] } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).not.toHaveProperty("content");
    const editedRead=await app.inject({ method: "GET", url: `/documents/${id}/content` });
    expect((await app.inject({method:"GET",url:editedRead.headers.location!})).body.endsWith("REVISED-CLAUSE")).toBe(true);
    const preview = await app.inject({ method: "POST", url: `/documents/${id}/changes/preview`, payload: { expectedVersion: 2, changes: [{ operation: "replace", target: { quote: { exact: "REVISED-CLAUSE" } }, replacement: "PREVIEW-CLAUSE" }] } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).not.toHaveProperty("proposedContent");
    const search = await app.inject({ method: "GET", url: "/documents/search?q=REVISED-CLAUSE&mode=exact" });
    expect(search.statusCode).toBe(200);
    const reverted = await app.inject({ method: "POST", url: `/documents/${id}/revert`, payload: { expectedVersion: 2, toVersion: 1 } });
    expect(reverted.statusCode).toBe(200);
    const revertedRead=await app.inject({ method: "GET", url: `/documents/${id}/content` });
    expect((await app.inject({method:"GET",url:revertedRead.headers.location!})).body).toBe(content);
    await app.close();
  },120_000);

  it("rejects an upload whose byte count differs from its signed intent", async () => {
    const app = await testApp();
    const content = "x".repeat(1024);
    const issued = await app.inject({ method: "POST", url: "/documents/uploads/intents", payload: { size: 1024 } });
    const { intent, uploadUrl } = issued.json();
    const result = await app.inject({ method: "POST", url: `${uploadUrl}?intent=${encodeURIComponent(intent)}`, headers: { "content-type": "text/plain" }, payload: "short" });
    expect(result.statusCode).toBe(400);
    expect(result.json().type).toBe("UPLOAD_SIZE_MISMATCH");
    expect(content).toHaveLength(1024);
    await app.close();
  });

  it("deletes uploaded content when completion detects a hash mismatch", async () => {
    const app = await testApp();
    const content = "body".repeat(300_000);
    const issued = await app.inject({ method: "POST", url: "/documents/uploads/intents", payload: { size: Buffer.byteLength(content) } });
    const { intent, uploadUrl, pathname } = issued.json();
    await app.inject({ method: "POST", url: `${uploadUrl}?intent=${encodeURIComponent(intent)}`, headers: { "content-type": "text/plain" }, payload: content });
    const result = await app.inject({ method: "POST", url: "/documents/uploads/complete", payload: { intent, title: "bad hash", sha256: sha256("different") } });
    expect(result.statusCode).toBe(422);
    expect(result.json().type).toBe("UPLOAD_HASH_MISMATCH");
    await expect(readStoredContent(pathname)).rejects.toThrow();
    await app.close();
  });

  it("binds private client uploads to the server pathname, size, expiry and immutable write options",async()=>{
    const pathname=newContentPath(),env={BLOB_READ_WRITE_TOKEN:"vercel_blob_rw_fixture_signing-key-for-tests",CLAUSE_UPLOAD_INTENT_SECRET:"scope-secret-".repeat(4)};
    const issued=await issueUpload(pathname,1024,env,{op:"revision",id:"doc_123abc",version:7});
    expect(issued.clientToken).toBeDefined();
    const client=getPayloadFromClientToken(issued.clientToken!);
    expect(client).toMatchObject({pathname,maximumSizeInBytes:1024,addRandomSuffix:false,allowOverwrite:false});
    expect(client.validUntil).toBe(Date.parse(issued.expiresAt));
    expect(await verifyIntent(issued.token,env)).toMatchObject({op:"revision",id:"doc_123abc",version:7,path:pathname,size:1024});
  });

  it("expires signed upload intents and refuses forged object paths", async () => {
    const env = { CLAUSE_UPLOAD_INTENT_SECRET: "x".repeat(40) };
    const issued = await issueUpload(newContentPath(), 42, env);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      await expect(verifyIntent(issued.token, env)).rejects.toThrow();
    } finally { vi.useRealTimers(); }
  });

  it("keeps local content immutable, reports byte size, and makes cleanup repeatable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clause-content-"));
    const env = { CLAUSE_CONTENT_DIR: dir };
    const path = newContentPath();
    const content = "hello 世界";
    try {
      await uploadToStorage(path, content, env);
      expect(await readStoredContent(path, env)).toBe(content);
      expect(await storedContentSize(path, env)).toBe(Buffer.byteLength(content));
      await expect(uploadToStorage(path, content, env)).rejects.toThrow();
      await removeStoredContent(path, env);
      await removeStoredContent(path, env);
      await expect(readStoredContent(path, env)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("rejects invalid object paths and uploads beyond the document byte limit", async () => {
    const env = { CLAUSE_CONTENT_DIR: await mkdtemp(join(tmpdir(), "clause-invalid-")) };
    try {
      await expect(readStoredContent("../secret.txt", env)).rejects.toThrow(/invalid content object path/);
      await expect(uploadToStorage(newContentPath(), "x".repeat(25 * 1024 * 1024 + 1), env)).rejects.toThrow(/25 MiB/);
    } finally { await rm(env.CLAUSE_CONTENT_DIR, { recursive: true, force: true }); }
  });

  it("accepts content at the exact 25 MiB UTF-8 storage boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clause-boundary-"));
    const env = { CLAUSE_CONTENT_DIR: dir };
    const path = newContentPath();
    try {
      await uploadToStorage(path, "x".repeat(MAX_CONTENT_BYTES), env);
      expect(await storedContentSize(path, env)).toBe(MAX_CONTENT_BYTES);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("uses local URLs in development and requires Blob credentials for remote-only operations", async () => {
    expect(await signedReadUrl(newContentPath(), { CLAUSE_CONTENT_DIR: "/tmp/clause-content-test" })).toBeUndefined();
    const dir=await mkdtemp(join(tmpdir(),"clause-export-local-"));
    await uploadDownload("content/export.docx", Buffer.from("docx"), {CLAUSE_CONTENT_DIR:dir});
    expect(await storedContentSize("content/export.docx",{CLAUSE_CONTENT_DIR:dir})).toBe(4);
    await rm(dir,{recursive:true,force:true});
    await expect(issueUpload(newContentPath(), 10, { VERCEL: "1" })).rejects.toThrow(/CLAUSE_UPLOAD_INTENT_SECRET/);
  });
});
