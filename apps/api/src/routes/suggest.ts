import { createPatch } from "diff";
import { z } from "zod";
import * as docs from "../documents.ts";
import { toHttp } from "../errors.ts";
import { IdParams, SuggestOut, errors } from "../schemas.ts";
import { MAX_DOCUMENT_CHARS_FOR_SUGGESTION, scopeViolation, toChanges, type EditSuggestionProvider } from "../suggest.ts";
import type { App } from "../types.ts";

const Body = z.strictObject({ instruction: z.string().min(1).max(2000) });

export function registerSuggestRoutes(app: App, provider: EditSuggestionProvider | undefined, limit: { max: number; timeWindow: string }): void {
  /**
   * Proposes an edit. NEVER applies it: the response says `applied: false`, carries the
   * document version it was validated against, and the client commits through the normal
   * PATCH (which re-validates against whatever version is current).
   */
  app.post("/documents/:id/suggest", { config: { rateLimit: limit }, schema: { params: IdParams, body: Body, response: { 200: SuggestOut, ...errors(400, 404, 413, 429, 500, 502, 503) } } }, async (req, reply) => {
    const doc = (await app.store.getDocument(req.params.id));
    if (!doc) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id: req.params.id });
    if (!provider) {
      return reply.code(503).send({ error: "AI suggestions are not configured on this server", code: 503, type: "AI_UNAVAILABLE" });
    }
    if (doc.content.length > MAX_DOCUMENT_CHARS_FOR_SUGGESTION) {
      return reply.code(413).send({
        error: `Document is longer than ${MAX_DOCUMENT_CHARS_FOR_SUGGESTION} characters; refusing to show the model a truncated contract`,
        code: 413,
        type: "DOCUMENT_TOO_LARGE_FOR_SUGGESTION",
      });
    }

    let proposal;
    try {
      proposal = await provider.suggest({ document: doc.content, instruction: req.body.instruction });
    } catch (err) {
      req.log.error({ err }, "suggestion provider failed"); // logged server-side; details never sent to the client
      return reply.code(502).send({ error: "The suggestion provider failed", code: 502, type: "AI_PROVIDER_ERROR" });
    }

    const base = {
      status: "proposal" as const,
      applied: false as const,
      provider: provider.kind,
      model: provider.model,
      documentVersion: doc.version,
      rationale: proposal.rationale,
      changes: toChanges(proposal),
    };

    const violation = scopeViolation(proposal);
    if (violation) {
      return { ...base, validation: { valid: false as const, error: { type: "SCOPE_EXCEEDED", error: `Proposal rejected by policy: ${violation}` } } };
    }
    if (proposal.changes.length === 0) {
      return { ...base, validation: { valid: false as const, error: { type: "NO_CHANGES", error: "The model proposed no changes" } } };
    }

    // The exact same engine call a human PATCH goes through.
    const p = await docs.preview(app.store, doc.id, { expectedVersion: doc.version, changes: base.changes });
    if (!p.ok) {
      const { status: _status, ...error } = toHttp(p.error);
      return { ...base, validation: { valid: false as const, error } };
    }
    const { result } = p.value;
    return {
      ...base,
      validation: {
        valid: true as const,
        applied: result.applied,
        diff: createPatch(doc.title, doc.content, result.content, `v${doc.version}`, "proposed", { context: 3 }),
      },
    };
  });
}
