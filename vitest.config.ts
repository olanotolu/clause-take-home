import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "bench/**/*.test.ts"], testTimeout: 20000 },
});
