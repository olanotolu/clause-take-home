import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, applyOrderedSpans, type AppliedChange, type Change } from "../src/index.ts";
import { ok, pos, q } from "./helpers.ts";

/**
 * The web app asks the server for a preview without the full text and rebuilds it from the reported spans. That is only
 * safe if the spans alone are enough: for the version they were computed against, applyOrderedSpans over them must give
 * exactly the text the engine produced.
 */
const rebuild = (text: string, applied: readonly AppliedChange[]) =>
  applyOrderedSpans(text, applied.map((a) => ({ index: a.index, start: a.start, end: a.end, replacement: a.after }))).content;

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261015;
const textArb = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "é", "🎉"), maxLength: 50 });
const replArb = fc.string({ unit: fc.constantFrom("x", "", "🎉", "\n"), maxLength: 6 });

describe("a preview's spans are enough to rebuild the proposed text", () => {
  it("for random position batches, including inserts, deletes and adjacent spans", () => {
    const scenario = textArb.chain((text) =>
      fc.record({
        text: fc.constant(text),
        changes: fc.array(
          fc.tuple(fc.nat(text.length), fc.nat(text.length), replArb).map(([a, b, r]): Change => {
            const [start, end] = a <= b ? [a, b] : [b, a];
            return pos(start, end, text.slice(start, end), r);
          }),
          { minLength: 1, maxLength: 5 },
        ),
      }),
    );
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        const r = applyChanges(text, changes);
        if (!r.ok) return; // overlapping batches are refused, so there is nothing to rebuild
        expect(rebuild(text, r.value.applied)).toBe(r.value.content);
      }),
      { seed, numRuns: 500 },
    );
  });

  it("for quote targets, in request order or not", () => {
    const text = "Alpha one. Beta two. Gamma three. Delta four.";
    const r = ok(text, [q("Delta four", "Delta 4"), q("Alpha one", "Alpha 1"), q("Beta two", "")]);
    expect(rebuild(text, r.applied)).toBe(r.content);
    expect(r.content).toBe("Alpha 1. . Gamma three. Delta 4.");
  });

  it("an unchanged batch rebuilds to the same text", () => {
    const text = "Nothing changes here.";
    const r = ok(text, [q("changes", "changes")]);
    expect(r.changed).toBe(false);
    expect(rebuild(text, r.applied)).toBe(text);
  });
});
