import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyzeUnchanged, applyChanges, checkAbsent, checkPresent, findAll, shiftedOffset, type Change } from "../src/index.ts";

describe("findAll", () => {
  it("finds non-overlapping literal occurrences left to right", () => {
    expect(findAll("abcabcabc", "abc")).toEqual([{ start: 0, end: 3 }, { start: 3, end: 6 }, { start: 6, end: 9 }]);
    expect(findAll("aaaa", "aa")).toEqual([{ start: 0, end: 2 }, { start: 2, end: 4 }]); // same rule as the edit engine
  });
  it("matches nothing for an empty needle, is case-sensitive and literal", () => {
    expect(findAll("abc", "")).toEqual([]);
    expect(findAll("Abc", "abc")).toEqual([]);
    expect(findAll("a.c abc", "a.c")).toEqual([{ start: 0, end: 3 }]);
  });
  it("caps how many it returns", () => {
    expect(findAll("x".repeat(100), "x", 5)).toHaveLength(5);
  });
});

describe("present / absent", () => {
  it("present passes with evidence spans that slice back to the needle", () => {
    const t = "The Receiving Party shall maintain confidentiality. Confidentiality survives.";
    const r = checkPresent(t, "confidentiality");
    expect(r.passed).toBe(true);
    for (const s of r.spans) expect(t.slice(s.start, s.end)).toBe("confidentiality");
    expect(checkPresent(t, "indemnify").passed).toBe(false);
  });
  it("absent is the exact complement, and a failure points at the offending text", () => {
    const t = "one two two";
    expect(checkAbsent(t, "three")).toEqual({ passed: true, spans: [] });
    const bad = checkAbsent(t, "two");
    expect(bad.passed).toBe(false);
    expect(bad.spans).toHaveLength(2);
  });
  it("present and absent always disagree", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ minLength: 1, maxLength: 4 }), (text, needle) => {
        expect(checkPresent(text, needle).passed).toBe(!checkAbsent(text, needle).passed);
      }),
      { seed: 20261015 },
    );
  });
});

const q = (exact: string, replacement: string): Change => ({ operation: "replace", target: { quote: { exact } }, replacement });

describe("analyzeUnchanged", () => {
  const before = "1. Term: three (3) years. 2. Compelled disclosure is permitted by law. 3. Governing law: Delaware.";

  it("reports the passage survives an edit elsewhere, and that nothing touched it", () => {
    const r = applyChanges(before, [q("Delaware", "New York")]);
    if (!r.ok) throw new Error();
    const a = analyzeUnchanged(before, r.value.content, "Compelled disclosure is permitted by law.", r.value.applied);
    expect(a).toMatchObject({ presentBefore: true, presentAfter: true, touchedBy: [] });
  });

  it("names the change that altered the passage", () => {
    const r = applyChanges(before, [q("Delaware", "New York"), q("permitted by law", "prohibited")]);
    if (!r.ok) throw new Error();
    const a = analyzeUnchanged(before, r.value.content, "Compelled disclosure is permitted by law.", r.value.applied);
    expect(a).toMatchObject({ presentBefore: true, presentAfter: false });
    expect(a.touchedBy).toEqual([1]); // the second change in the request
  });

  it("is vacuous (not present before) for a passage that was never there", () => {
    const a = analyzeUnchanged(before, before, "Indemnification", []);
    expect(a).toMatchObject({ presentBefore: false, presentAfter: false });
  });
});

describe("engine invariant behind `unchanged` (property)", () => {
  it("an occurrence no applied change overlaps is byte-identical in the new text at its shifted offset", () => {
    const text = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "é", "🎉"), maxLength: 50 });
    const scenario = text.chain((t) =>
      fc.record({
        t: fc.constant(t),
        passage: fc.string({ unit: fc.constantFrom("a", "b", "é"), minLength: 1, maxLength: 3 }),
        edits: fc.array(
          fc.tuple(fc.nat(t.length), fc.nat(t.length), fc.string({ unit: fc.constantFrom("x", "y", ""), maxLength: 4 })),
          { minLength: 1, maxLength: 4 },
        ),
      }),
    );
    let exercised = 0;
    fc.assert(
      fc.property(scenario, ({ t, passage, edits }) => {
        const changes: Change[] = edits.map(([x, y, replacement]) => {
          const [start, end] = x <= y ? [x, y] : [y, x];
          return { operation: "replace", target: { position: { start, end, expectedText: t.slice(start, end) } }, replacement };
        });
        const r = applyChanges(t, changes);
        if (!r.ok) return;
        const a = analyzeUnchanged(t, r.value.content, passage, r.value.applied);
        for (const s of a.beforeSpans) {
          const touched = r.value.applied.some((c) => c.start < s.end && s.start < c.end);
          if (touched) continue;
          exercised++;
          const at = shiftedOffset(s.start, r.value.applied);
          expect(r.value.content.slice(at, at + passage.length)).toBe(passage);
        }
      }),
      { seed: 20261015, numRuns: 500 },
    );
    expect(exercised).toBeGreaterThan(20); // not vacuous
  });
});
