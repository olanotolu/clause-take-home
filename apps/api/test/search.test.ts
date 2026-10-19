import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { NATIVE_SNIPPET_MAX_CHARS, locateTerms } from "../src/search.ts";
import { createDoc, NDA, patch, quote, testApp } from "./helpers.ts";

let app: FastifyInstance;
beforeEach(async () => void (app = await testApp()));
afterEach(async () => void (await app.close()));

const get = async (url: string) => app.inject({ method: "GET", url });
const search = async (q: string, extra = "") => (await get(`/documents/search?q=${encodeURIComponent(q)}${extra}`)).json();
const marked = (hit: { snippet: { text: string; match: boolean }[] }) => hit.snippet.filter((s) => s.match).map((s) => s.text);

describe("words search (FTS5 + BM25)", () => {
  it("finds documents across several documents and ranks the better match first", async () => {
    await createDoc(app, "Unrelated", "Payment terms are net thirty days. Nothing about secrecy here.");
    const weak = await createDoc(app, "SaaS", "The vendor provides services. Confidentiality is mentioned once in passing.");
    const strong = await createDoc(app, "NDA", "Confidentiality. Confidentiality obligations survive. This confidentiality agreement governs confidentiality.");
    const res = await search("confidentiality");
    expect(res.total).toBe(2);
    expect(res.results.map((r: { documentId: string }) => r.documentId)).toEqual([strong.id, weak.id]);
    expect(res.results[0].relevance).toBeGreaterThan(res.results[1].relevance);
    expect(marked(res.results[0].hits[0]).join(" ").toLowerCase()).toContain("confidentiality");
  });

  it("matches phrases (order-sensitive) and Porter stems (obligation ~ obligations, terminate ~ termination)", async () => {
    await createDoc(app, "NDA", NDA);
    const d = await createDoc(app, "Term", "These obligations survive termination of the agreement.");
    expect((await search('"shall not disclose"')).total).toBe(1);
    expect((await search('"disclose shall"')).total).toBe(0);
    expect((await search("obligation")).results[0].documentId).toBe(d.id);
    expect((await search("terminate")).results[0].documentId).toBe(d.id);
  });

  it("keeps a useful bounded excerpt when a large-document match is a Porter stem", async () => {
    const d = await createDoc(app, "Long term", `${"boilerplate ".repeat(24_000)}termination survives.`);
    const hit = (await search("terminate")).results[0].hits[0];
    expect(hit.snippet.map((part: {text:string})=>part.text).join("")).toContain("termination");
    expect(marked(hit).join(" ")).toContain("termination");
    const current=(await get(`/documents/${d.id}`)).json().content as string;
    expect(current.slice(hit.start,hit.end)).toBe("termination");
    expect((await search("terminate")).results[0].documentId).toBe(d.id);
    const page=await app.store.wordsPage("terminate",{limit:10,offset:0});
    expect(page.items[0]?.content).toContain("termination");
    expect(page.items[0]?.nativeSnippet).toBeUndefined();

    const phraseDoc=await createDoc(app,"Long phrase",`${"boilerplate ".repeat(24_000)}terminate, surviving.`);
    const phraseHit=(await search('"termination survives"',`&ids=${phraseDoc.id}`)).results[0].hits[0];
    expect(phraseHit.snippet.map((part: {text:string})=>part.text).join("")).toContain("terminate, surviving");
    const phrasePage=await app.store.wordsPage('"termination survives"',{ids:[phraseDoc.id],limit:10,offset:0});
    expect(phrasePage.items[0]?.content).toContain("terminate, surviving");
    expect(phrasePage.items[0]?.nativeSnippet).toBeUndefined();
  });

  it.skipIf(Boolean(process.env.CLAUSE_TEST_DATABASE_URL))("locates diacritic-folded SQLite matches in large documents without FTS snippet fallback", async () => {
    const text = `${"Payment is due within thirty days of the invoice date. ".repeat(6_000)}The café is open.`;
    const d = await createDoc(app, "Accented", text);
    const page = await app.store.wordsPage("cafe", { ids: [d.id], limit: 10, offset: 0 });
    expect(page.items[0]?.content).toContain("café");
    expect(page.items[0]?.nativeSnippet).toBeUndefined();
    const hit = (await search("cafe", `&ids=${d.id}`)).results[0]?.hits[0];
    expect(text.slice(hit?.start, hit?.end)).toBe("café");
  });

  it("returns no results (not an error) when nothing matches", async () => {
    await createDoc(app, "NDA", NDA);
    expect(await search("zebra")).toMatchObject({ total: 0, results: [] });
  });

  it("every result's snippet comes from ITS OWN document (regression: FTS5 ignored `rowid = ?` beside MATCH)", async () => {
    const texts = {
      a: "Alpha agreement. The Receiving Party shall not disclose alpha secrets to anyone.",
      b: "Bravo agreement. Neither party may disclose bravo pricing without consent.",
      c: "Charlie agreement. Each side will disclose charlie reports only to auditors.",
    };
    const ids: Record<string, string> = {};
    for (const [k, v] of Object.entries(texts)) ids[(await createDoc(app, k, v)).id] = v;
    const res = await search("disclose");
    expect(res.results).toHaveLength(3);
    for (const r of res.results) {
      const own = ids[r.documentId]!;
      const shown = r.hits[0].snippet.map((s: { text: string }) => s.text).join("").replaceAll("…", "");
      expect(own, `snippet "${shown}" is not from document ${r.title}`).toContain(shown);
      expect(r.hits[0].start).toBeDefined();
      expect(own.slice(r.hits[0].start, r.hits[0].end).toLowerCase()).toBe("disclose");
    }
  });

  it("paginates over documents", async () => {
    for (let i = 0; i < 5; i++) await createDoc(app, `Doc ${i}`, `indemnification clause number ${i}`);
    const p1 = await search("indemnification", "&limit=2&offset=0");
    const p2 = await search("indemnification", "&limit=2&offset=2");
    const p3 = await search("indemnification", "&limit=2&offset=4");
    expect([p1.results.length, p2.results.length, p3.results.length]).toEqual([2, 2, 1]);
    expect(p1.total).toBe(5);
    const ids = [...p1.results, ...p2.results, ...p3.results].map((r: { documentId: string }) => r.documentId);
    expect(new Set(ids).size).toBe(5);
  });

  it("restricts to given document ids", async () => {
    const a = await createDoc(app, "A", "arbitration applies");
    await createDoc(app, "B", "arbitration also applies");
    const res = await search("arbitration", `&ids=${a.id}`);
    expect(res.results.map((r: { documentId: string }) => r.documentId)).toEqual([a.id]);
  });

  it("matches titles too", async () => {
    const d = await createDoc(app, "Master Services Agreement", "Body text with nothing relevant.");
    expect((await search("master services")).results[0].documentId).toBe(d.id);
  });

  it("treats FTS syntax and special characters as plain text instead of crashing", async () => {
    await createDoc(app, "NDA", NDA);
    for (const q of ['NEAR(a b)', "title:foo", "foo*", "-bar", 'unbalanced " quote', "a AND OR b", "(((", "'; DROP TABLE documents; --", "\\", "%"]) {
      const res = await get(`/documents/search?q=${encodeURIComponent(q)}`);
      expect([200, 400], q).toContain(res.statusCode);
      if (res.statusCode === 400) expect(res.json().type).toBe("INVALID_QUERY");
    }
    expect((await get("/documents")).json().total).toBe(1); // table still there
  });

  it("rejects empty, whitespace-only and over-long queries with 400 (schema first, then handler)", async () => {
    expect((await get("/documents/search?q=")).json()).toMatchObject({ code: 400, type: "VALIDATION_ERROR" }); // contract: min length 1
    expect((await get("/documents/search?q=%20%20")).json()).toMatchObject({ code: 400, type: "INVALID_QUERY" }); // passes the schema, empty after trim
    expect((await get(`/documents/search?q=${"a".repeat(201)}`)).json()).toMatchObject({ code: 400, type: "VALIDATION_ERROR" });
    expect((await get("/documents/search")).statusCode).toBe(400); // q missing
  });

  it("highlights with verified offsets into the current document", async () => {
    const text = "x".repeat(300) + " The Receiving Party shall maintain strict confidentiality of all data. " + "y".repeat(300);
    const d = await createDoc(app, "NDA", text);
    const hit = (await search("confidentiality")).results[0].hits[0];
    expect(hit.start).toBeDefined();
    const current = (await get(`/documents/${d.id}`)).json().content;
    expect(current.slice(hit.start, hit.end).toLowerCase()).toBe("confidentiality");
    expect(marked(hit)).toEqual([current.slice(hit.start, hit.end)]);
  });
});

describe("exact search (literal substring, real offsets)", () => {
  it("returns every occurrence with offsets that index the current content", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const res = await search("shall not disclose", "&mode=exact");
    expect(res.total).toBe(1);
    const r = res.results[0];
    expect(r).toMatchObject({ documentId: d.id, matchCount: 3 });
    for (const h of r.hits) expect(NDA.slice(h.start, h.end)).toBe("shall not disclose");
    expect(r.hits.map((h: { start: number }) => h.start)).toEqual([NDA.indexOf("shall not disclose"), NDA.indexOf("shall not disclose", 20 + 18), NDA.lastIndexOf("shall not disclose")]);
  });

  it("is case-sensitive even though the trigram prefilter is not", async () => {
    await createDoc(app, "NDA", "Confidential and confidential and CONFIDENTIAL");
    const res = await search("confidential", "&mode=exact");
    expect(res.results[0].matchCount).toBe(1);
  });

  it("treats % _ and \\ literally (they are LIKE wildcards in Postgres)", async () => {
    const lit = await createDoc(app, "Lit", "Discount of 100% applies; see file a_b and path C:\\temp.");
    await createDoc(app, "Decoy", "Discount of 100 percent applies; see file aXb and path C:temp.");
    for (const [q, expected] of [["100%", 1], ["a_b", 1], ["C:\\temp", 1], ["%", 1], ["_", 1]] as const) {
      const res = await search(q, "&mode=exact");
      expect(res.total, q).toBe(expected);
      expect(res.results[0].documentId, q).toBe(lit.id);
    }
  });

  it("handles queries shorter than three characters (no trigram possible)", async () => {
    await createDoc(app, "Doc", "a-b a-b a-c");
    expect((await search("a-", "&mode=exact")).results[0].matchCount).toBe(3);
    expect((await search("b", "&mode=exact")).results[0].matchCount).toBe(2);
  });

  it("finds punctuation and substrings that word search cannot", async () => {
    await createDoc(app, "Doc", "Section 5.1(a) applies; see also §12.3.");
    expect((await search("5.1(a)", "&mode=exact")).total).toBe(1);
    expect((await search("ction 5", "&mode=exact")).total).toBe(1);
    expect((await search("§12", "&mode=exact")).total).toBe(1);
  });

  it("every hit carries a selector that resolves to exactly that span", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const { results } = await search("shall not disclose", "&mode=exact");
    for (const hit of results[0].hits) {
      const res = await app.inject({
        method: "POST",
        url: `/documents/${d.id}/changes/preview`,
        payload: { expectedVersion: hit.version ?? 1, changes: [{ operation: "replace", target: hit.target, replacement: "MAY" }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied[0]).toMatchObject({ start: hit.start, end: hit.end });
    }
  });

  it("scoped search returns up to `limit` hits within one document", async () => {
    const d = await createDoc(app, "Rep", "foo ".repeat(20));
    const res = (await get(`/documents/${d.id}/search?q=foo&limit=5`)).json();
    expect(res.result.matchCount).toBe(20);
    expect(res.result.hits).toHaveLength(5);
    expect((await get(`/documents/doc_nope/search?q=foo`)).statusCode).toBe(404);
  });
});

describe("search stays coherent with committed edits", () => {
  it("old term disappears and new term appears after an edit", async () => {
    const d = await createDoc(app, "NDA", "This agreement protects confidentiality of the parties.");
    expect((await search("confidentiality")).total).toBe(1);
    expect((await search("privacy")).total).toBe(0);

    const res = await patch(app, d.id, { expectedVersion: 1, changes: [quote("confidentiality", "privacy")] });
    expect(res.statusCode).toBe(200);

    expect((await search("confidentiality")).total).toBe(0);
    expect((await search("privacy")).total).toBe(1);
    expect((await search("confidentiality", "&mode=exact")).total).toBe(0);
    expect((await search("privacy", "&mode=exact")).total).toBe(1);
  });

  it("a rejected edit leaves the index untouched", async () => {
    const d = await createDoc(app, "NDA", "alpha beta alpha");
    await patch(app, d.id, { changes: [quote("alpha", "ZZZ")] }); // ambiguous -> 409
    expect((await search("alpha")).total).toBe(1);
    expect((await search("ZZZ")).total).toBe(0);
  });

  it("a no-op edit keeps results identical", async () => {
    const d = await createDoc(app, "NDA", "alpha beta");
    const before = await search("alpha");
    await patch(app, d.id, { changes: [quote("alpha", "alpha")] });
    expect(await search("alpha")).toEqual(before);
  });

  it("deleted documents disappear from search", async () => {
    const d = await createDoc(app, "NDA", "unique-ish tokenizer words indemnify");
    expect((await search("indemnify")).total).toBe(1);
    await app.inject({ method: "DELETE", url: `/documents/${d.id}` });
    expect((await search("indemnify")).total).toBe(0);
    expect((await search("indemnify", "&mode=exact")).total).toBe(0);
  });

  it("the signature loop: search -> take the returned selector -> edit -> verify", async () => {
    const d = await createDoc(app, "NDA", NDA);
    const hits = (await search("shall not disclose", "&mode=exact")).results[0].hits;
    const second = hits[1];
    const res = await patch(app, d.id, { expectedVersion: 1, changes: [{ operation: "replace", target: second.target, replacement: "may disclose" }] });
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe(NDA.slice(0, second.start) + "may disclose" + NDA.slice(second.end));
    expect((await search("shall not disclose", "&mode=exact")).results[0].matchCount).toBe(2);
  });
});

describe("large documents use the linear locator instead of native snippet()", () => {
  const filler = "Payment is due within thirty days of the invoice date. ";

  it("returns a verified highlight and offsets for a document above the native-snippet threshold", async () => {
    const text = filler.repeat(6000) + "The Vendor shall maintain strict confidentiality here. " + filler.repeat(500);
    expect(text.length).toBeGreaterThan(NATIVE_SNIPPET_MAX_CHARS);
    const d = await createDoc(app, "Big", text);
    const t0 = performance.now();
    const res = await search("confidentiality");
    const elapsed = performance.now() - t0;
    const hit = res.results[0].hits[0];
    const current = (await get(`/documents/${d.id}`)).json().content;
    expect(current.slice(hit.start, hit.end).toLowerCase()).toBe("confidentiality");
    expect(marked(hit)).toEqual(["confidentiality"]);
    expect(elapsed).toBeLessThan(3000); // generous: native snippet() on a 10 MB doc with a common phrase took ~8 s
  });

  it("a common phrase in a large document still answers promptly", async () => {
    await createDoc(app, "Big", filler.repeat(8000));
    const t0 = performance.now();
    const res = await search("payment due");
    expect(res.total).toBe(1);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});

describe("locateTerms", () => {
  it("finds inflections, phrases and is regex-safe", () => {
    expect(locateTerms("These obligations survive.", "obligation")).toEqual([6, 17]);
    expect(locateTerms("upon termination of", "terminate")).toEqual([5, 16]);
    const phrase = "a b  shall   not disclose x";
    const [ps, pe] = locateTerms(phrase, '"shall not disclose"')!;
    expect(phrase.slice(ps, pe)).toBe("shall   not disclose");
    const cost = "cost is $5.00 (net)";
    const [cs, ce] = locateTerms(cost, "$5.00")!;
    expect(cost.slice(cs, ce)).toBe("$5.00"); // metacharacters are literal...
    expect(locateTerms("a5x00", "5.00")).toBeUndefined(); // ...so "." is not a wildcard
    const underscore = "ending in TAIL_EVIDENCE.";
    const [us, ue] = locateTerms(underscore, "TAIL_EVIDENCE")!;
    expect(underscore.slice(us, ue)).toBe("TAIL_EVIDENCE");
    const accented = "The café is open.";
    const [as, ae] = locateTerms(accented, "cafe")!;
    expect(accented.slice(as, ae)).toBe("café");
    expect(locateTerms("anything", ".*")).toBeUndefined();
    expect(locateTerms("nothing here", "zebra")).toBeUndefined();
  });
});

describe("control characters (found by Schemathesis: NUL in a query caused a 500)", () => {
  it("rejects NUL in a query with 400 INVALID_QUERY in every search mode, never a 500", async () => {
    const d = await createDoc(app, "NDA", NDA);
    for (const url of [
      `/documents/search?q=${encodeURIComponent("abc\u0000def")}`,
      `/documents/search?q=${encodeURIComponent("abc\u0000def")}&mode=exact`,
      `/documents/${d.id}/search?q=${encodeURIComponent("\u0000!¸")}&mode=words`,
      `/documents/${d.id}/search?q=${encodeURIComponent("x\u0000")}&mode=exact`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().type).toBe("INVALID_QUERY");
    }
  });

  it("handles other control and non-BMP characters without erroring", async () => {
    await createDoc(app, "NDA", NDA);
    for (const q of ["\u0001\u0002", "\u000b\f", "\u001f", "\u{1f4a5}", "a\u0085b", " "]) {
      for (const mode of ["words", "exact"]) {
        const res = await get(`/documents/search?q=${encodeURIComponent(q)}&mode=${mode}`);
        expect([200, 400], `${JSON.stringify(q)} ${mode}`).toContain(res.statusCode);
      }
    }
  });
});
