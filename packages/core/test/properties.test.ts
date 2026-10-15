import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChanges, type Change } from "../src/index.ts";

// Reproducible: failures print the seed. Override with FC_SEED=... to replay.
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261015;
const params = { seed, numRuns: 500 };

// Small alphabet on purpose: collisions, repeats and surrogate pairs are the point.
const textArb = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "é", "🎉", "\u{10437}"), maxLength: 60 });
const replArb = fc.string({ unit: fc.constantFrom("x", "y", "", "🎉", "\n"), maxLength: 8 });

const positionChange = (text: string) =>
  fc
    .tuple(fc.nat(text.length), fc.nat(text.length), replArb)
    .map(([a, b, replacement]): Change => {
      const [start, end] = a <= b ? [a, b] : [b, a];
      return { operation: "replace", target: { position: { start, end, expectedText: text.slice(start, end) } }, replacement };
    });

const scenario = textArb.chain((text) =>
  fc.record({ text: fc.constant(text), changes: fc.array(positionChange(text), { minLength: 1, maxLength: 6 }) }),
);

/** Naive reference: apply right-to-left on a copy. Only valid for non-overlapping batches. */
function oracle(text: string, changes: Change[]): string {
  const spans = changes
    .map((c) => ("position" in c.target ? { s: c.target.position.start, e: c.target.position.end, r: c.replacement } : null)!)
    .sort((x, y) => y.s - x.s || y.e - x.e);
  let out = text;
  for (const { s, e, r } of spans) out = out.slice(0, s) + r + out.slice(e);
  return out;
}

const hasSplit = (t: string, o: number) => o > 0 && o < t.length && /[\ud800-\udbff]/.test(t[o - 1]!) && /[\udc00-\udfff]/.test(t[o]!);

describe("engine properties", () => {
  it("never mutates its inputs, whether it succeeds or fails", () => {
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        const before = JSON.stringify(changes);
        applyChanges(text, changes);
        expect(JSON.stringify(changes)).toBe(before);
      }),
      params,
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        expect(applyChanges(text, changes)).toEqual(applyChanges(text, changes));
      }),
      params,
    );
  });

  it("agrees with the naive right-to-left oracle whenever a batch is accepted", () => {
    let accepted = 0;
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        const r = applyChanges(text, changes);
        if (!r.ok) return;
        accepted++;
        expect(r.value.content).toBe(oracle(text, changes));
      }),
      params,
    );
    expect(accepted).toBeGreaterThan(50); // the property is not vacuous
  });

  it("preserves every character outside the changed spans", () => {
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        const r = applyChanges(text, changes);
        if (!r.ok) return;
        const { applied, content } = r.value;
        let srcCursor = 0;
        let dstCursor = 0;
        for (const a of applied) {
          expect(content.slice(dstCursor, a.newStart)).toBe(text.slice(srcCursor, a.start));
          srcCursor = a.end;
          dstCursor = a.newEnd;
        }
        expect(content.slice(dstCursor)).toBe(text.slice(srcCursor));
      }),
      params,
    );
  });

  it("reports newStart/newEnd that actually locate the replacement", () => {
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        const r = applyChanges(text, changes);
        if (!r.ok) return;
        for (const a of r.value.applied) {
          expect(r.value.content.slice(a.newStart, a.newEnd)).toBe(a.after);
          expect(text.slice(a.start, a.end)).toBe(a.before);
        }
      }),
      params,
    );
  });

  it("rejects batches containing overlaps or surrogate splits, and accepts the rest", () => {
    fc.assert(
      fc.property(scenario, ({ text, changes }) => {
        const spans = changes.map((c) => ("position" in c.target ? c.target.position : null)!);
        const splits = spans.some((s) => hasSplit(text, s.start) || hasSplit(text, s.end));
        const sorted = [...spans.keys()].sort((i, j) => spans[i]!.start - spans[j]!.start || spans[i]!.end - spans[j]!.end);
        let collides = false;
        for (let k = 1; k < sorted.length; k++) {
          const p = spans[sorted[k - 1]!]!;
          const n = spans[sorted[k]!]!;
          const bothInserts = p.start === p.end && n.start === n.end && p.start === n.start;
          if (bothInserts || n.start < p.end) collides = true;
        }
        expect(applyChanges(text, changes).ok).toBe(!splits && !collides);
      }),
      params,
    );
  });

  it("a quote target resolves exactly like the equivalent position target", () => {
    fc.assert(
      fc.property(
        textArb.filter((t) => t.length > 0),
        fc.nat(),
        fc.nat(),
        replArb,
        (text, a, b, replacement) => {
          const start = a % text.length;
          const end = start + 1 + (b % (text.length - start));
          const exact = text.slice(start, end);
          if (hasSplit(text, start) || hasSplit(text, end)) return;
          const viaQuote = applyChanges(text, [{ operation: "replace", target: { quote: { exact } }, replacement }]);
          if (!viaQuote.ok) return; // ambiguous: covered by unit tests
          const first = viaQuote.value.applied[0]!;
          const viaPos = applyChanges(text, [
            { operation: "replace", target: { position: { start: first.start, end: first.end, expectedText: exact } }, replacement },
          ]);
          expect(viaPos).toEqual(viaQuote);
        },
      ),
      params,
    );
  });
});
