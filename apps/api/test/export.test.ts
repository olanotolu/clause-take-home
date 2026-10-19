import fc from "fast-check";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { redlineDocx, redlineParts } from "../src/docx.ts";
import { sha256 } from "@clause/core";
import { createDoc, patch, quote, testApp, usingPostgres } from "./helpers.ts";

const unescapeXml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

async function documentXml(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return zip.file("word/document.xml")!.async("string");
}

/**
 * Reads the tracked-changes structure back out of the XML, independently of how it was written, and applies what Word
 * does: Accept-all keeps inserted text and drops deleted text; Reject-all does the reverse. A tracked paragraph MARK
 * (an inserted/deleted line break) merges the paragraph with the next one when it is rejected/accepted respectively.
 */
function readRedline(xml: string) {
  // An empty paragraph is written self-closing (<w:p/>); a naive "<w:p ...>...</w:p>" pattern would swallow the next one.
  const paragraphs = [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((p) => p[1] ?? "");
  const texts = (chunk: string, tag: "w:t" | "w:delText") => [...chunk.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => unescapeXml(m[1]!)).join("");
  let accepted = "";
  let rejected = "";
  paragraphs.forEach((p, i) => {
    const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(p)?.[0] ?? "";
    const body = p.replace(pPr, "");
    let acc = "";
    let rej = "";
    for (const m of body.matchAll(/<w:ins\b[\s\S]*?<\/w:ins>|<w:del\b[\s\S]*?<\/w:del>|<w:r\b[\s\S]*?<\/w:r>/g)) {
      const chunk = m[0];
      if (chunk.startsWith("<w:ins")) acc += texts(chunk, "w:t");
      else if (chunk.startsWith("<w:del")) rej += texts(chunk, "w:delText");
      else {
        const t = texts(chunk, "w:t");
        acc += t;
        rej += t;
      }
    }
    const last = i === paragraphs.length - 1;
    const markInserted = /<w:ins\b/.test(pPr);
    const markDeleted = /<w:del\b/.test(pPr);
    accepted += acc + (last || markDeleted ? "" : "\n");
    rejected += rej + (last || markInserted ? "" : "\n");
  });
  return { accepted, rejected, ins: (xml.match(/<w:ins\b/g) ?? []).length, del: (xml.match(/<w:del\b/g) ?? []).length };
}

const exportOf = (from: string, to: string) =>
  redlineDocx({ title: "T", from: { version: 1, content: from }, to: { version: 2, content: to, createdAt: "2026-10-15T12:00:00.000Z" } });

describe("redlineParts (line diff first, word diff only inside changed blocks)", () => {
  const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : 20261015;
  const word = fc.constantFrom("the", "Party", "shall", "notice", "five (5)", "years", "", " ", "  ");
  const line = fc.array(word, { maxLength: 6 }).map((w) => w.join(" "));
  const doc = fc.array(line, { maxLength: 8 }).map((l) => l.join("\n"));
  const join = (parts: { kind: string; value: string }[], keep: string) => parts.filter((p) => p.kind === "same" || p.kind === keep).map((p) => p.value).join("");

  it("rejecting every change gives the old text and accepting gives the new, for random paragraph edits", () => {
    fc.assert(
      fc.property(doc, doc, (from, to) => {
        const parts = redlineParts(from, to);
        expect(join(parts, "del")).toBe(from);
        expect(join(parts, "ins")).toBe(to);
      }),
      { seed, numRuns: 500 },
    );
  });

  it("stays exact and fast when every paragraph is rewritten (no line to anchor on)", () => {
    const from = Array.from({ length: 700 }, (_, i) => `Clause ${i} keeps item ${i} confidential.`).join("\n");
    const to = Array.from({ length: 650 }, (_, i) => `Section ${i} treats item ${i} as secret.`).join("\n");
    const started = performance.now();
    const parts = redlineParts(from, to);
    expect(performance.now() - started).toBeLessThan(2000); // generous: the unbounded search took minutes at this shape
    expect(join(parts, "del")).toBe(from);
    expect(join(parts, "ins")).toBe(to);
  });

  it("keeps word-level detail inside a changed paragraph and leaves unchanged paragraphs whole", () => {
    const parts = redlineParts("Alpha stays.\nIt shall give prompt written notice.\nOmega stays.", "Alpha stays.\nIt may give notice at its discretion.\nOmega stays.");
    // Unchanged paragraphs stay inside unchanged runs (adjacent unchanged text is merged into one run).
    expect(parts[0]!.kind).toBe("same");
    expect(parts[0]!.value.startsWith("Alpha stays.\n")).toBe(true);
    expect(parts.filter((p) => p.kind === "del").map((p) => p.value.trim())).toContain("shall");
    expect(parts.at(-1)!.kind).toBe("same");
    expect(parts.at(-1)!.value.endsWith("Omega stays.")).toBe(true);
  });
});

describe("redlineDocx", () => {
  it("writes native Word tracked changes attributed to CLAUSE with the revision date", async () => {
    const xml = await documentXml(await exportOf("The Vendor shall not disclose it.", "The Vendor may disclose it."));
    const r = readRedline(xml);
    expect(r.ins).toBeGreaterThan(0);
    expect(r.del).toBeGreaterThan(0);
    expect(xml).toContain('w:author="CLAUSE"');
    expect(xml).toContain('w:date="2026-10-15T12:00:00.000Z"');
    expect(xml).toContain("<w:delText"); // deleted text is stored as delText, as Word requires
  });

  it("Accept-all gives the new text and Reject-all gives the old text, exactly", async () => {
    const pairs: [string, string][] = [
      ["The Vendor shall not disclose it.", "The Vendor may disclose it."],
      ["1.1 One\n\n1.2 Two\n", "1.1 One\n\n1.2 Two and three\n1.3 Four\n"],
      ["unchanged only", "unchanged only"],
      ["", "brand new"],
      ["all removed\nacross lines", ""],
      ["café  日本語 🎉 <tag> & \"quotes\" 'single'", "café  日本語 🔥 <tag> && \"quotes\" 'double'"],
      ["  leading and trailing  ", "leading and trailing"],
      ["a\n\n\nb", "a\nb"],
      ["x".repeat(500) + " y", "x".repeat(500) + " z"],
    ];
    for (const [from, to] of pairs) {
      const r = readRedline(await documentXml(await exportOf(from, to)));
      expect(r.accepted, `accept-all of ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toBe(to);
      expect(r.rejected, `reject-all of ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toBe(from);
    }
  });

  it("produces no tracked changes when nothing differs", async () => {
    const r = readRedline(await documentXml(await exportOf("same text", "same text")));
    expect(r).toMatchObject({ ins: 0, del: 0, accepted: "same text" });
  });

  it("is a valid OOXML package", async () => {
    const buf = await exportOf("a", "b");
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const zip = await JSZip.loadAsync(buf);
    for (const f of ["[Content_Types].xml", "word/document.xml", "_rels/.rels"]) expect(zip.file(f), f).not.toBeNull();
  });
});

// The accept/reject tests above read the XML with a parser written next to the writer. pandoc is a separate
// implementation of tracked changes, so agreement with it is stronger evidence (still not Microsoft Word itself).
// Skipped, not failed, where pandoc is not installed.
const hasPandoc = spawnSync("pandoc", ["--version"]).status === 0;
const repoRoot = join(import.meta.dirname, "../../..");
const lines = (s: string) => s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
const viaPandoc = (docx: Buffer, mode: "accept" | "reject") =>
  lines(execFileSync("pandoc", ["-f", "docx", `--track-changes=${mode}`, "-t", "plain", "--wrap=none"], { input: docx, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

describe.skipIf(!hasPandoc)("redlineDocx read by pandoc, a parser we did not write", () => {
  it("accept gives the new text and reject gives the old text", async () => {
    const pairs: [string, string][] = [
      ["The Vendor shall not disclose it.", "The Vendor may disclose it."],
      ["1.1 One\n\n1.2 Two\n", "1.1 One\n\n1.2 Two and three\n1.3 Four\n"],
      ["all removed\nacross lines", "brand new"],
      ["café 日本語 🎉 <tag> & \"quotes\"", "café 日本語 🔥 <tag> && \"quotes\""],
    ];
    for (const [from, to] of pairs) {
      const docx = await exportOf(from, to);
      expect(viaPandoc(docx, "accept"), `accept ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toEqual(lines(to));
      expect(viaPandoc(docx, "reject"), `reject ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toEqual(lines(from));
    }
  });

  it("the committed sample redline rejects to the original NDA and accepts to the edited one", () => {
    const sample = readFileSync(join(repoRoot, "samples/mutual-nda-redline.docx"));
    const original = lines(readFileSync(join(repoRoot, "fixtures/mutual-nda.txt"), "utf8"));
    const rejected = viaPandoc(sample, "reject");
    const accepted = viaPandoc(sample, "accept");
    expect(rejected).toEqual(original);
    expect(accepted).not.toEqual(original);
    expect(accepted.join("\n")).toContain("three (3) years");
    expect(accepted.join("\n")).toContain("seven (7) years");
  });
});

describe("GET /documents/:id/export.docx", () => {
  let app: FastifyInstance;
  beforeEach(async () => void (app = await testApp({startExportWorkflow:async()=>undefined})));
  afterEach(async () => void (await app.close()));
  const get = (url: string) => app.inject({ method: "GET", url });

  it("downloads a redline between two versions with sensible headers", async () => {
    const d = await createDoc(app, "Mutual NDA - Acme", "The Vendor shall not disclose it.\nSecond clause.");
    await patch(app, d.id, { changes: [quote("shall not disclose", "may disclose")] });
    const res = await get(`/documents/${d.id}/export.docx?from=1&to=2`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="mutual-nda-acme-v1-to-v2-redline.docx"');
    const r = readRedline(await documentXml(res.rawPayload));
    expect(r.accepted).toBe("The Vendor may disclose it.\nSecond clause.");
    expect(r.rejected).toBe("The Vendor shall not disclose it.\nSecond clause.");
  });

  it("defaults to the original (v1) against the current version", async () => {
    const d = await createDoc(app, "t", "one two three");
    await patch(app, d.id, { changes: [quote("one", "1")] });
    await patch(app, d.id, { changes: [quote("three", "3")] });
    const r = readRedline(await documentXml((await get(`/documents/${d.id}/export.docx`)).rawPayload));
    expect(r).toMatchObject({ accepted: "1 two 3", rejected: "one two three" });
    const mid = readRedline(await documentXml((await get(`/documents/${d.id}/export.docx?from=2`)).rawPayload));
    expect(mid).toMatchObject({ accepted: "1 two 3", rejected: "1 two three" });
  });

  it("errors: missing document, missing version, wrong order, bad parameters", async () => {
    const d = await createDoc(app, "t", "x");
    await patch(app, d.id, { changes: [quote("x", "y")] });
    expect((await get("/documents/doc_nope/export.docx")).json()).toMatchObject({ code: 404, type: "DOCUMENT_NOT_FOUND" });
    expect((await get(`/documents/${d.id}/export.docx?from=1&to=9`)).json()).toMatchObject({ code: 404, type: "REVISION_NOT_FOUND" });
    expect((await get(`/documents/${d.id}/export.docx?from=2&to=1`)).json()).toMatchObject({ code: 422, type: "INVALID_VERSION_RANGE" });
    expect((await get(`/documents/${d.id}/export.docx?from=1&to=1`)).statusCode).toBe(422);
    for (const q of ["from=0", "from=abc", "to=1.5", "from=%201"]) expect((await get(`/documents/${d.id}/export.docx?${q}`)).statusCode, q).toBe(400);
  });

  // Large redlines remain available within the supported 25 MiB source-document limit.
  it.skipIf(usingPostgres)("exports a large document redline", async () => {
    const content = "a ".repeat(600_000);
    const intent = await app.inject({ method: "POST", url: "/documents/uploads/intents", payload: { size: Buffer.byteLength(content) } });
    const upload = intent.json();
    await app.inject({ method: "POST", url: `${upload.uploadUrl}?intent=${encodeURIComponent(upload.intent)}`, headers: { "content-type": "text/plain" }, payload: content });
    const created = await app.inject({ method: "POST", url: "/documents/uploads/complete", payload: { intent: upload.intent, title: "Big", sha256: sha256(content) } });
    expect(created.statusCode).toBe(201);
    const d = created.json() as { id: string };
    await patch(app, d.id, { changes: [{ operation: "replace", target: { position: { start: 0, end: 1, expectedText: "a" } }, replacement: "b" }] });
    const res = await get(`/documents/${d.id}/export.docx`);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({status:"queued",statusUrl:expect.stringMatching(/^\/jobs\//)});
  });

  it("is declared in the OpenAPI document as a binary .docx", async () => {
    const spec = (await get("/openapi.json")).json();
    const ok = spec.paths["/documents/{id}/export.docx"].get.responses["200"];
    expect(ok.content["application/vnd.openxmlformats-officedocument.wordprocessingml.document"].schema).toEqual({ type: "string", format: "binary" });
  });
});
