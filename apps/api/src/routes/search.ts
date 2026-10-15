import type { App } from "../types.ts";
import * as repo from "../repo.ts";
import { IdParams, ScopedSearchQuery, SearchQuery } from "../schemas.ts";
import { InvalidQueryError, search } from "../search.ts";


export function registerSearchRoutes(app: App): void {
  // Registered before /documents/:id so "search" is never read as an id.
  app.get("/documents/search", { schema: { querystring: SearchQuery } }, async (req, reply) => {
    const { q, mode, ids, limit, offset } = req.query;
    try {
      return search(app.db, q, { mode, limit, offset, ids: ids?.split(",").filter(Boolean) });
    } catch (e) {
      if (e instanceof InvalidQueryError) return reply.code(400).send({ error: e.message, code: 400, type: "INVALID_QUERY" });
      throw e;
    }
  });

  app.get("/documents/:id/search", { schema: { params: IdParams, querystring: ScopedSearchQuery } }, async (req, reply) => {
    const { id } = req.params;
    if (!repo.getDocument(app.db, id)) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id });
    const { q, mode, limit } = req.query;
    try {
      const page = search(app.db, q, { mode, limit: 1, offset: 0, ids: [id], hitsPerDocument: limit });
      return { query: page.query, mode, documentId: id, result: page.results[0] ?? null };
    } catch (e) {
      if (e instanceof InvalidQueryError) return reply.code(400).send({ error: e.message, code: 400, type: "INVALID_QUERY" });
      throw e;
    }
  });
}
