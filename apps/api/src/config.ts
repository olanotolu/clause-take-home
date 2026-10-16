import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { lazyStore } from "./store/lazy.ts";
import { createPostgresStore, POSTGRES_MAX_CONTENT_CHARS } from "./store/postgres.ts";
import { createSqliteStore } from "./store/sqlite.ts";
import { SEED_DOCUMENTS } from "./seed-data.ts";
import { SEED_PLAYBOOKS, SEED_REQUESTS, seedDemoRequirements } from "./seed-workspace.ts";
import type { Store } from "./store/types.ts";

/** Same file whether you run from the repo root (`pnpm seed`) or from apps/api (`pnpm dev`). Override with CLAUSE_DB. */
export const DEFAULT_DB_PATH = join(import.meta.dirname, "../../../data/clause.db");

export type Backend = "sqlite" | "postgres";

/**
 * The build shown in Settings. Vercel only sets VERCEL_GIT_COMMIT_SHA when it can read git metadata from the deploy (it
 * arrives empty for a deploy made from a worktree), so a deploy script can pass CLAUSE_BUILD_SHA explicitly.
 */
export function buildVersion(env: Record<string, string | undefined>): string {
  return (env.CLAUSE_BUILD_SHA || env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "dev";
}

/**
 * Which backend to use. EXPLICIT on purpose: `vercel env pull` puts DATABASE_URL into .env.local, and a local
 * `pnpm dev`, seed or fuzz run must never silently write to the hosted database because that variable happens to exist.
 *   CLAUSE_STORAGE=postgres|sqlite   wins when set
 *   on Vercel (VERCEL is set)        postgres
 *   otherwise                        sqlite
 */
export function chooseBackend(env: Record<string, string | undefined>): Backend {
  if (env.CLAUSE_STORAGE === "postgres" || env.CLAUSE_STORAGE === "sqlite") return env.CLAUSE_STORAGE;
  if (env.CLAUSE_STORAGE) throw new Error(`CLAUSE_STORAGE must be "sqlite" or "postgres", got "${env.CLAUSE_STORAGE}"`);
  return env.VERCEL ? "postgres" : "sqlite";
}

export async function storeFromEnv(env: Record<string, string | undefined>, hooks: { onPool?: (pool: import("pg").Pool) => void } = {}): Promise<Store> {
  if (chooseBackend(env) === "postgres") {
    const url = env.DATABASE_URL ?? env.POSTGRES_URL;
    if (!url) throw new Error("Postgres storage selected but DATABASE_URL is not set");
    return createPostgresStore({ connectionString: url, max: Number(env.CLAUSE_PG_POOL_MAX ?? 3), ...(hooks.onPool && { onPool: hooks.onPool }) });
  }
  const path = env.CLAUSE_DB ?? DEFAULT_DB_PATH;
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  return createSqliteStore(path);
}

/**
 * The store the server uses: chosen by `chooseBackend`, connected on first use. With CLAUSE_SEED=1, any missing sample
 * contract is restored (an existing copy with the canonical text is adopted, never rewritten), and the playbook and
 * request tables are filled if empty. Each step is safe when several instances start together.
 */
export function lazyStoreFromEnv(env: Record<string, string | undefined>, hooks: { onPool?: (pool: import("pg").Pool) => void } = {}): Store {
  const kind = chooseBackend(env);
  return lazyStore({ kind, maxContentChars: kind === "postgres" ? POSTGRES_MAX_CONTENT_CHARS : Number.POSITIVE_INFINITY }, async () => {
    const store = await storeFromEnv(env, hooks);
    if (env.CLAUSE_SEED === "1") {
      await store.ensureSamples(SEED_DOCUMENTS);
      // Independent of the documents check, so a database seeded before these tables existed still gets them (once).
      await store.seedPlaybooksIfEmpty(SEED_PLAYBOOKS);
      await store.seedRequestsIfEmpty(SEED_REQUESTS);
      await seedDemoRequirements(store);
    }
    return store;
  });
}
