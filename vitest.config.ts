import { defineConfig } from "vitest/config";

// The same suite runs against SQLite (default) and Postgres (CLAUSE_TEST_DATABASE_URL, its own CI job). Each run only
// exercises one store, so each is judged on the code it can reach: the SQLite run gates the engine and the API, the
// Postgres run gates the Postgres store.
const withPostgres = Boolean(process.env.CLAUSE_TEST_DATABASE_URL);

export default defineConfig({
  resolve:{alias:{"@clause/engine":new URL("./packages/core/src/browser.ts",import.meta.url).pathname}},
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "bench/**/*.test.ts"],
    testTimeout: 20000,
    // Isolated Postgres tests each run migrations and create schemas. Limiting test workers avoids a thundering herd
    // on the disposable database while retaining parallel test files.
    ...(withPostgres ? { maxWorkers: 4 } : {}),
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: withPostgres ? ["apps/api/src/store/postgres.ts", "apps/api/src/store/maintenance-postgres.ts", "apps/api/src/store/pg-query.ts"] : ["packages/*/src/**", "apps/api/src/**", "apps/web/src/lib/**"],
      // Entry points and one-shot scripts have no logic to test. The screens are covered by the Playwright journeys,
      // which this report cannot see.
      exclude: ["apps/api/src/server.ts", "apps/api/src/seed.ts", "apps/api/src/ops.ts", "apps/api/src/nitro-handler.ts", "apps/api/src/jobs/heavy-entry.ts", ...(withPostgres ? [] : ["apps/api/src/store/postgres.ts", "apps/api/src/store/maintenance-postgres.ts", "apps/api/src/store/pg-query.ts"])],
      // Floors, set a little under what is measured, so a drop fails the build.
      thresholds: withPostgres
        ? { "apps/api/src/store/postgres.ts": { lines: 90, branches: 80 } }
        : { "packages/core/src/**": { lines: 98, branches: 95 }, "apps/api/src/**": { lines: 90, branches: 78 } },
    },
  },
});
