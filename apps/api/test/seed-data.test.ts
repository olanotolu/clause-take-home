import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SEED_DOCUMENTS } from "../src/seed-data.ts";

it("embedded seed data matches fixtures/*.txt (run `pnpm gen:seed` if this fails)", () => {
  const dir = join(import.meta.dirname, "../../../fixtures");
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".txt")).map((f) => readFileSync(join(dir, f), "utf8")).sort();
  expect(SEED_DOCUMENTS.map((d) => d.content).sort()).toEqual(onDisk);
  expect(SEED_DOCUMENTS).toHaveLength(5);
  expect(new Set(SEED_DOCUMENTS.map((d) => d.title)).size).toBe(5);
});
