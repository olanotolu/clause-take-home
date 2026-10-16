import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCases, type CasesFile } from "./build-cases.ts";
import { annotationsOf, loadSplit } from "./dataset.ts";

const dataPresent = existsSync(join(import.meta.dirname, "data", "contract-nli", "test.json"));
const committed = JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")) as CasesFile;

describe.skipIf(!dataPresent)("benchmark cases (need the dataset: node bench/ci/fetch-data.ts)", () => {
  it("the committed cases.json is exactly what the seeded builder produces (no hand edits, no drift)", () => {
    expect(buildCases()).toEqual(committed);
  });

  it("has the planned shape", () => {
    expect(committed.static).toHaveLength(60);
    expect(committed.dev).toHaveLength(60);
    expect(committed.regression).toHaveLength(30);
    for (const label of ["Entailment", "Contradiction", "NotMentioned"]) {
      expect(committed.static.filter((c) => c.label === label)).toHaveLength(20);
      expect(committed.dev.filter((c) => c.label === label)).toHaveLength(20);
    }
  });

  it("keeps dev and test apart: nothing tuned on dev can leak into the test items", () => {
    const testDocs = new Set([...committed.static.map((c) => c.docId), ...committed.regression.map((c) => c.docId)]);
    expect(committed.dev.some((c) => testDocs.has(c.docId))).toBe(false);
    const dev = loadSplit("dev");
    const test = loadSplit("test");
    const devIds = new Set(dev.documents.map((d) => d.id));
    // ContractNLI numbers documents per split file; assert the cases really come from the intended file
    expect(committed.dev.every((c) => devIds.has(c.docId))).toBe(true);
    expect(committed.static.every((c) => test.documents.some((d) => d.id === c.docId))).toBe(true);
  });

  it("regression pairs are well formed: evidence is real and entailed, controls avoid it, one pair per contract", () => {
    const test = loadSplit("test");
    const byId = new Map(test.documents.map((d) => [d.id, d]));
    expect(new Set(committed.regression.map((p) => p.docId)).size).toBe(30);
    for (const p of committed.regression) {
      const doc = byId.get(p.docId)!;
      const ann = annotationsOf(doc)[p.hypothesis]!;
      expect(ann.choice).toBe("Entailment");
      expect(p.evidenceSpans.length).toBeGreaterThan(0);
      expect(p.controlSpans).toHaveLength(3);
      const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
      for (const c of p.controlSpans) for (const e of p.evidenceSpans) expect(overlaps(c, e), `${p.id}`).toBe(false);
      for (const [, e] of [...p.evidenceSpans, ...p.controlSpans]) expect(e).toBeLessThanOrEqual(doc.text.length);
    }
  });
});
