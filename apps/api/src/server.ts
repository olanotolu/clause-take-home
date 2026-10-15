import { buildApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.CLAUSE_DB ?? "data/clause.db";

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

const app = await buildApp({ dbPath, logger: true });
await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
