import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { resolveChanges, selectorFor } from "../src/index.ts";

const resolveTarget = (text: string, target: ReturnType<typeof selectorFor>) =>
  resolveChanges(text, [{ operation: "replace", target, replacement: "" }]);

describe("selectorFor", () => {
  it("uses a bare quote when the text is unique", () => {
    expect(selectorFor("hello world", 6, 11)).toEqual({ quote: { exact: "world", prefix: undefined, suffix: undefined } });
  });

  it("adds just enough context to disambiguate repeated text", () => {
    const text = "A shall not disclose X. B shall not disclose Y.";
    const target = selectorFor(text, 26, 44);
    expect("quote" in target && target.quote.prefix?.length).toBeGreaterThan(0);
    expect(resolveTarget(text, target)).toMatchObject({ ok: true, value: [{ start: 26, end: 44 }] });
  });

  it("falls back to a position selector when no quote can reach the span", () => {
    expect(selectorFor("aaaa", 1, 3)).toEqual({ position: { start: 1, end: 3, expectedText: "aa" } });
  });

  it("round-trips any non-split span of any text (property)", () => {
    const text = fc.string({ unit: fc.constantFrom("a", "b", " ", "é"), minLength: 1, maxLength: 80 });
    fc.assert(
      fc.property(text, fc.nat(), fc.nat(), (t, a, b) => {
        const start = a % t.length;
        const end = start + 1 + (b % (t.length - start));
        const r = resolveTarget(t, selectorFor(t, start, end));
        expect(r).toMatchObject({ ok: true });
        if (r.ok) expect([r.value[0]!.start, r.value[0]!.end]).toEqual([start, end]);
      }),
      { seed: 20261015, numRuns: 500 },
    );
  });
});
