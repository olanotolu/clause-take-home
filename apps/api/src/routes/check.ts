import { AI_REQUEST_TIMEOUT_MS } from "../ai-deadline.ts";
import { runCi } from "../review/runner.ts";
import type { SemanticEvaluator } from "../review/types.ts";
import { CheckBody, CiReportOut, IdParams, errors } from "../schemas.ts";
import type { App } from "../types.ts";

export function registerCheckRoutes(app: App, semantic: SemanticEvaluator, limit: { max: number; timeWindow: string }, timeoutMs = AI_REQUEST_TIMEOUT_MS): void {
  /**
   * CLAUSE CI: preview the edit, then run the document's requirements (and the optional goal) against the current and
   * the proposed text. Read-only: nothing is saved, and the report only informs; committing is still PATCH.
   */
  app.post(
    "/documents/:id/changes/check",
    { config: { rateLimit: limit }, schema: { params: IdParams, body: CheckBody, response: { 200: CiReportOut, ...errors(400, 404, 409, 412, 413, 422, 429, 500) } } },
    async (req, reply) => {
      const r = await runCi(app.store, req.params.id, { ...req.body, ifMatch: req.headers["if-match"], signal: AbortSignal.timeout(timeoutMs) }, semantic);
      if (!r.ok) return reply.problem(r.error);
      return r.value;
    },
  );
}
