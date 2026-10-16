import { describe, expect, it } from "vitest";
import { brier, classReport, confusion, mulberry32, percentile, shuffle, wilson } from "./metrics.ts";

describe("wilson", () => {
  it("matches an independent implementation (statsmodels.proportion_confint, method='wilson', alpha=0.05)", () => {
    // Reference values were computed with statsmodels, not by this code. Tolerance covers z = 1.96 vs 1.959964.
    const cases: [number, number, number, number][] = [
      [81, 100, 0.722212, 0.874852],
      [0, 20, 0, 0.161125],
      [20, 20, 0.838875, 1],
      [15, 30, 0.331541, 0.668459],
    ];
    for (const [k, n, lo, hi] of cases) {
      const w = wilson(k, n);
      expect(w.p).toBeCloseTo(k / n, 9);
      expect(w.lo).toBeCloseTo(lo, 4);
      expect(w.hi).toBeCloseTo(hi, 4);
    }
  });
  it("is sensible at the extremes, where the normal approximation breaks", () => {
    const zero = wilson(0, 20);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0.1); // 0/20 does NOT mean "0% for sure"
    const all = wilson(20, 20);
    expect(all.hi).toBe(1);
    expect(all.lo).toBeLessThan(0.9);
    expect(Number.isNaN(wilson(0, 0).p)).toBe(true);
  });
  it("narrows as the sample grows", () => {
    const small = wilson(15, 30);
    const big = wilson(150, 300);
    expect(big.hi - big.lo).toBeLessThan(small.hi - small.lo);
  });
});

describe("percentile / brier", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
    expect(percentile([7], 0.5)).toBe(7);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
  it("brier: perfect = 0, coin-flip = 0.25, confidently wrong = 1", () => {
    expect(brier([{ p: 1, outcome: true }, { p: 0, outcome: false }])).toBe(0);
    expect(brier([{ p: 0.5, outcome: true }, { p: 0.5, outcome: false }])).toBe(0.25);
    expect(brier([{ p: 0, outcome: true }])).toBe(1);
  });
});

describe("classReport", () => {
  const L = ["a", "b", "c"] as const;
  it("computes precision / recall / F1 / macro-F1 from a confusion matrix", () => {
    const m = confusion(L, [
      ...Array(8).fill({ truth: "a", pred: "a" }),
      ...Array(2).fill({ truth: "a", pred: "b" }),
      ...Array(5).fill({ truth: "b", pred: "b" }),
      ...Array(5).fill({ truth: "b", pred: "a" }),
      ...Array(10).fill({ truth: "c", pred: "c" }),
    ]);
    const r = classReport(L, m);
    expect(r.per.a).toMatchObject({ tp: 8, support: 10, predicted: 13 });
    expect(r.per.a.precision).toBeCloseTo(8 / 13, 6);
    expect(r.per.a.recall).toBeCloseTo(0.8, 6);
    expect(r.per.c.f1).toBe(1);
    expect(r.accuracy).toBeCloseTo(23 / 30, 6);
    const f = (p: number, q: number) => (2 * p * q) / (p + q);
    expect(r.macroF1).toBeCloseTo((f(8 / 13, 0.8) + f(5 / 7, 0.5) + 1) / 3, 6);
  });
  it("ignores classes with no true examples in the macro average", () => {
    const m = confusion(L, [{ truth: "a", pred: "a" }, { truth: "a", pred: "c" }]);
    expect(classReport(L, m).macroF1).toBeCloseTo(classReport(L, m).per.a.f1, 6);
  });
});

describe("seeded sampling", () => {
  it("is reproducible and depends on the seed", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(shuffle(xs, mulberry32(7))).toEqual(shuffle(xs, mulberry32(7)));
    expect(shuffle(xs, mulberry32(7))).not.toEqual(shuffle(xs, mulberry32(8)));
    expect([...shuffle(xs, mulberry32(7))].sort((a, b) => a - b)).toEqual(xs); // a permutation, nothing lost
    expect(xs[0]).toBe(0); // input untouched
  });
});
