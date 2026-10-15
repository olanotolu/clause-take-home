import { describe, expect, it } from "vitest";
import { applyChanges } from "../src/index.ts";
import { err, ok, pos, q } from "./helpers.ts";

const NDA = "A shall not disclose X. B shall not disclose Y. C shall not disclose Z.";

describe("quote targets", () => {
  it("replaces a unique phrase", () => {
    expect(ok("hello world", [q("world", "there")]).content).toBe("hello there");
  });

  it("replaces the requested occurrence and only that one", () => {
    const r = ok(NDA, [q("shall not disclose", "may disclose", { occurrence: 2 })]);
    expect(r.content).toBe("A shall not disclose X. B may disclose Y. C shall not disclose Z.");
  });

  it("numbers occurrences from 1 and handles alpha beta alpha beta alpha", () => {
    const t = "alpha beta alpha beta alpha";
    expect(ok(t, [q("alpha", "A", { occurrence: 1 })]).content).toBe("A beta alpha beta alpha");
    expect(ok(t, [q("alpha", "A", { occurrence: 3 })]).content).toBe("alpha beta alpha beta A");
  });

  it("rejects an ambiguous target and lists candidates the client can choose from", () => {
    const e = err(NDA, [q("shall not disclose", "x")]);
    expect(e).toMatchObject({ type: "AMBIGUOUS_TARGET", matchCount: 3, index: 0 });
    if (e.type === "AMBIGUOUS_TARGET") {
      expect(e.candidates.map((c) => c.start)).toEqual([2, 26, 50]);
      for (const c of e.candidates) expect(NDA.slice(c.start, c.end)).toBe("shall not disclose");
    }
  });

  it("rejects missing text", () => {
    expect(err("abc", [q("zzz", "x")])).toMatchObject({ type: "TARGET_NOT_FOUND", exactMatchCount: 0 });
  });

  it("rejects an occurrence that does not exist", () => {
    expect(err(NDA, [q("shall not disclose", "x", { occurrence: 4 })])).toMatchObject({
      type: "OCCURRENCE_OUT_OF_RANGE",
      matchCount: 3,
    });
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid occurrence %s", (occurrence) => {
    expect(err(NDA, [q("shall", "x", { occurrence })]).type).toBe("INVALID_RANGE");
  });

  it("rejects an empty literal target", () => {
    expect(err("abc", [q("", "x")])).toEqual({ type: "EMPTY_TARGET", index: 0 });
  });

  it("is literal: regex metacharacters are not interpreted", () => {
    expect(ok("a.c abc", [q("a.c", "X")]).content).toBe("X abc");
    expect(ok("(x)+", [q("(x)+", "y")]).content).toBe("y");
  });

  it("is case-sensitive", () => {
    expect(err("Hello", [q("hello", "x")]).type).toBe("TARGET_NOT_FOUND");
  });
});

describe("prefix / suffix context anchors", () => {
  const T = "Receiving Party shall not disclose Confidential. Disclosing Party shall not disclose Secrets.";

  it("disambiguates by prefix", () => {
    const r = ok(T, [q("shall not disclose", "may disclose", { prefix: "Disclosing Party " })]);
    expect(r.content).toBe("Receiving Party shall not disclose Confidential. Disclosing Party may disclose Secrets.");
  });

  it("disambiguates by suffix", () => {
    const r = ok(T, [q("shall not disclose", "may disclose", { suffix: " Confidential" })]);
    expect(r.content.startsWith("Receiving Party may disclose Confidential.")).toBe(true);
  });

  it("reports when context rules out every exact match", () => {
    expect(err(T, [q("shall not disclose", "x", { prefix: "Nobody " })])).toMatchObject({
      type: "TARGET_NOT_FOUND",
      exactMatchCount: 2,
    });
  });

  it("still reports ambiguity when context matches more than one passage", () => {
    expect(err(T, [q("shall not disclose", "x", { prefix: "Party " })])).toMatchObject({
      type: "AMBIGUOUS_TARGET",
      matchCount: 2,
    });
  });

  it("counts occurrence among context-matching passages", () => {
    const r = ok(T, [q("shall not disclose", "may", { prefix: "Party ", occurrence: 2 })]);
    expect(r.content).toContain("Disclosing Party may Secrets");
  });
});

describe("position targets", () => {
  it("replaces a valid range", () => {
    expect(ok("0123456789", [pos(2, 5, "234", "X")]).content).toBe("01X56789");
  });

  it("rejects out-of-bounds, negative, inverted and non-integer ranges", () => {
    expect(err("abc", [pos(1, 9, "bc", "x")])).toMatchObject({ type: "INVALID_RANGE" });
    expect(err("abc", [pos(-1, 2, "ab", "x")])).toMatchObject({ type: "INVALID_RANGE" });
    expect(err("abc", [pos(2, 1, "", "x")])).toMatchObject({ type: "INVALID_RANGE" });
    expect(err("abc", [pos(0.5, 2, "ab", "x")])).toMatchObject({ type: "INVALID_RANGE" });
  });

  it("rejects a range ending exactly one past the document, even if expectedText equals the slice", () => {
    // regression: a mutated bounds check (`end > length + 1`) survived the first test suite
    expect(err("abc", [pos(1, 4, "bc", "x")])).toMatchObject({ type: "INVALID_RANGE" });
    expect(err("abc", [pos(4, 4, "", "x")])).toMatchObject({ type: "INVALID_RANGE" });
    expect(ok("abc", [pos(3, 3, "", "x")]).content).toBe("abcx");
  });

  it("rejects when expectedText does not match (stale offsets)", () => {
    expect(err("abcdef", [pos(1, 3, "XX", "y")])).toEqual({
      type: "TEXT_MISMATCH",
      index: 0,
      expected: "XX",
      actual: "bc",
    });
  });

  it("inserts at a position (start === end)", () => {
    expect(ok("ab", [pos(1, 1, "", "XY")]).content).toBe("aXYb");
    expect(ok("ab", [pos(2, 2, "", "!")]).content).toBe("ab!");
    expect(ok("ab", [pos(0, 0, "", "!")]).content).toBe("!ab");
  });

  it("works at document boundaries", () => {
    expect(ok("abc", [pos(0, 3, "abc", "Z")]).content).toBe("Z");
    expect(ok("abc", [pos(0, 1, "a", "")]).content).toBe("bc");
    expect(ok("abc", [pos(2, 3, "c", "")]).content).toBe("ab");
  });
});

describe("batches are atomic and resolved against one snapshot", () => {
  it("applies several non-overlapping changes", () => {
    const r = ok("one two three", [q("three", "3"), q("one", "1")]);
    expect(r.content).toBe("1 two 3");
  });

  it("does not let an earlier change shift a later one (offsets are snapshot offsets)", () => {
    const r = ok("abcdef", [pos(0, 1, "a", "LONGER"), pos(4, 5, "e", "E")]);
    expect(r.content).toBe("LONGERbcdEf");
  });

  it("a change inserting text that looks like a later target does not capture it", () => {
    // 'x' appears once in the snapshot; the replacement introduces more 'x'.
    expect(ok("x y", [q("x", "xx"), q("y", "z")]).content).toBe("xx z");
  });

  it("rejects overlapping changes and names both", () => {
    expect(err("abcdef", [pos(0, 4, "abcd", "X"), pos(2, 5, "cde", "Y")])).toEqual({
      type: "OVERLAPPING_CHANGES",
      indices: [0, 1],
    });
  });

  it("rejects the same target twice", () => {
    expect(err("abc", [q("b", "1"), q("b", "2")]).type).toBe("OVERLAPPING_CHANGES");
  });

  it("allows adjacent ranges", () => {
    expect(ok("abcd", [pos(0, 2, "ab", "X"), pos(2, 4, "cd", "Y")]).content).toBe("XY");
  });

  it("rejects two inserts at the same offset (ambiguous order)", () => {
    expect(err("ab", [pos(1, 1, "", "X"), pos(1, 1, "", "Y")])).toMatchObject({ type: "AMBIGUOUS_INSERT_ORDER", offset: 1 });
  });

  it("allows an insert at the start of, or just after, a replaced span", () => {
    expect(ok("abcd", [pos(1, 3, "bc", "X"), pos(1, 1, "", ">")]).content).toBe("a>Xd");
    expect(ok("abcd", [pos(1, 3, "bc", "X"), pos(3, 3, "", "<")]).content).toBe("aX<d");
  });

  it("rejects an insert strictly inside a replaced span", () => {
    expect(err("abcd", [pos(0, 4, "abcd", "X"), pos(2, 2, "", "!")]).type).toBe("OVERLAPPING_CHANGES");
  });

  it("a failed batch reports the failing change and applies nothing", () => {
    const text = "alpha beta";
    const changes = [q("alpha", "A"), q("missing", "M")];
    const snapshot = JSON.stringify(changes);
    expect(applyChanges(text, changes)).toMatchObject({ ok: false, error: { type: "TARGET_NOT_FOUND", index: 1 } });
    expect(text).toBe("alpha beta");
    expect(JSON.stringify(changes)).toBe(snapshot);
  });

  it("rejects an empty batch", () => {
    expect(err("abc", [])).toEqual({ type: "EMPTY_BATCH" });
  });
});

describe("content fidelity", () => {
  it("handles empty replacement (delete) and longer replacements", () => {
    expect(ok("a-b-c", [q("-b", "")]).content).toBe("a-c");
    expect(ok("ab", [q("a", "a".repeat(100))]).content).toBe("a".repeat(100) + "b");
  });

  it("preserves newlines, CRLF, tabs and surrounding whitespace exactly", () => {
    const t = "line1\r\nline2\n\tindent  \n";
    expect(ok(t, [q("line2", "L2")]).content).toBe("line1\r\nL2\n\tindent  \n");
  });

  it("preserves Unicode (accents, CJK, emoji)", () => {
    expect(ok("café 日本語 🎉!", [q("日本語", "漢字")]).content).toBe("café 漢字 🎉!");
    expect(ok("a🎉b", [q("🎉", "🔥")]).content).toBe("a🔥b");
  });

  it("rejects a range that starts or ends inside a surrogate pair", () => {
    const t = "a🎉b"; // 🎉 occupies offsets 1..3
    expect(err(t, [pos(2, 3, "\udf89", "x")])).toEqual({ type: "SPLIT_SURROGATE", index: 0, offset: 2 });
    expect(err(t, [pos(0, 2, "a\ud83c", "x")])).toEqual({ type: "SPLIT_SURROGATE", index: 0, offset: 2 });
    expect(ok(t, [pos(1, 3, "🎉", "x")]).content).toBe("axb");
  });

  it("reports changed=false and keeps text identical for a same-text replacement", () => {
    const r = ok("abc", [q("b", "b")]);
    expect(r.changed).toBe(false);
    expect(r.content).toBe("abc");
  });

  it("returns where the change landed in the new text", () => {
    const r = ok("abcdef", [pos(0, 1, "a", "LONGER"), pos(4, 5, "e", "E")]);
    expect(r.applied).toEqual([
      { index: 0, start: 0, end: 1, before: "a", after: "LONGER", newStart: 0, newEnd: 6 },
      { index: 1, start: 4, end: 5, before: "e", after: "E", newStart: 9, newEnd: 10 },
    ]);
    for (const a of r.applied) expect(r.content.slice(a.newStart, a.newEnd)).toBe(a.after);
  });
});
