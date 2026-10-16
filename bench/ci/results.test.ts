import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The evaluator README links the detailed report. Replay the committed record without network calls and verify that
 * the report still matches its raw measurements.
 */
const root = join(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
interface Summary {
  judge: string; calls: number; errors: number;
  static: { n: number; accuracy: { p: number; lo: number; hi: number }; brier: number | null };
  regression: { usable: number; detected: number; falseAlarm: number };
  quotes: { total: number; verified: number };
}
const summaries = JSON.parse(read("bench/ci/results/summary.json")) as Summary[];
const baseline = summaries.find((s) => s.judge === "keyword-baseline")!;
const llm = summaries.find((s) => s.judge.startsWith("anthropic/"))!;
const report = read("bench/ci/RESULTS.md");
const pct = (x: number, digits = 1) => `${(x * 100).toFixed(digits)}%`;

describe("committed benchmark record", () => {
  it("covers both judges on the same 150 calls, with no errors, and every call is in the raw log", () => {
    for (const s of [baseline, llm]) {
      expect(s.calls).toBe(150);
      expect(s.errors).toBe(0);
    }
    expect(read("bench/ci/results/raw-llm.jsonl").trim().split("\n")).toHaveLength(150);
    expect(read("bench/ci/results/raw-keyword-baseline.jsonl").trim().split("\n")).toHaveLength(150);
  });

  it("matches the detailed report linked by the README", () => {
    expect(llm.static.n).toBe(60);
    expect(report).toContain(`${pct(baseline.static.accuracy.p)} [${pct(baseline.static.accuracy.lo)}, ${pct(baseline.static.accuracy.hi)}]`);
    expect(report).toContain(`${pct(llm.static.accuracy.p)} [${pct(llm.static.accuracy.lo)}, ${pct(llm.static.accuracy.hi)}]`);
    expect(report).toContain(`(${baseline.regression.detected}/${baseline.regression.usable})`);
    expect(report).toContain(`(${llm.regression.detected}/${llm.regression.usable})`);
    expect(read("README.md")).toContain("bench/ci/RESULTS.md");
    expect(llm.regression.falseAlarm + baseline.regression.falseAlarm).toBe(0);
    expect(report).toContain(`(${llm.quotes.verified}/${llm.quotes.total})`);
    expect(llm.quotes.verified).toBe(llm.quotes.total);
    expect(baseline.quotes.verified).toBe(baseline.quotes.total);
    expect(llm.static.brier).toBeCloseTo(0.069, 3);
    expect(read("bench/ci/RESULTS.md")).toContain(String(llm.static.brier?.toFixed(3)));
  });

  it("supports the measured comparison: the model beats the keyword baseline, outside its interval", () => {
    expect(llm.static.accuracy.lo).toBeGreaterThan(baseline.static.accuracy.hi);
    expect(llm.regression.detected / llm.regression.usable).toBeGreaterThan(baseline.regression.detected / baseline.regression.usable);
  });
});
