import { describe, expect, it } from "vitest";
import type { CasesFile } from "./build-cases.ts";
import { summarize, type Texts } from "./report.ts";
import type { RawRecord } from "./run.ts";

/** A fixture small enough to count by hand. */
const meta: CasesFile["meta"] = { seed: 1, datasetZipSha256: "x", cuadZipSha256: "x", maxDocChars: 1, maxCuadDocChars: 1, perLabel: 1, pairs: 4, controlSpans: 3, note: "" };
const cases: CasesFile = {
  meta,
  dev: [],
  static: [
    { id: "s1", split: "test", docId: 1, hypothesis: "h", label: "Entailment" },
    { id: "s2", split: "test", docId: 1, hypothesis: "h", label: "Contradiction" },
    { id: "s3", split: "test", docId: 1, hypothesis: "h", label: "NotMentioned" },
    { id: "s4", split: "test", docId: 1, hypothesis: "h", label: "NotMentioned" },
  ],
  regression: ["p1", "p2", "p3", "p4"].map((id) => ({ id, docId: 1, hypothesis: "h", evidenceSpans: [], controlSpans: [] })),
  cuadDev: [],
  cuadStatic: [
    { id: "cuad-test-present", documentId: "a", category: "Governing Law", requirement: "law clause", hasClause: true },
    { id: "cuad-test-absent", documentId: "b", category: "Governing Law", requirement: "law clause", hasClause: false },
  ],
};
const TEXT = "The Receiving Party may disclose Confidential Information to its employees.";
const QUOTE = "may disclose Confidential Information to its employees";
const texts: Texts = { static: new Map(), cuad: new Map(), before: new Map(), after_pos: new Map(), after_ctrl: new Map() };
for (const c of cases.static) texts.static.set(c.id, TEXT);
texts.cuad.set("cuad-test-present", TEXT);
texts.cuad.set("cuad-test-absent", TEXT);
for (const p of cases.regression) for (const k of ["before", "after_pos", "after_ctrl"] as const) texts[k].set(p.id, TEXT);

const rec = (caseId: string, kind: RawRecord["kind"], label: string | null, quotes: string[] = [], extra: Partial<RawRecord> = {}): RawRecord => ({
  judge: "j", caseId, kind, ms: 100, answer: label ? { label: label as never, pEntailed: label === "entailed" ? 0.9 : 0.1, quotes, rationale: "r" } : null, ...(label ? {} : { error: "boom" }), ...extra,
});

describe("summarize", () => {
  // static: s1 right, s2 wrong (said entailed), s3 right, s4 abstained
  const raw: RawRecord[] = [
    rec("s1", "static", "entailed", [QUOTE]),
    rec("s2", "static", "entailed", [QUOTE]),
    rec("s3", "static", "not_mentioned"),
    rec("s4", "static", "unclear"),
    rec("cuad-test-present", "cuad", "entailed", [QUOTE]),
    rec("cuad-test-absent", "cuad", "entailed", [QUOTE]),
    // p1: sees it before, flags the deletion, leaves the control alone -> separates
    rec("p1", "before", "entailed", [QUOTE]), rec("p1", "after_pos", "not_mentioned"), rec("p1", "after_ctrl", "entailed", [QUOTE]),
    // p2: sees it before, MISSES the deletion (still entailed), no false alarm
    rec("p2", "before", "entailed", [QUOTE]), rec("p2", "after_pos", "entailed", [QUOTE]), rec("p2", "after_ctrl", "entailed", [QUOTE]),
    // p3: sees it before, flags the deletion AND wrongly flags the control
    rec("p3", "before", "entailed", [QUOTE]), rec("p3", "after_pos", "contradicted"), rec("p3", "after_ctrl", "unclear"),
    // p4: never saw it before (so unusable), and its after_pos was an outage
    rec("p4", "before", "not_mentioned"), rec("p4", "after_pos", null), rec("p4", "after_ctrl", "entailed", [QUOTE]),
  ];
  const s = summarize("j", raw, cases, texts, new Map());

  it("static accuracy counts abstentions and outages as wrong, and reports them", () => {
    expect(s.static.accuracy.p).toBeCloseTo(2 / 4, 9); // s1, s3
    expect(s.static.abstain).toBe(1); // s4
    expect(s.static.confusion.Contradiction.Entailment).toBe(1); // s2
    expect(s.static.recall.Entailment).toBe(1);
    expect(s.static.recall.Contradiction).toBe(0);
    expect(s.static.recall.NotMentioned).toBeCloseTo(0.5, 9);
    expect(s.static.binaryAccuracy.p).toBeCloseTo(3 / 4, 9); // entailed-vs-not: s1 yes, s2 no, s3 yes, s4 yes
  });

  it("regression counts only pairs the judge saw as satisfied before the edit", () => {
    expect(s.regression.usable).toBe(3); // p1, p2, p3
    expect(s.regression.detected).toBe(2); // p1, p3
    expect(s.regression.falseAlarm).toBe(1); // p3's control
    expect(s.regression.separates).toBe(1); // only p1: flagged deletion and left control alone
    expect(s.regression.recallAll.p).toBeCloseTo(2 / 4, 9); // unusable p4 counts as a miss
  });

  it("product level applies the evidence rule: an unclear answer is NEEDS_REVIEW, a denial is FAIL", () => {
    // p1 pos: not_mentioned -> FAIL; p3 pos: contradicted -> FAIL; p2 pos still PASS (entailed with a verified quote)
    expect(s.product).toMatchObject({ usable: 3, flaggedPos: 2, failPos: 2, reviewPos: 0, flaggedCtrl: 1, failCtrl: 0, reviewCtrl: 1 });
  });

  it("quote integrity counts only quotes that really are in the text", () => {
    const fabricated = [...raw, rec("s1", "static", "entailed", ["The vendor shall indemnify the customer for everything"])];
    const q = summarize("j", fabricated, cases, texts, new Map()).quotes!;
    expect(q.verified).toBeLessThan(q.total);
    expect(summarize("j", raw, cases, texts, new Map()).quotes).toMatchObject({ total: 11, verified: 11 });
  });

  it("outages are counted as errors and excluded from latency", () => {
    expect(s.errors).toBe(1);
    expect(s.calls).toBe(18);
    expect(s.latency.p50).toBe(100);
  });

  it("reports CUAD clause accuracy and false PASS separately by category", () => {
    expect(s.cuad.accuracy.p).toBe(0.5);
    expect(s.cuad.falsePassRate.p).toBe(1);
    expect(s.cuad.categories["Governing Law"]).toMatchObject({ n: 2 });
  });
});
