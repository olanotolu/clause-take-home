import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCases, type CasesFile } from "./build-cases.ts";
import { annotationsOf, loadSplit } from "./dataset.ts";
import { loadCuadSplit } from "./cuad-dataset.ts";

const dataPresent = existsSync(join(import.meta.dirname, "data", "contract-nli", "test.json")) && existsSync(join(import.meta.dirname, "data", "cuad", "test.json"));
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

  it("freezes CUAD test examples deterministically with category and label balance where available", () => {
    const testItems = loadCuadSplit("test");
    const byId = new Map(testItems.map((x) => [x.id, x]));
    expect(committed.meta.cuadZipSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(committed.meta.maxCuadDocChars).toBe(20_000);
    expect(committed.cuadStatic.length).toBeGreaterThanOrEqual(70);
    expect(committed.cuadStatic.every((c) => byId.has(c.id.slice("cuad-test-".length)))).toBe(true);
    for (const c of committed.cuadStatic) {
      const item = byId.get(c.id.slice("cuad-test-".length))!;
      expect(item.text.length).toBeLessThanOrEqual(committed.meta.maxCuadDocChars);
      expect(c.documentId).toBe(item.documentId);
      expect(c.category).toBe(item.category);
      expect(c.hasClause).toBe(item.hasClause);
    }
    for (const category of new Set(committed.cuadStatic.map((c) => c.category))) {
      const rows = committed.cuadStatic.filter((c) => c.category === category);
      expect(rows.length).toBeLessThanOrEqual(2);
      expect(new Set(rows.map((c) => c.hasClause)).size).toBe(rows.length === 2 ? 2 : 1);
    }
  });

  it("keeps CUAD development contracts disjoint from the frozen test contracts", () => {
    const testIds = new Set(committed.cuadStatic.map((c) => c.documentId));
    const trainIds = new Set(loadCuadSplit("train").map((c) => c.documentId));
    expect(committed.cuadDev.every((c) => !testIds.has(c.documentId))).toBe(true);
    expect(committed.cuadDev.every((c) => trainIds.has(c.documentId))).toBe(true);
    expect(committed.cuadStatic.every((c) => !trainIds.has(c.documentId))).toBe(true);
    expect(committed.meta.note).toContain("CC BY 4.0");
  });
});
