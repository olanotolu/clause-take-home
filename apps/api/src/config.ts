import { join } from "node:path";

/** Same file whether you run from the repo root (`pnpm seed`) or from apps/api (`pnpm dev`). Override with CLAUSE_DB. */
export const DEFAULT_DB_PATH = join(import.meta.dirname, "../../../data/clause.db");
export const dbPathFromEnv = (): string => process.env.CLAUSE_DB ?? DEFAULT_DB_PATH;
