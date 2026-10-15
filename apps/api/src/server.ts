import { buildApp } from "./app.ts";
import { aiSdkProvider } from "./suggest.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.CLAUSE_DB ?? "data/clause.db";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

// AI suggestions are optional: enabled only when AI Gateway credentials exist. Everything else works without them.
const hasAi = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
const model = process.env.CLAUSE_SUGGEST_MODEL ?? "anthropic/claude-sonnet-5-5";
const app = await buildApp({ dbPath, logger: true, ...(hasAi && { suggestionProvider: aiSdkProvider(model) }) });
app.log.info(hasAi ? `AI suggestions enabled (${model})` : "AI suggestions disabled (no AI Gateway credentials)");
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
