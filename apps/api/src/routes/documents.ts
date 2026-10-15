import type { App } from "../types.ts";
import { sha256 } from "@clause/core";
import { createPatch } from "diff";
import { z } from "zod";
import * as docs from "../documents.ts";
import * as repo from "../repo.ts";
import { ChangesBody, CreateBody, DocumentOut, DocumentSummaryOut, IdParams, PageQuery, PreviewOut, RevertBody, VersionParam, ReceiptOut, RevisionInfoOut, errors } from "../schemas.ts";


const present = (d: repo.DocumentRecord) => ({
  id: d.id,
  title: d.title,
  content: d.content,
  version: d.version,
  contentHash: d.contentHash,
  createdAt: d.createdAt,
  updatedAt: d.updatedAt,
});

export function registerDocumentRoutes(app: App): void {
  app.post("/documents", { schema: { body: CreateBody, response: { 201: DocumentOut, ...errors(400, 413, 500) } } }, async (req, reply) => {
    const doc = docs.createDocument(app.db, req.body);
    return reply.code(201).header("ETag", docs.etagOf(doc)).header("Location", `/documents/${doc.id}`).send(present(doc));
  });

  app.get("/documents", { schema: { querystring: PageQuery, response: { 200: z.object({ total: z.number().int(), limit: z.number().int(), offset: z.number().int(), items: z.array(DocumentSummaryOut) }), ...errors(400, 500) } } }, async (req) => {
    const { items, total } = repo.listDocuments(app.db, req.query.limit, req.query.offset);
    return { total, limit: req.query.limit, offset: req.query.offset, items };
  });

  app.get("/documents/:id", { schema: { params: IdParams, response: { 200: DocumentOut, 304: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const doc = repo.getDocument(app.db, req.params.id);
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    const etag = docs.etagOf(doc);
    if (req.headers["if-none-match"] === etag) return reply.code(304).header("ETag", etag).send(null);
    return reply.header("ETag", etag).send(present(doc));
  });

  app.delete("/documents/:id", { schema: { params: IdParams, response: { 204: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!repo.deleteDocument(app.db, req.params.id)) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return reply.code(204).send(null);
  });

  app.patch("/documents/:id", { schema: { params: IdParams, body: ChangesBody, response: { 200: ReceiptOut, ...errors(400, 404, 409, 412, 413, 422, 500) } } }, async (req, reply) => {
    const r = docs.apply(app.db, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!r.ok) return reply.problem(r.error);
    if (r.value.changed) {
      const doc = repo.getDocument(app.db, req.params.id)!;
      reply.header("ETag", docs.etagOf(doc));
    }
    return r.value;
  });

  // Dry run through the exact same engine call as PATCH. Persists nothing and
  // reserves nothing: PATCH re-validates against whatever version is current.
  app.post("/documents/:id/changes/preview", { schema: { params: IdParams, body: ChangesBody, response: { 200: PreviewOut, ...errors(400, 404, 409, 412, 413, 422, 500) } } }, async (req, reply) => {
    const p = docs.preview(app.db, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!p.ok) return reply.problem(p.error);
    const { doc, result } = p.value;
    return {
      id: doc.id,
      version: doc.version,
      wouldChange: result.changed,
      proposedContent: result.content,
      applied: result.applied,
      beforeHash: doc.contentHash,
      afterHash: sha256(result.content),
      diff: createPatch(doc.title, doc.content, result.content, `v${doc.version}`, "proposed", { context: 3 }),
    };
  });

  // Undo: restore an old version's text as a new version. Same preconditions and response as PATCH.
  app.post("/documents/:id/revert", { schema: { params: IdParams, body: RevertBody, response: { 200: ReceiptOut, ...errors(400, 404, 409, 412, 500) } } }, async (req, reply) => {
    const r = docs.revert(app.db, req.params.id, { ...req.body, ifMatch: req.headers["if-match"] });
    if (!r.ok) return reply.problem(r.error);
    if (r.value.changed) reply.header("ETag", docs.etagOf(repo.getDocument(app.db, req.params.id)!));
    return r.value;
  });

  app.get("/documents/:id/revisions", { schema: { params: IdParams, response: { 200: z.object({ items: z.array(RevisionInfoOut) }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!repo.getDocument(app.db, req.params.id)) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return { items: repo.listRevisions(app.db, req.params.id) };
  });

  app.get("/documents/:id/revisions/:version", { schema: { params: IdParams.extend({ version: VersionParam }), response: { 200: RevisionInfoOut.extend({ content: z.string() }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    const rev = repo.getRevision(app.db, req.params.id, req.params.version);
    if (!rev) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: `${req.params.id}@v${req.params.version}` });
    return rev;
  });
}
