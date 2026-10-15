import { defineConfig } from "vitest/config";

/** Mutation testing runs only the engine's own tests: the API suite isn't what proves engine correctness. */
export default defineConfig({ test: { include: ["packages/core/test/**/*.test.ts"] } });
