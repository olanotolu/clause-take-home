import { z } from "zod";
import {
  ApplyPlaybookBody, ApplyPlaybookOut, IdParams, PlaybookBody, PlaybookDetailOut, PlaybookIdParams, PlaybookOut, PlaybookPatchBody, PlaybookRuleBody, PlaybookRuleOut, PlaybookRuleParams, PlaybookSummaryOut, errors,
} from "../schemas.ts";
import { MAX_PLAYBOOKS, MAX_RULES_PER_PLAYBOOK } from "../store/types.ts";
import type { App } from "../types.ts";

/** A playbook is a named, reusable set of requirements. Applying one copies its rules onto a document as ordinary requirements. */
export function registerPlaybookRoutes(app: App): void {
  app.get("/playbooks", { schema: { response: { 200: z.object({ items: z.array(PlaybookSummaryOut) }), ...errors(500) } } }, async () => ({ items: await app.store.listPlaybooks() }));

  app.post("/playbooks", { schema: { body: PlaybookBody, response: { 201: PlaybookOut, ...errors(400, 422, 500) } } }, async (req, reply) => {
    if ((await app.store.listPlaybooks()).length >= MAX_PLAYBOOKS) return reply.problem({ type: "PLAYBOOK_LIMIT", max: MAX_PLAYBOOKS });
    const created = await app.store.insertPlaybook(req.body);
    if (!created) return reply.problem({ type: "PLAYBOOK_LIMIT", max: MAX_PLAYBOOKS });
    return reply.code(201).header("Location", `/playbooks/${created.id}`).send(created);
  });

  app.get("/playbooks/:id", { schema: { params: PlaybookIdParams, response: { 200: PlaybookDetailOut, ...errors(400, 404, 500) } } }, async (req, reply) => {
    return (await app.store.getPlaybook(req.params.id)) ?? reply.problem({ type: "PLAYBOOK_NOT_FOUND", id: req.params.id });
  });

  app.patch("/playbooks/:id", { schema: { params: PlaybookIdParams, body: PlaybookPatchBody, response: { 200: PlaybookOut, ...errors(400, 404, 500) } } }, async (req, reply) => {
    return (await app.store.updatePlaybook(req.params.id, req.body)) ?? reply.problem({ type: "PLAYBOOK_NOT_FOUND", id: req.params.id });
  });

  app.delete("/playbooks/:id", { schema: { params: PlaybookIdParams, response: { 204: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.deletePlaybook(req.params.id))) return reply.problem({ type: "PLAYBOOK_NOT_FOUND", id: req.params.id });
    return reply.code(204).send(null);
  });

  app.post("/playbooks/:id/rules", { schema: { params: PlaybookIdParams, body: PlaybookRuleBody, response: { 201: PlaybookRuleOut, ...errors(400, 404, 422, 500) } } }, async (req, reply) => {
    const pb = await app.store.getPlaybook(req.params.id);
    if (!pb) return reply.problem({ type: "PLAYBOOK_NOT_FOUND", id: req.params.id });
    // The store serializes and enforces the cap; this read provides a quick friendly response in the usual case.
    if (pb.rules.length >= MAX_RULES_PER_PLAYBOOK) return reply.problem({ type: "PLAYBOOK_RULE_LIMIT", max: MAX_RULES_PER_PLAYBOOK });
    const rule = await app.store.addPlaybookRule(pb.id, req.body);
    if (!rule) return reply.problem({ type: "PLAYBOOK_RULE_LIMIT", max: MAX_RULES_PER_PLAYBOOK });
    return reply.code(201).send(rule);
  });

  app.delete("/playbooks/:id/rules/:rid", { schema: { params: PlaybookRuleParams, response: { 204: z.null(), ...errors(400, 404, 500) } } }, async (req, reply) => {
    if (!(await app.store.deletePlaybookRule(req.params.id, req.params.rid))) return reply.problem({ type: "PLAYBOOK_RULE_NOT_FOUND", id: req.params.rid });
    return reply.code(204).send(null);
  });

  /**
   * Copies a playbook's rules onto a document as requirements. Rules the document already has (same kind and text) are
   * skipped, and so is anything past the per-document limit; the response says which and why. Nothing else changes.
   */
  app.post("/documents/:id/apply-playbook", { schema: { params: IdParams, body: ApplyPlaybookBody, response: { 200: ApplyPlaybookOut, ...errors(400, 403, 404, 500) } } }, async (req, reply) => {
    const doc = await app.store.getDocumentMetadata(req.params.id);
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if (doc.sample) return reply.problem({ type: "SAMPLE_READ_ONLY", id: doc.id });
    const pb = await app.store.getPlaybook(req.body.playbookId);
    if (!pb) return reply.problem({ type: "PLAYBOOK_NOT_FOUND", id: req.body.playbookId });
    return app.store.applyPlaybookRequirements(req.params.id, pb.rules);
  });
}
