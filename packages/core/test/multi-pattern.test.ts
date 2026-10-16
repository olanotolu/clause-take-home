import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findMatches, findMatchesMany, MULTI_PATTERN_MIN } from "../src/resolve.ts";
import type { QuoteSelector } from "../src/types.ts";
import { err, ok, q } from "./helpers.ts";

const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261015;

// Tiny alphabet so patterns overlap, share prefixes and suffixes, and repeat; surrogate pairs included on purpose.
const unit = fc.constantFrom("a", "b", "ab", " ", "🎉");
const textArb = fc.string({ unit, maxLength: 80 });
const piece = fc.string({ unit, minLength: 1, maxLength: 6 });
const selectorArb = fc.record(
  { exact: piece, prefix: fc.string({ unit, maxLength: 3 }), suffix: fc.string({ unit, maxLength: 3 }), occurrence: fc.integer({ min: 1, max: 6 }) },
  { requiredKeys: ["exact"] },
) as fc.Arbitrary<QuoteSelector>;

const plain = (m: ReturnType<typeof findMatches>) => ({ candidates: m.candidates, matchCount: m.matchCount, exactMatchCount: m.exactMatchCount, chosen: m.chosen });

describe("one automaton pass matches the per-selector indexOf scan exactly", () => {
  it("for random texts and selectors (prefix, suffix, occurrence, shared and overlapping patterns)", () => {
    fc.assert(
      fc.property(textArb, fc.array(selectorArb, { minLength: 1, maxLength: 24 }), (text, sels) => {
        const many = findMatchesMany(text, sels).map(plain);
        const one = sels.map((s) => plain(findMatches(text, s)));
        expect(many).toEqual(one);
      }),
      { seed, numRuns: 1000 },
    );
  });

  it("handles a pattern that is a suffix of another (dictionary links) and overlapping raw matches", () => {
    const text = "she sells shells; he shall shell";
    const sels: QuoteSelector[] = [{ exact: "he" }, { exact: "she" }, { exact: "hell" }, { exact: "shell" }, { exact: "ll" }, { exact: "s" }];
    expect(findMatchesMany(text, sels).map(plain)).toEqual(sels.map((s) => plain(findMatches(text, s))));
    expect(findMatchesMany("aaaa", [{ exact: "aa" }])[0]!.matchCount).toBe(2); // non-overlapping, like indexOf
  });

  it("returns no matches for text that contains none of the patterns", () => {
    const [m] = findMatchesMany("nothing to see", [{ exact: "absent" }]);
    expect(m).toMatchObject({ matchCount: 0, exactMatchCount: 0, candidates: [], chosen: undefined });
  });
});

describe("large batches resolve through one pass", () => {
  const clauses = Array.from({ length: 60 }, (_, i) => `Clause ${i}: item ${i} is confidential.`).join("\n");

  it(`applies a batch of ${MULTI_PATTERN_MIN}+ quote changes, including two targets that share one exact string`, () => {
    const changes = Array.from({ length: 30 }, (_, i) => q(`item ${i * 2} is`, `item ${i * 2} was`));
    changes.push(q("confidential", "SECRET", { occurrence: 2 }), q("confidential", "SECRET", { occurrence: 3 }));
    const r = ok(clauses, changes);
    expect(r.applied).toHaveLength(32);
    expect(r.content).toContain("item 0 was confidential");
    expect(r.content).toContain("item 1 is SECRET");
    expect(r.content).toContain("item 2 was SECRET");
    expect(r.content).toContain("item 3 is confidential");
  });

  it("still reports the first failing change in request order", () => {
    const changes = Array.from({ length: 30 }, (_, i) => q(`item ${i} is`, `item ${i} was`));
    changes[7] = q("not in the text", "x");
    changes[12] = q("Clause", "Section"); // ambiguous, but later in the request
    expect(err(clauses, changes)).toMatchObject({ type: "TARGET_NOT_FOUND", index: 7 });
  });
});
