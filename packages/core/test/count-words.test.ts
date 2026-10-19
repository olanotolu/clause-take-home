import { describe, expect, it } from "vitest";
import { countWords } from "../src/count-words.ts";

describe("countWords", () => {
  it("matches JavaScript non-whitespace runs, including Unicode whitespace", () => {
    for (const text of ["", "   ", "two words", "two\twords\nthree", "a\u00a0b\u2003c\ufeffd", "世界 🌍"]) {
      expect(countWords(text)).toBe(text.match(/\S+/gu)?.length ?? 0);
    }
  });

  it("counts a large repeated body without materializing its word list", () => {
    const text = "word ".repeat(5_000_000);
    expect(countWords(text)).toBe(5_000_000);
  },120_000);
});
