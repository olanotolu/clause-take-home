import type { App } from "../types.ts";
import { IdParams, ScopedSearchOut, ScopedSearchQuery, SearchPageOut, SearchQuery, errors } from "../schemas.ts";
import { InvalidQueryError, search } from "../search.ts";


export function registerSearchRoutes(app: App): void {
  // "search" is never read as an :id: Fastify's router matches a static segment before a parameter, whatever the
  // registration order.
  app.get("/documents/search", { schema: { querystring: SearchQuery, response: { 200: SearchPageOut, ...errors(400, 500) } } }, async (req, reply) => {
    const { q, mode, ids, limit, offset } = req.query;
    try {
      return await search(app.store, q, { mode, limit, offset, ids: ids?.split(",").filter(Boolean) });
    } catch (e) {
      if (e instanceof InvalidQueryError) return reply.code(400).send({ error: e.message, code: 400, type: "INVALID_QUERY" });
      throw e;
    }
  });

  app.get("/documents/:id/search", { schema: { params: IdParams, querystring: ScopedSearchQuery, response: { 200: ScopedSearchOut, ...errors(400, 404, 500) } } }, async (req, reply) => {
    const { id } = req.params;
    if (!(await app.store.getDocument(id))) return reply.problem({ type: "DOCUMENT_NOT_FOUND", id });
    const { q, mode, limit } = req.query;
    try {
      const page = await search(app.store, q, { mode, limit: 1, offset: 0, ids: [id], hitsPerDocument: limit });
      return { query: page.query, mode, documentId: id, result: page.results[0] ?? null };
    } catch (e) {
      if (e instanceof InvalidQueryError) return reply.code(400).send({ error: e.message, code: 400, type: "INVALID_QUERY" });
      throw e;
    }
  });
}
