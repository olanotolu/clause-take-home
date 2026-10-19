import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions } from "../src/app.ts";
import { lazyStore } from "../src/store/lazy.ts";
import { createPostgresStore, POSTGRES_MAX_CONTENT_CHARS } from "../src/store/postgres.ts";
import { createSqliteStore } from "../src/store/sqlite.ts";
import type { Store } from "../src/store/types.ts";

/**
 * The same suite runs against either backend. Set CLAUSE_TEST_DATABASE_URL to a Postgres to test that one; each test
 * gets its own schema, so tests can run in parallel against a single database.
 */
export const TEST_PG_URL = process.env.CLAUSE_TEST_DATABASE_URL;
export const usingPostgres = Boolean(TEST_PG_URL);
const schemaName = () => `t_${randomBytes(6).toString("hex")}`;

export async function testStore(): Promise<Store> {
  if (TEST_PG_URL) return createPostgresStore({ connectionString: TEST_PG_URL, schema: schemaName(), dropSchemaOnClose: true, max: 4 });
  return createSqliteStore(":memory:");
}

export async function testApp(opts: Omit<AppOptions, "store" | "dbPath"> = {}): Promise<FastifyInstance> {
  return buildApp({ store: lazyStore({kind:usingPostgres?"postgres":"sqlite",maxContentChars:usingPostgres?POSTGRES_MAX_CONTENT_CHARS:Number.POSITIVE_INFINITY},testStore), ...opts });
}

/** Two independent connections to ONE database, for race tests (a single connection would serialise everything). */
export async function sharedStores(): Promise<{ a: Store; b: Store; cleanup: () => Promise<void> }> {
  if (TEST_PG_URL) {
    const schema = schemaName();
    const a = await createPostgresStore({ connectionString: TEST_PG_URL, schema, dropSchemaOnClose: true, max: 2 });
    const b = await createPostgresStore({ connectionString: TEST_PG_URL, schema, max: 2 });
    return { a, b, cleanup: async () => { await b.close(); await a.close(); } };
  }
  const dir = mkdtempSync(join(tmpdir(), "clause-"));
  const a = createSqliteStore(join(dir, "t.db"));
  const b = createSqliteStore(join(dir, "t.db"));
  return { a, b, cleanup: async () => { await a.close(); await b.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export async function createDoc(app: FastifyInstance, title: string, content: string) {
  const res = await app.inject({ method: "POST", url: "/documents", payload: { title, content } });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json() as { id: string; version: number; content: string; contentHash: string };
}

export const quote = (exact: string, replacement: string, extra: object = {}) => ({
  operation: "replace" as const,
  target: { quote: { exact, ...extra } },
  replacement,
});

export const patch = (app: FastifyInstance, id: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: "PATCH", url: `/documents/${id}`, payload: body as object, headers });

export const NDA = "Receiving Party shall not disclose Confidential Information. Disclosing Party shall not disclose Trade Secrets. Neither party shall not disclose the Term.";
