import { describe, expect, it } from "vitest";
import { toTsQuery } from "../src/store/postgres.ts";
import { compileWordsQuery } from "../src/store/sqlite.ts";
import { InvalidQueryError } from "../src/store/types.ts";

describe("query compilers keep user input inert", () => {
  it("Postgres: words become quoted literals, phrases become <-> chains, terms are ANDed", () => {
    expect(toTsQuery("confidentiality")).toBe("'confidentiality'");
    expect(toTsQuery("confidential information")).toBe("'confidential' & 'information'");
    expect(toTsQuery('"shall not disclose" breach')).toBe("('shall' <-> 'not' <-> 'disclose') & 'breach'");
  });

  it("Postgres: operators and punctuation cannot reach the tsquery parser", () => {
    for (const hostile of ["a & b | !c", "foo:*", "(a)", "a <-> b", "'; DROP TABLE documents; --", "x\\y", "a'b"]) {
      const q = toTsQuery(hostile);
      // only quoted letter/digit literals joined by our own operators may remain
      expect(q.replace(/'[\p{L}\p{N}]+'/gu, "L"), hostile).toMatch(/^[L ()&<>-]+$/);
    }
    // an apostrophe inside one term splits it into adjacent words, like the tokenizer does for "don't"
    expect(toTsQuery("a'b")).toBe("('a' <-> 'b')");
  });

  it("Postgres: input with no letters or digits is an invalid query, not a crash", () => {
    for (const q of ["", "   ", "--", "&|!", '""', "***"]) expect(() => toTsQuery(q), JSON.stringify(q)).toThrow(InvalidQueryError);
  });

  it("SQLite: every term is a quoted FTS5 phrase", () => {
    expect(compileWordsQuery('shall "not disclose"')).toBe('"shall" "not disclose"');
    expect(compileWordsQuery('NEAR(a b) -c title:x')).toBe('"NEAR(a" "b)" "-c" "title:x"');
    expect(() => compileWordsQuery("   ")).toThrow(InvalidQueryError);
  });
});

import { lazyStore } from "../src/store/lazy.ts";
import { SEED_DOCUMENTS } from "../src/seed-data.ts";
import { testStore } from "./helpers.ts";

describe("ensureSamples (runs on whichever backend the suite is using)", () => {
  it("fills an empty database once and is a no-op after that", async () => {
    const store = await testStore();
    expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(5);
    expect((await store.listDocuments(50, 0)).total).toBe(5);
    expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(0); // second call: already there
    expect((await store.listDocuments(50, 0)).total).toBe(5);
    // seeded documents are real documents: version 1, searchable, with a history row
    const found = (await store.wordsPage("confidentiality", { limit: 100, offset: 0 })).items;
    expect(found.length).toBeGreaterThan(0);
    expect(await store.listRevisions(found[0]!.id)).toHaveLength(1);
    await store.close();
  });

  it("adds the samples to a database that already has user data, without touching that data", async () => {
    const store = await testStore();
    const mine = await store.insertDocument({ title: "mine", content: "my own contract" });
    expect(await store.ensureSamples(SEED_DOCUMENTS)).toBe(5);
    const { total, items } = await store.listDocuments(50, 0);
    expect(total).toBe(6);
    expect(items.find((d) => d.id === mine.id)).toMatchObject({ title: "mine", version: 1 });
    expect((await store.getDocument(mine.id))?.content).toBe("my own contract");
    await store.close();
  });
});

describe("lazyStore", () => {
  it("does not connect until first use, then connects once", async () => {
    let created = 0;
    const store = lazyStore({ kind: "sqlite", maxContentChars: Infinity }, async () => {
      created++;
      return testStore();
    });
    expect(created).toBe(0);
    expect(store.kind).toBe("sqlite");
    await Promise.all([store.listDocuments(1, 0), store.listDocuments(1, 0), store.getDocument("x")]);
    expect(created).toBe(1);
    await store.close();
  });

  it("retries after a failed connection instead of failing forever", async () => {
    let attempts = 0;
    const store = lazyStore({ kind: "sqlite", maxContentChars: Infinity }, async () => {
      if (++attempts === 1) throw new Error("database unreachable");
      return testStore();
    });
    await expect(store.listDocuments(1, 0)).rejects.toThrow("database unreachable");
    expect((await store.listDocuments(1, 0)).total).toBe(0);
    expect(attempts).toBe(2);
    await store.close();
  });

  it("closing a store that was never used is a no-op", async () => {
    await lazyStore({ kind: "sqlite", maxContentChars: Infinity }, async () => testStore()).close();
  });
});
