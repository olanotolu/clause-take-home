import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { citationContext, reservation, renderReport, withinBudget } from "./run.ts";

describe("frozen citation experiment", () => {
  const dataset = JSON.parse(readFileSync(new URL("cases.json", import.meta.url), "utf8"));
  it("keeps dev and held-out cases balanced, unique, attributed, and bounded", () => {
    expect(new Set(dataset.cases.map((c: { id: string }) => c.id)).size).toBe(70);
    for (const split of ["dev", "test"]) for (const truth of ["supported", "contradicted", "unsupported"]) {
      expect(dataset.cases.filter((c: { split: string; truth: string }) => c.split === split && c.truth === truth)).toHaveLength(10);
    }
    expect(dataset.attribution).toContain("CC BY 4.0");
    for (const c of dataset.cases) {
      expect(c.context.length).toBeLessThanOrEqual(8000);
      if (c.truth !== "fabricated") {
        expect(c.context.slice(c.quoteStart - c.sourceStart, c.quoteEnd - c.sourceStart)).toBe(c.quote);
        expect(citationContext(c.context, c.quote)).not.toBeNull();
      } else expect(citationContext(c.context, c.quote)).toBeNull();
    }
  });
  it("rejects fabricated quotes and excessive context before inference", () => {
    expect(citationContext("A binding promise.", "A different promise.")).toBeNull();
    expect(citationContext("x".repeat(8001), "xxx")).toBeNull();
    expect(citationContext("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.", "Second paragraph.")).toEqual({ text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.", start: 0, end: 53 });
    expect(citationContext("First paragraph.", "First paragraph.")?.text).toBe("First paragraph.");
  });
  it("reserves input framing and maximum output, and reports an absent arm as unavailable", () => {
    expect(withinBudget(4.99, .01)).toBe(true);
    expect(withinBudget(4.99, .02)).toBe(false);
    expect(withinBudget(0, NaN)).toBe(false);
    expect(withinBudget(-1, .1)).toBe(false);
    expect(reservation("hello", { input: 1, output: 2 })).toBe(4503);
    const report = renderReport(dataset, []);
    expect(report).toContain("0/30");
    expect(report).toContain("100.0%");
    expect(report).toContain("unattempted cases");
  });
});
