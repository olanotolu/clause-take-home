import { ActivityOut, ActivityQuery, errors } from "../schemas.ts";
import type { App } from "../types.ts";

/** The most recent versions across ALL documents. Only edits are recorded: CI runs and AI suggestions leave no trace. */
export function registerActivityRoutes(app: App): void {
  app.get("/activity", { schema: { querystring: ActivityQuery, response: { 200: ActivityOut, ...errors(400, 500) } } }, async (req) => ({ items: await app.store.listRecentRevisions(req.query.limit) }));
}

