import { z } from "zod";
import { IdParams, RequirementBody, RequirementIdParams, RequirementOut, errors } from "../schemas.ts";
import { MAX_REQUIREMENTS_PER_DOCUMENT } from "../store/types.ts";
import type { App } from "../types.ts";

/** Requirements are the document's "test suite": saved conditions every proposed edit is checked against. */
export function registerRequirementRoutes(app: App): void {
  app.get("/documents/:id/requirements", { schema: { params: IdParams, response: { 200: z.object({ items: z.array(RequirementOut), max: z.number().int() }), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.getDocument(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    return { items: await app.store.listRequirements(req.params.id), max: MAX_REQUIREMENTS_PER_DOCUMENT };
  });

  app.post("/documents/:id/requirements", { schema: { params: IdParams, body: RequirementBody, response: { 201: RequirementOut, ...errors(400, 404, 422, 500) } } }, async (req, reply) => {
    if (!(await app.store.getDocument(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    // A soft cap: two simultaneous adds at 7 could both succeed. The cap exists to bound cost, not to be a hard invariant.
    if ((await app.store.listRequirements(req.params.id)).length >= MAX_REQUIREMENTS_PER_DOCUMENT) return reply.problem({ type: "REQUIREMENT_LIMIT", max: MAX_REQUIREMENTS_PER_DOCUMENT });
    const created = await app.store.addRequirement(req.params.id, req.body);
    return reply.code(201).header("Location", `/documents/${req.params.id}/requirements/${created.id}`).send(created);
  });

  app.delete("/documents/:id/requirements/:rid", { schema: { params: RequirementIdParams, response: { 204: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.getDocument(req.params.id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if (!(await app.store.deleteRequirement(req.params.id, req.params.rid))) return reply.problem({ type: "REQUIREMENT_NOT_FOUND", id: req.params.rid });
    return reply.code(204).send(null);
  });
}
