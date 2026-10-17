import type { FastifyReply, FastifyRequest } from "fastify";
import type { App } from "../types.ts";
import { sha256 } from "@clause/core";
import { MAX_EXPORT_CHARS, redlineDocx } from "../docx.ts";
import { createPatch } from "diff";
import { z } from "zod";
import * as docs from "../documents.ts";
import type { DocumentRecord } from "../store/types.ts";
import { ChangesBody, CopyBody, CreateBody, DocumentOut, DocumentSummaryOut, ExportQuery, IdParams, PageQuery, PreviewOut, RevertBody, VersionParam, ReceiptOut, RevisionInfoOut, errors } from "../schemas.ts";


const present = (d: DocumentRecord) => ({
  id: d.id,
  title: d.title,
  content: d.content,
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
function receiptFor<T extends { content: string }>(req: FastifyRequest, reply: FastifyReply, receipt: T): T | Omit<T, "content"> {
  if (!wantsMinimal(req, reply)) return receipt;
  const { content: _content, ...rest } = receipt;
  return rest;
}

export function registerDocumentRoutes(app: App, createLimit: { max: number; timeWindow: string }): void {
  app.post("/documents", { config: { rateLimit: createLimit }, schema: { body: CreateBody, response: { 201: DocumentOut, ...errors(400, 413, 429, 500) } } }, async (req, reply) => {
    const created = await docs.createDocument(app.store, req.body);
    if (!created.ok) return reply.problem(created.error);
    const doc = created.value;
    return reply.code(201).header("ETag", docs.etagOf(doc)).header("Location", `/documents/${doc.id}`).send(present(doc));
  });

  // A disposable, editable copy of any document: how a reviewer works on a read-only sample. Text and requirements are
  // copied; history is not (the copy starts at version 1), and the copy is never itself a sample.
  app.post("/documents/:id/copy", { config: { rateLimit: createLimit }, schema: { params: IdParams, body: CopyBody, response: { 201: DocumentOut, ...errors(400, 404, 413, 429, 500) } } }, async (req, reply) => {
    const source = await app.store.getDocument(req.params.id);
    if (!source) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const created = await docs.createDocument(app.store, { title: req.body.title ?? `${source.title} (copy)`, content: source.content });
    if (!created.ok) return reply.problem(created.error);
    for (const r of await app.store.listRequirements(source.id)) await app.store.addRequirement(created.value.id, { kind: r.kind, text: r.text });
    return reply.code(201).header("ETag", docs.etagOf(created.value)).header("Location", `/documents/${created.value.id}`).send(present(created.value));
  });

  app.get("/documents", { schema: { querystring: PageQuery, response: { 200: z.object({ total: z.number().int(), limit: z.number().int(), offset: z.number().int(), items: z.array(DocumentSummaryOut) }), ...errors(400, 500) } } }, async (req) => {
    const { items, total } = (await app.store.listDocuments(req.query.limit, req.query.offset));
    return { total, limit: req.query.limit, offset: req.query.offset, items };
  });

  app.get("/documents/:id", { schema: { params: IdParams, response: { 200: DocumentOut, 304: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const doc = (await app.store.getDocument(req.params.id));
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const etag = docs.etagOf(doc);
    if (req.headers["if-none-match"] === etag) return reply.code(304).header("ETag", etag).send(null);
    return reply.header("ETag", etag).send(present(doc));
  });

  app.delete("/documents/:id", { schema: { params: IdParams, response: { 204: z.null(), ...errors(400, 403, 404, 500) } } }, async (req, reply) => {
    const doc = await app.store.getDocument(req.params.id);
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if (doc.sample) return reply.problem({ type: "SAMPLE_READ_ONLY", id: doc.id });
    if (!(await app.store.deleteDocument(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return reply.code(204).send(null);
  });

  app.patch("/documents/:id", { schema: { params: IdParams, body: ChangesBody, response: { 200: ReceiptOut, ...errors(400, 403, 404, 409, 412, 413, 422, 500) } } }, async (req, reply) => {
    const r = await docs.apply(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!r.ok) return reply.problem(r.error);
    // From the receipt, never a re-read: a writer (or a delete) can land between our commit and this line.
    reply.header("ETag", docs.etagOf({ version: r.value.version, contentHash: r.value.afterHash }));
    return receiptFor(req, reply, r.value);
  });

  // Dry run through the exact same engine call as PATCH. Persists nothing and
  // reserves nothing: PATCH re-validates against whatever version is current.
  app.post("/documents/:id/changes/preview", { schema: { params: IdParams, body: ChangesBody, response: { 200: PreviewOut, ...errors(400, 404, 409, 412, 413, 422, 500) } } }, async (req, reply) => {
    const p = await docs.preview(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!p.ok) return reply.problem(p.error);
    const { doc, result } = p.value;
    const head = { id: doc.id, version: doc.version, wouldChange: result.changed, applied: result.applied, beforeHash: doc.contentHash, afterHash: sha256(result.content) };
    // Minimal: just the changed spans. A client holding version `doc.version` can rebuild the text from them, and a
    // unified diff of the whole document (built only on request) is not needed to render a redline.
    if (wantsMinimal(req, reply)) return head;
    return { ...head, proposedContent: result.content, diff: createPatch(doc.title, doc.content, result.content, `v${doc.version}`, "proposed", { context: 3 }) };
  });

  // Undo: restore an old version's text as a new version. Same preconditions and response as PATCH.
  app.post("/documents/:id/revert", { schema: { params: IdParams, body: RevertBody, response: { 200: ReceiptOut, ...errors(400, 403, 404, 409, 412, 500) } } }, async (req, reply) => {
    const r = await docs.revert(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!r.ok) return reply.problem(r.error);
    reply.header("ETag", docs.etagOf({ version: r.value.version, contentHash: r.value.afterHash }));
    return receiptFor(req, reply, r.value);
  });

  // Word redline: native tracked changes (<w:ins>/<w:del>) between two versions. Read-only.
  app.get("/documents/:id/export.docx", { schema: { params: IdParams, querystring: ExportQuery, response: errors(400, 404, 413, 422, 500) } }, async (req, reply) => {
    const doc = (await app.store.getDocument(req.params.id));
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const toV = req.query.to ?? doc.version;
    const fromV = req.query.from ?? 1;
    if (fromV >= toV) return reply.problem({ type: "INVALID_VERSION_RANGE", from: fromV, to: toV });
    const from = (await app.store.getRevision(doc.id, fromV));
    if (!from) return reply.problem({ type: "REVISION_NOT_FOUND", id: doc.id, version: fromV });
    const to = (await app.store.getRevision(doc.id, toV));
    if (!to) return reply.problem({ type: "REVISION_NOT_FOUND", id: doc.id, version: toV });
    const chars = Math.max(from.content.length, to.content.length);
    if (chars > MAX_EXPORT_CHARS) return reply.problem({ type: "TOO_LARGE_TO_EXPORT", chars, max: MAX_EXPORT_CHARS });

    const buffer = await redlineDocx({ title: doc.title, from, to });
    const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .header("content-disposition", `attachment; filename="${slug}-v${fromV}-to-v${toV}-redline.docx"`)
      .send(buffer as never);
  });

  app.get("/documents/:id/revisions", { schema: { params: IdParams, response: { 200: z.object({ items: z.array(RevisionInfoOut) }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.getDocument(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return { items: (await app.store.listRevisions(req.params.id)) };
  });

  app.get("/documents/:id/revisions/:version", { schema: { params: IdParams.extend({ version: VersionParam }), response: { 200: RevisionInfoOut.extend({ content: z.string() }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const rev = (await app.store.getRevision(req.params.id, req.params.version));
    if (!rev) return reply.problem((await app.store.getDocument(req.params.id)) ? { type: "REVISION_NOT_FOUND", id: req.params.id, version: req.params.version } : { type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return rev;
  });
}
