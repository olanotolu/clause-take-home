import { buildApp } from "./app.ts";
import { dbPathFromEnv } from "./config.ts";
import { providerFromEnv } from "./suggest.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = dbPathFromEnv();

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

// AI suggestions are optional: enabled only when credentials exist (OPENROUTER_API_KEY, or AI Gateway credentials).
// Everything else works without them.
const suggestionProvider = providerFromEnv(process.env);
const app = await buildApp({ dbPath, logger: true, ...(suggestionProvider && { suggestionProvider }) });
app.log.info(suggestionProvider ? `AI suggestions enabled (${suggestionProvider.model})` : "AI suggestions disabled (no OPENROUTER_API_KEY or AI Gateway credentials)");
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
