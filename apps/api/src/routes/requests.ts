import { z } from "zod";
import { snapshotOf } from "../review/snapshot.ts";
import { runCi } from "../review/runner.ts";
import type { SemanticEvaluator } from "../review/types.ts";
import { RequestCheckOut, RequestCreateBody, RequestIdParams, RequestOut, RequestPatchBody, RequestStatusSchema, errors } from "../schemas.ts";
import type { App } from "../types.ts";

/**
 * Requests are units of legal work on one document: what was asked for, how urgent, where it stands. They are a
 * tracking layer only; nothing here edits a document. The one active action is a Clause CI audit of the CURRENT text.
 */
export function registerRequestRoutes(app: App, semantic: SemanticEvaluator, limit: { max: number; timeWindow: string }): void {
  app.get("/requests", { schema: { querystring: z.object({ status: RequestStatusSchema.optional() }), response: { 200: z.object({ items: z.array(RequestOut) }), ...errors(400, 500) } } }, async (req) => {
    const all = await app.store.listRequests();
    return { items: req.query.status ? all.filter((r) => r.status === req.query.status) : all };
  });

  app.post("/requests", { schema: { body: RequestCreateBody, response: { 201: RequestOut, ...errors(400, 404, 500) } } }, async (req, reply) => {
    const { documentId, ...rest } = req.body;
    if (documentId !== undefined && !(await app.store.getDocument(documentId))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: documentId });
    const created = await app.store.insertRequest({ documentId: documentId ?? null, ...rest });
    return reply.code(201).header("Location", `/requests/${created.id}`).send(created);
  });

  app.get("/requests/:id", { schema: { params: RequestIdParams, response: { 200: RequestOut, ...errors(400, 404, 500) } } }, async (req, reply) => {
    const r = await app.store.getRequest(req.params.id);
    return r ?? reply.problem({ type: "REQUEST_NOT_FOUND", id: req.params.id });
  });

  app.patch("/requests/:id", { schema: { params: RequestIdParams, body: RequestPatchBody, response: { 200: RequestOut, ...errors(400, 404, 500) } } }, async (req, reply) => {
    const r = await app.store.updateRequest(req.params.id, req.body);
    return r ?? reply.problem({ type: "REQUEST_NOT_FOUND", id: req.params.id });
  });

  app.delete("/requests/:id", { schema: { params: RequestIdParams, response: { 204: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.deleteRequest(req.params.id))) return reply.problem({ type: "REQUEST_NOT_FOUND", id: req.params.id });
    return reply.code(204).send(null);
  });

  /**
   * Audits the linked document's CURRENT text against its requirements and the request's goal, and stores what it found
   * on the request. Problems move an open request into Needs review; it never moves one to Completed (a person decides).
   */
  app.post("/requests/:id/check", { config: { rateLimit: limit }, schema: { params: RequestIdParams, response: { 200: RequestCheckOut, ...errors(400, 404, 409, 429, 500) } } }, async (req, reply) => {
    const request = await app.store.getRequest(req.params.id);
    if (!request) return reply.problem({ type: "REQUEST_NOT_FOUND", id: req.params.id });
    if (!request.documentId) return reply.problem({ type: "REQUEST_HAS_NO_DOCUMENT", id: request.id });
    const r = await runCi(app.store, request.documentId, { changes: [], goal: request.goal }, semantic);
    if (!r.ok) return reply.problem(r.error);
    const snapshot = snapshotOf(r.value);
    const moved = snapshot.attention > 0 && (request.status === "inbox" || request.status === "in_progress");
    const updated = (await app.store.updateRequest(request.id, { ci: snapshot, ...(moved && { status: "needs_review" as const }) }))!;
    return { request: updated, moved };
  });
}

