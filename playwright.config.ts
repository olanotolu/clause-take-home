import { defineConfig, devices } from "@playwright/test";

const API_PORT = 3177;
const WEB_PORT = 4177;

/**
 * Real-browser tests run against a throwaway stack: an in-memory SQLite API seeded with the sample contracts (no AI keys,
 * so only the mechanical Clause CI checks run) and the built web app served by `vite preview`. Nothing here touches the
 * hosted database or a developer's running servers.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false, // one shared in-memory database; each test creates what it needs, but order stays deterministic
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    {
      command: "node apps/api/src/server.ts",
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      env: { PORT: String(API_PORT), CLAUSE_DB: ":memory:", CLAUSE_SEED: "1", CLAUSE_CREATE_PER_HOUR: "10000", OPENROUTER_API_KEY: "", AI_GATEWAY_API_KEY: "" },
    },
    {
      command: `pnpm --filter @clause/web exec vite build && pnpm --filter @clause/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { CLAUSE_API: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
