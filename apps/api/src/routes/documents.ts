import { boundedApplied, boundedDiff } from "../wire-content.ts";
import { cleanupJobOutputs } from "../jobs/runner.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../types.ts";
import { countWords, sha256 } from "@clause/core";
import { MAX_EXPORT_CHARS, redlineDocx } from "../docx.ts";
import { createPatch } from "diff";
import { z } from "zod";
import * as docs from "../documents.ts";
import type { DocumentRecord } from "../store/types.ts";
import { INLINE_CONTENT_BYTES, MAX_CONTENT_BYTES, newContentPath, newExportPath, issueUpload, readStoredContent, readStoredBuffer, removeStoredContent, signedReadUrl, storedContentSize, uploadDownload, uploadToStorage, verifyIntent } from "../content-storage.ts";
import { ChangesBody, CopyBody, CreateBody, DocumentOut, DocumentSummaryOut, ExportQuery, IdParams, PageQuery, PreviewOut, RevertBody, VersionParam, ReceiptOut, RevisionInfoOut, errors } from "../schemas.ts";


async function contentUrlFor(id: string, version: number, path?: string): Promise<string> {
  if (path) {
    const signed = await signedReadUrl(path);
    if (signed) return signed.url;
  }
  return `/documents/${encodeURIComponent(id)}/revisions/${version}/content`;
}

const present = async (d: DocumentRecord) => ({
  id: d.id,
  title: d.title,
  ...(Buffer.byteLength(d.content, "utf8") <= INLINE_CONTENT_BYTES ? { content: d.content } : { contentUrl: await contentUrlFor(d.id, d.version, d.contentPath) }),
  byteLength: Buffer.byteLength(d.content, "utf8"),
  utf16Length: d.content.length,
  wordCount: countWords(d.content),
  version: d.version,
  contentHash: d.contentHash,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
  ...(d.sample ? { sample: true } : {}),
  ...(d.templateProvenance ? { templateProvenance: d.templateProvenance } : {}),
});

/** RFC 7240: true when the caller sent `Prefer: return=minimal`; the response then says so with `Preference-Applied`. */
function wantsMinimal(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!/\breturn=minimal\b/.test(String(req.headers.prefer ?? ""))) return false;
  reply.header("Preference-Applied", "return=minimal");
  return true;
}

/** An edit's receipt without the full text (the caller already knows the edit it sent). */
async function receiptFor(app:App,req:FastifyRequest,reply:FastifyReply,receipt:docs.Receipt) {
  const meta=await app.store.getRevisionMetadata(receipt.id,receipt.version);
  const contentUrl=await contentUrlFor(receipt.id,receipt.version,meta?.contentPath);
  const {content,...rest}=receipt;
  return {...rest,applied:boundedApplied(receipt.applied),contentUrl,...(!wantsMinimal(req,reply)&&Buffer.byteLength(content,"utf8")<=INLINE_CONTENT_BYTES&&Buffer.byteLength(JSON.stringify(content))<=3*INLINE_CONTENT_BYTES?{content}:{})};
}

export function registerDocumentRoutes(app: App, createLimit: { max: number; timeWindow: string }): void {
  const JobId=z.string().regex(/^job_[0-9a-f]{32}$/);

  app.get("/jobs/:id",{schema:{params:z.strictObject({id:JobId})}},async(req,reply)=>{
    const job=await app.store.getJob(req.params.id);
    if(!job) return reply.code(404).send({error:"Job not found",code:404,type:"JOB_NOT_FOUND"});
    if(job.status==="succeeded"&&job.expiresAt&&Date.parse(job.expiresAt)<=Date.now()) {
      if(job.resultRef) await removeStoredContent(job.resultRef).catch(()=>undefined);
      await app.store.updateJob(job.id,{status:"failed",errorCode:"OUTPUT_EXPIRED",resultRef:null});
      return reply.code(410).send({error:"The export has expired",code:410,type:"JOB_OUTPUT_EXPIRED"});
    }
    const signed=job.status==="succeeded"&&job.resultRef ? await signedReadUrl(job.resultRef) : undefined;
    return {id:job.id,kind:job.kind,status:job.status,progress:job.progress,createdAt:job.createdAt,updatedAt:job.updatedAt,...(job.errorCode&&{errorCode:job.errorCode}),...(job.output?{output:job.output}:{}),...(job.kind==="export"&&job.status==="succeeded"&&{downloadUrl:signed?.url??`/jobs/${job.id}/download`})};
  });

  app.post("/jobs/:id/cancel",{schema:{params:z.strictObject({id:JobId})}},async(req,reply)=>{
    const job=await app.store.cancelJob(req.params.id);
    if(!job) return reply.code(404).send({error:"Job not found",code:404,type:"JOB_NOT_FOUND"});
    await cleanupJobOutputs(app.store,job.id);
    return {id:job.id,status:job.status};
  });

  app.get("/jobs/:id/download",{schema:{params:z.strictObject({id:JobId})}},async(req,reply)=>{
    const job=await app.store.getJob(req.params.id);
    if(job?.kind!=="export"||job.status!=="succeeded"||!job.resultRef) return reply.code(404).send({error:"Job output is not available",code:404,type:"JOB_OUTPUT_NOT_FOUND"});
    if(job.expiresAt&&Date.parse(job.expiresAt)<=Date.now()) {
      await removeStoredContent(job.resultRef).catch(()=>undefined);
      await app.store.updateJob(job.id,{status:"failed",errorCode:"OUTPUT_EXPIRED",resultRef:null});
      return reply.code(410).send({error:"The export has expired",code:410,type:"JOB_OUTPUT_EXPIRED"});
    }
    const signed=await signedReadUrl(job.resultRef);
    if(signed) return reply.redirect(signed.url,303);
    const content=await readStoredBuffer(job.resultRef);
    return reply.header("cache-control","private, no-store").header("content-type","application/vnd.openxmlformats-officedocument.wordprocessingml.document").header("content-disposition","attachment; filename=clause-redline.docx").send(content as never);
  });
  app.post("/documents/uploads/intents", { config:{rateLimit:createLimit}, schema: { body: z.union([z.strictObject({size:z.number().int().min(1).max(MAX_CONTENT_BYTES),operation:z.literal("create").optional()}),z.strictObject({size:z.number().int().min(1).max(MAX_CONTENT_BYTES),operation:z.enum(["revision","preview"]),documentId:z.string().min(1).max(64),expectedVersion:z.number().int().positive()})]), response: { 201: z.object({ intent: z.string(), pathname: z.string(), clientToken: z.string().optional(), uploadUrl: z.string().optional(), expiresAt: z.string() }), ...errors(400,403,404,409,413,429,500) } } }, async (req, reply) => {
    const pathname = newContentPath();
    if(req.body.operation==="revision"||req.body.operation==="preview") {
      const doc=await app.store.getDocumentMetadata(req.body.documentId);
      if(!doc)return reply.problem({type:"DOCUMENT_NOT_FOUND",id:req.body.documentId});
      if(doc.sample)return reply.problem({type:"SAMPLE_READ_ONLY",id:doc.id});
      if(doc.version!==req.body.expectedVersion)return reply.problem({type:"VERSION_CONFLICT",expectedVersion:req.body.expectedVersion,currentVersion:doc.version});
    }
    const scope=req.body.operation==="revision"||req.body.operation==="preview"?{op:req.body.operation,id:req.body.documentId,version:req.body.expectedVersion}:{op:"create" as const};
    const issued = await issueUpload(pathname, req.body.size,process.env,scope);
    return reply.code(201).send({ intent: issued.token, pathname, ...(issued.clientToken && { clientToken: issued.clientToken }), ...(issued.uploadUrl && { uploadUrl: issued.uploadUrl }), expiresAt: issued.expiresAt });
  });

  app.post("/documents/uploads/local", { config:{rateLimit:createLimit}, schema: { querystring: z.strictObject({ intent: z.string().min(1) }), body: z.string().max(MAX_CONTENT_BYTES), response: { 204: z.null(), ...errors(400, 413,429, 500) } } }, async (req, reply) => {
    const claim = await verifyIntent(req.query.intent);
    if (Buffer.byteLength(req.body, "utf8") !== claim.size) return reply.code(400).send({ error: "Upload size does not match its intent", code: 400, type: "UPLOAD_SIZE_MISMATCH" });
    await uploadToStorage(claim.path, req.body);
    return reply.code(204).send(null);
  });

  app.post("/documents/uploads/complete", { config:{rateLimit:createLimit}, schema: { body: z.strictObject({ intent: z.string().min(1), title: z.string().min(1).max(300).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }), response: { 201: DocumentOut,200:ReceiptOut, ...errors(400,403,404,409,413,422,429,500) } } }, async (req, reply) => {
    const claim = await verifyIntent(req.body.intent);
    if(claim.op==="preview")return reply.code(400).send({error:"This upload is scoped to a preview",code:400,type:"UPLOAD_OPERATION_MISMATCH"});
    const cleanup=async()=>{if(!await app.store.isContentReferenced(claim.path))await removeStoredContent(claim.path).catch(()=>undefined);};
    const size = await storedContentSize(claim.path);
    if (size !== claim.size) { await cleanup(); return reply.code(422).send({ error: "Uploaded size does not match its intent", code: 422, type: "UPLOAD_SIZE_MISMATCH" }); }
    const content = await readStoredContent(claim.path,process.env,false);
    if (Buffer.byteLength(content, "utf8") !== claim.size || sha256(content) !== req.body.sha256) { await cleanup(); return reply.code(422).send({ error: "Uploaded content failed size or hash verification", code: 422, type: "UPLOAD_HASH_MISMATCH" }); }
    if(claim.op==="revision") {
      let result:Awaited<ReturnType<typeof docs.replaceUploaded>>;
      try {result=await docs.replaceUploaded(app.store,claim.id,claim.version,content,claim.path);}
      catch(error){await cleanup();throw error;}
      await cleanup();
      if(!result.ok)return reply.problem(result.error);
      reply.header("ETag",docs.etagOf({version:result.value.version,contentHash:result.value.afterHash}));
      return receiptFor(app,req,reply,result.value);
    }
    if(!req.body.title){await cleanup();return reply.code(400).send({error:"A document title is required",code:400,type:"VALIDATION_ERROR"});}
    const created = await docs.createDocument(app.store, { title: req.body.title, content, contentPath: claim.path });
    if (!created.ok) { await cleanup(); return reply.problem(created.error); }
    return reply.code(201).header("ETag", docs.etagOf(created.value)).header("Location", `/documents/${created.value.id}`).send(await present(created.value));
  });

  app.post("/documents", { config: { rateLimit: createLimit }, schema: { body: CreateBody, response: { 201: DocumentOut, ...errors(400, 413, 429, 500) } } }, async (req, reply) => {
    if (Buffer.byteLength(req.body.content, "utf8") > INLINE_CONTENT_BYTES) return reply.code(413).send({ error: "Use the direct upload intent flow for documents larger than 1 MiB", code: 413, type: "DIRECT_UPLOAD_REQUIRED" });
    const created = await docs.createDocument(app.store, req.body);
    if (!created.ok) return reply.problem(created.error);
    const doc = created.value;
    return reply.code(201).header("ETag", docs.etagOf(doc)).header("Location", `/documents/${doc.id}`).send(await present(doc));
  });

  // A disposable, editable copy of any document: how a reviewer works on a read-only sample. Text and requirements are
  // copied; history is not (the copy starts at version 1), and the copy is never itself a sample.
  app.post("/documents/:id/copy", { config: { rateLimit: createLimit }, schema: { params: IdParams, body: CopyBody, response: { 201: DocumentOut, ...errors(400, 404, 413, 429, 500) } } }, async (req, reply) => {
    const source = await app.store.getDocument(req.params.id);
    if (!source) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const contentPath = Buffer.byteLength(source.content, "utf8") > INLINE_CONTENT_BYTES ? newContentPath() : undefined;
    if (contentPath) await uploadToStorage(contentPath, source.content);
    let created: DocumentRecord | undefined;
    try { created = await app.store.insertDocumentWithRequirements({ title: req.body.title ?? `${source.title} (copy)`, content: source.content, ...(contentPath && { contentPath }), requirements: await app.store.listRequirements(source.id) }); }
    catch (error) { if (contentPath) await removeStoredContent(contentPath).catch(() => undefined); throw error; }
    if (!created) { if (contentPath) await removeStoredContent(contentPath).catch(() => undefined); return reply.problem({ type: "REQUIREMENT_LIMIT", max: 8 }); }
    return reply.code(201).header("ETag", docs.etagOf(created)).header("Location", `/documents/${created.id}`).send(await present(created));
  });

  app.get("/documents", { schema: { querystring: PageQuery, response: { 200: z.object({ total: z.number().int(), limit: z.number().int(), offset: z.number().int(), items: z.array(DocumentSummaryOut) }), ...errors(400, 500) } } }, async (req) => {
    const { items, total } = (await app.store.listDocuments(req.query.limit, req.query.offset));
    return { total, limit: req.query.limit, offset: req.query.offset, items };
  });

  app.get("/documents/:id", { schema: { params: IdParams, response: { 200: DocumentOut, 304: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const doc = await app.store.getDocumentMetadata(req.params.id);
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const etag = docs.etagOf(doc);
    if (req.headers["if-none-match"] === etag) return reply.code(304).header("ETag", etag).send(null);
    const fields = { id:doc.id,title:doc.title,version:doc.version,contentHash:doc.contentHash,createdAt:doc.createdAt,updatedAt:doc.updatedAt,byteLength:doc.byteLength,utf16Length:doc.utf16Length,wordCount:doc.wordCount,...(doc.sample ? {sample:true} : {}),...(doc.templateProvenance ? {templateProvenance:doc.templateProvenance} : {}) };
    if (doc.byteLength <= INLINE_CONTENT_BYTES && !wantsMinimal(req,reply)) {
      const revision = await app.store.getRevision(doc.id, doc.version);
      if (!revision) return reply.problem({ type: "REVISION_NOT_FOUND", id: doc.id, version: doc.version });
      return reply.header("ETag", etag).send({ ...fields, content: revision.content });
    }
    return reply.header("ETag", etag).send({ ...fields, contentUrl: await contentUrlFor(doc.id, doc.version, doc.contentPath) });
  });

  app.get("/documents/:id/content-url", { schema: { params: IdParams, response: { 200: z.object({ url: z.string(), expiresAt: z.string().optional() }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const doc = await app.store.getDocumentMetadata(req.params.id);
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return { url: await contentUrlFor(doc.id, doc.version, doc.contentPath) };
  });

  app.get("/documents/:id/content", { schema: { params: IdParams } }, async (req, reply) => {
    const meta = await app.store.getDocumentMetadata(req.params.id);
    if (!meta) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return reply.redirect(await contentUrlFor(meta.id, meta.version, meta.contentPath), 303);
  });

  app.get("/documents/:id/revisions/:version/content-url", { schema: { params: IdParams.extend({ version: VersionParam }), response: { 200: z.object({ url: z.string(), expiresAt: z.string().optional() }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const rev = await app.store.getRevisionMetadata(req.params.id, req.params.version);
    if (!rev) return reply.problem((await app.store.getDocumentMetadata(req.params.id)) ? { type: "REVISION_NOT_FOUND", id: req.params.id, version: req.params.version } : { type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return { url: await contentUrlFor(req.params.id, req.params.version, rev.contentPath) };
  });

  app.get("/documents/:id/revisions/:version/content", { schema: { params: IdParams.extend({ version: VersionParam }) } }, async (req, reply) => {
    const meta = await app.store.getRevisionMetadata(req.params.id, req.params.version);
    if (!meta) return reply.problem((await app.store.getDocumentMetadata(req.params.id)) ? { type: "REVISION_NOT_FOUND", id: req.params.id, version: req.params.version } : { type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if (meta.contentPath) {
      const signed = await signedReadUrl(meta.contentPath);
      if (signed) { reply.statusCode = 303; return reply.header("location", signed.url).send("" as never); }
      return reply.type("text/plain; charset=utf-8").send(await readStoredContent(meta.contentPath));
    }
    const rev = await app.store.getRevision(req.params.id, req.params.version);
    if (!rev) return reply.problem({ type: "REVISION_NOT_FOUND", id: req.params.id, version: req.params.version });
    return reply.type("text/plain; charset=utf-8").send(rev.content);
  });

  app.delete("/documents/:id", { schema: { params: IdParams, response: { 204: z.null(), ...errors(400, 403, 404, 500) } } }, async (req, reply) => {
    const doc = await app.store.getDocumentMetadata(req.params.id);
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if (doc.sample) return reply.problem({ type: "SAMPLE_READ_ONLY", id: doc.id });
    const refs = (await app.store.listRevisions(doc.id)).flatMap((r) => r.contentPath ? [r.contentPath] : []);
    if (doc.contentPath) refs.push(doc.contentPath);
    if (!(await app.store.deleteDocument(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    await Promise.all(refs.map(async(path) => { if(!await app.store.isContentReferenced(path)) await removeStoredContent(path).catch(() => undefined); }));
    return reply.code(204).send(null);
  });

  app.patch("/documents/:id", { schema: { params: IdParams, body: ChangesBody, response: { 200: ReceiptOut, ...errors(400, 403, 404, 409, 412, 413, 422, 500) } } }, async (req, reply) => {
    const r = await docs.apply(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!r.ok) return reply.problem(r.error);
    // From the receipt, never a re-read: a writer (or a delete) can land between our commit and this line.
    reply.header("ETag", docs.etagOf({ version: r.value.version, contentHash: r.value.afterHash }));
    return receiptFor(app, req, reply, r.value);
  });

  // Dry run through the exact same engine call as PATCH. Persists nothing and
  // reserves nothing: PATCH re-validates against whatever version is current.
  app.post("/documents/:id/changes/preview", { schema: { params: IdParams, body: ChangesBody, response: { 200: PreviewOut, ...errors(400, 404, 409, 412, 413, 422, 500) } } }, async (req, reply) => {
    const p = await docs.preview(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!p.ok) return reply.problem(p.error);
    const { doc, result } = p.value;
    const head = { id: doc.id, version: doc.version, wouldChange: result.changed, applied: boundedApplied(result.applied), beforeHash: doc.contentHash, afterHash: sha256(result.content) };
    // Minimal: just the changed spans. A client holding version `doc.version` can rebuild the text from them, and a
    // unified diff of the whole document (built only on request) is not needed to render a redline.
    if (wantsMinimal(req, reply) || Buffer.byteLength(doc.content, "utf8") > INLINE_CONTENT_BYTES || Buffer.byteLength(result.content,"utf8")>INLINE_CONTENT_BYTES) {
      reply.header("Preference-Applied", "return=minimal");
      return head;
    }
    return { ...head, proposedContent: result.content, diff: boundedDiff(createPatch(doc.title, doc.content, result.content, `v${doc.version}`, "proposed", { context: 3 })) };
  });

  // Undo: restore an old version's text as a new version. Same preconditions and response as PATCH.
  app.post("/documents/:id/revert", { schema: { params: IdParams, body: RevertBody, response: { 200: ReceiptOut, ...errors(400, 403, 404, 409, 412, 500) } } }, async (req, reply) => {
    const r = await docs.revert(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!r.ok) return reply.problem(r.error);
    reply.header("ETag", docs.etagOf({ version: r.value.version, contentHash: r.value.afterHash }));
    return receiptFor(app, req, reply, r.value);
  });

  // Word redline: native tracked changes (<w:ins>/<w:del>) between two versions. Read-only.
  app.get("/documents/:id/export.docx", { schema: { params: IdParams, querystring: ExportQuery, response: {202:z.object({jobId:z.string(),status:z.literal("queued"),statusUrl:z.string()}),...errors(400,404,413,422,429,500)} } }, async (req, reply) => {
    const doc = (await app.store.getDocumentMetadata(req.params.id));
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const toV = req.query.to ?? doc.version;
    const fromV = req.query.from ?? 1;
    if (fromV >= toV) return reply.problem({ type: "INVALID_VERSION_RANGE", from: fromV, to: toV });
    const fromMeta = (await app.store.getRevisionMetadata(doc.id, fromV));
    if (!fromMeta) return reply.problem({ type: "REVISION_NOT_FOUND", id: doc.id, version: fromV });
    const toMeta = (await app.store.getRevisionMetadata(doc.id, toV));
    if (!toMeta) return reply.problem({ type: "REVISION_NOT_FOUND", id: doc.id, version: toV });
    if(Math.max(fromMeta.byteLength??0,toMeta.byteLength??0)>INLINE_CONTENT_BYTES) {
      const idempotencyKey=`export:${doc.id}:${fromV}:${toV}:${fromMeta.contentHash}:${toMeta.contentHash}`;
      const created=await app.store.createJob({idempotencyKey,kind:"export",payload:{kind:"export",documentId:doc.id,fromVersion:fromV,toVersion:toV,fromHash:fromMeta.contentHash,toHash:toMeta.contentHash,outputPath:newExportPath()},expiresAt:new Date(Date.now()+24*60*60*1000).toISOString()});
      if(!created) return reply.code(429).send({error:"The export queue is full. Try again shortly.",code:429,type:"JOB_QUEUE_FULL"});
      if(created.created) {
        try { await app.startExportWorkflow({jobId:created.job.id,documentId:doc.id,fromVersion:fromV,toVersion:toV}); }
        catch { await app.store.updateJob(created.job.id,{errorCode:"WORKFLOW_START_FAILED"}); }
      }
      return reply.code(202).header("Location",`/jobs/${created.job.id}`).send({jobId:created.job.id,status:"queued",statusUrl:`/jobs/${created.job.id}`});
    }
    const from=await app.store.getRevision(doc.id,fromV);
    const to=await app.store.getRevision(doc.id,toV);
    if(!from||!to) return reply.problem({type:"REVISION_NOT_FOUND",id:doc.id,version:!from?fromV:toV});
    const chars = Math.max(from.content.length, to.content.length);
    if (chars > MAX_EXPORT_CHARS) return reply.problem({ type: "TOO_LARGE_TO_EXPORT", chars, max: MAX_EXPORT_CHARS });

    const buffer = await redlineDocx({ title: doc.title, from, to });
    const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
    if (process.env.VERCEL && buffer.byteLength > 4 * 1024 * 1024) {
      const path = newExportPath();
      await uploadDownload(path, buffer);
      const signed = await signedReadUrl(path);
      if (!signed) throw new Error("Private download URL could not be created");
      reply.statusCode = 303;
      return reply.header("location", signed.url).send("" as never);
    }
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("content-disposition", `attachment; filename="${slug}-v${fromV}-to-v${toV}-redline.docx"`)
      .send(buffer as never);
  });

  app.get("/documents/:id/revisions", { schema: { params: IdParams, response: { 200: z.object({ items: z.array(RevisionInfoOut) }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.getDocumentMetadata(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return { items: (await app.store.listRevisions(req.params.id)) };
  });

  app.get("/documents/:id/revisions/:version", { schema: { params: IdParams.extend({ version: VersionParam }), response: { 200: RevisionInfoOut.extend({ content: z.string().optional(), contentUrl: z.string().optional() }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const rev = (await app.store.getRevisionMetadata(req.params.id, req.params.version));
    if (!rev) return reply.problem((await app.store.getDocumentMetadata(req.params.id)) ? { type: "REVISION_NOT_FOUND", id: req.params.id, version: req.params.version } : { type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if ((rev.byteLength ?? 0) <= INLINE_CONTENT_BYTES) {
      const full = await app.store.getRevision(req.params.id, req.params.version);
      if (!full) return reply.problem({ type: "REVISION_NOT_FOUND", id: req.params.id, version: req.params.version });
      return { ...rev, content:full.content };
    }
    return { ...rev, contentUrl: await contentUrlFor(req.params.id, req.params.version, rev.contentPath) };
  });
}
