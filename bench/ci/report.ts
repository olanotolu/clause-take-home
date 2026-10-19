/**
 * Turns the raw judge answers in results/ into the metrics in RESULTS.md. Pure maths over recorded answers: it calls no
 * model, so anyone can regenerate the report from the raw files and check it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { combineJudges } from "../../apps/api/src/review/ensemble.ts";
import { verifyQuotes } from "../../apps/api/src/review/evidence.ts";
import type { JudgeLabel } from "../../apps/api/src/review/judges/types.ts";
import type { CasesFile } from "./build-cases.ts";
import { brier, classReport, confusion, fmtCi, pct, percentile, wilson } from "./metrics.ts";
import type { CallKind, RawRecord } from "./run.ts";

export const NLI = ["Entailment", "Contradiction", "NotMentioned", "Abstain"] as const;
type Nli = (typeof NLI)[number];
const TO_NLI: Record<JudgeLabel, Nli> = { entailed: "Entailment", contradicted: "Contradiction", not_mentioned: "NotMentioned", unclear: "Abstain" };
const asNli = (r: RawRecord | undefined): Nli => (r?.answer ? TO_NLI[r.answer.label] : "Abstain"); // an outage counts as no answer

export interface Texts { static: Map<string, string>; cuad: Map<string, string>; before: Map<string, string>; after_pos: Map<string, string>; after_ctrl: Map<string, string> }

export interface JudgeSummary {
  judge: string;
  calls: number;
  errors: number;
  coverage: { static: { answered: number; total: number }; cuad: { answered: number; total: number }; regressionTexts: { answered: number; total: number } };
  static: {
    n: number;
    accuracy: ReturnType<typeof wilson>;
    macroF1: number;
    recall: Record<string, number>;
    binaryAccuracy: ReturnType<typeof wilson>;
    abstain: number;
    brier: number | null;
    confusion: ReturnType<typeof confusion<Nli>>;
    meanDecisionConfidence: number | null;
    choiceCalibration: { n: number; brier: number; ece: number } | null;
  };
  cuad: { n: number; attempted: number; answered: number; cases: number; negativeCases: number; accuracy: ReturnType<typeof wilson>; falsePassRate: ReturnType<typeof wilson>; categories: Record<string, { n: number; answered: number; negativeCases: number; accuracy: ReturnType<typeof wilson>; falsePassRate: ReturnType<typeof wilson> }> };
  regression: { pairs: number; usable: number; detected: number; falseAlarm: number; separates: number; recallAll: ReturnType<typeof wilson> };
  product: { usable: number; flaggedPos: number; flaggedCtrl: number; failPos: number; reviewPos: number; failCtrl: number; reviewCtrl: number } | null;
  quotes: { total: number; verified: number } | null;
  latency: { p50: number; p90: number; p95: number; p99: number };
  tokens: { input: number; output: number } | null;
}

/** Index records by (case, kind). */
const index = (rs: RawRecord[]) => new Map<string, RawRecord>(rs.map((r) => [`${r.caseId}|${r.kind}`, r]));

export function summarize(judge: string, rs: RawRecord[], cases: CasesFile, texts: Texts, truth: Map<string, Nli>): JudgeSummary {
  const idx = index(rs);
  const get = (id: string, kind: string) => idx.get(`${id}|${kind}`);
  const latestRecords = [...idx.values()];
  const answeredCount = (kind: CallKind) => latestRecords.filter((r) => r.kind === kind && r.answer).length;

  const rows = cases.static.map((c) => ({ truth: c.label as Nli, pred: asNli(get(c.id, "static")) }));
  const m = confusion(NLI, rows);
  const rep = classReport(NLI, m);
  const binCorrect = cases.static.filter((c) => (c.label === "Entailment") === (asNli(get(c.id, "static")) === "Entailment")).length;
  const probs = cases.static.flatMap((c) => { const a = get(c.id, "static")?.answer; return a?.pEntailed === undefined ? [] : [{ p: a.pEntailed, outcome: c.label === "Entailment" }]; });
  const choiceCalibrations = cases.static.flatMap((c) => { const a = get(c.id, "static")?.answer; return a?.choiceProbability === undefined ? [] : [{ p: a.choiceProbability, correct: asNli(get(c.id, "static")) === c.label }]; });
  const confidenceValues = cases.static.flatMap((c) => { const value = get(c.id, "static")?.answer?.decisionConfidence; return value === undefined ? [] : [value]; });
  const confidenceBins = Array.from({ length: 10 }, (_, i) => choiceCalibrations.filter((x) => Math.min(9, Math.floor(x.p * 10)) === i));
  const choiceCalibration = choiceCalibrations.length ? {
    n: choiceCalibrations.length,
    brier: choiceCalibrations.reduce((sum, x) => sum + (x.p - Number(x.correct)) ** 2, 0) / choiceCalibrations.length,
    ece: confidenceBins.reduce((sum, bin) => bin.length ? sum + bin.length / choiceCalibrations.length * Math.abs(bin.reduce((s, x) => s + Number(x.correct), 0) / bin.length - bin.reduce((s, x) => s + x.p, 0) / bin.length) : sum, 0),
  } : null;
  const attemptedCuadIds = new Set(rs.filter((r) => r.kind === "cuad").map((r) => r.caseId));
  const cuadCasesAttempted = cases.cuadStatic.filter((c) => attemptedCuadIds.has(c.id));
  const cuadRows = cuadCasesAttempted.map((c) => {
    const r = get(c.id, "cuad");
    // Raw model prediction is used for accuracy and false-PASS safety measurements. Quote-gated product behavior is reported separately below.
    const predicted = r?.answer?.label === "entailed";
    return { ...c, predicted, correct: predicted === c.hasClause };
  });
  const catNames = [...new Set(cuadRows.map((x) => x.category))];
  const catStats = Object.fromEntries(catNames.map((category) => {
    const rows = cuadRows.filter((x) => x.category === category);
    const falsePass = rows.filter((x) => !x.hasClause && x.predicted).length;
    return [category, { n: rows.length, answered: rows.filter((x) => Boolean(get(x.id, "cuad")?.answer)).length, negativeCases: rows.filter((x) => !x.hasClause).length, accuracy: wilson(rows.filter((x) => x.correct).length, rows.length), falsePassRate: wilson(falsePass, rows.filter((x) => !x.hasClause).length) }];
  }));

  // Label-level regression: a pair is usable if the judge saw the requirement as satisfied BEFORE the edit.
  let usable = 0, detected = 0, falseAlarm = 0, separates = 0, detectedAll = 0;
  for (const p of cases.regression) {
    const before = asNli(get(p.id, "before"));
    const pos = asNli(get(p.id, "after_pos")) !== "Entailment";
    const ctrl = asNli(get(p.id, "after_ctrl")) !== "Entailment";
    if (pos && before === "Entailment") detectedAll++;
    if (before !== "Entailment") continue;
    usable++;
    if (pos) detected++;
    if (ctrl) falseAlarm++;
    if (pos && !ctrl) separates++;
  }

  // Product-level (what a user would see): the policy applied to this judge alone, so PASS needs verified evidence.
  const verdict = (id: string, kind: "before" | "after_pos" | "after_ctrl", text: string | undefined) => {
    const r = get(id, kind);
    return combineJudges(text ?? "", [r?.answer ? { judgeId: judge, answer: r.answer } : { judgeId: judge }]).verdict;
  };
  let pu = 0, fp = 0, fc = 0, failP = 0, revP = 0, failC = 0, revC = 0;
  for (const p of cases.regression) {
    if (verdict(p.id, "before", texts.before.get(p.id)) !== "PASS") continue;
    pu++;
    const vp = verdict(p.id, "after_pos", texts.after_pos.get(p.id));
    const vc = verdict(p.id, "after_ctrl", texts.after_ctrl.get(p.id));
    if (vp !== "PASS") { fp++; vp === "FAIL" ? failP++ : revP++; }
    if (vc !== "PASS") { fc++; vc === "FAIL" ? failC++ : revC++; }
  }

  // Quote integrity: of the passages a judge quoted, how many are really in the text?
  let qTotal = 0, qVerified = 0;
  for (const r of rs) {
    if (!r.answer?.quotes.length) continue;
    const t = r.kind === "static" ? texts.static.get(r.caseId) : r.kind === "cuad" ? texts.cuad.get(r.caseId) : texts[r.kind].get(r.caseId);
    if (!t) continue;
    for (const e of verifyQuotes(t, r.answer.quotes, 10)) { qTotal++; if (e.verified) qVerified++; }
  }

  const ok = rs.filter((r) => r.answer);
  const inTok = rs.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const outTok = rs.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  void truth;
  return {
    judge,
    calls: rs.reduce((sum, record) => sum + (record.requestCount ?? 1), 0),
    errors: rs.length - ok.length,
    coverage: { static: { answered: answeredCount("static"), total: cases.static.length }, cuad: { answered: cuadRows.filter((row) => Boolean(get(row.id, "cuad")?.answer)).length, total: cases.cuadStatic.length }, regressionTexts: { answered: ["before", "after_pos", "after_ctrl"].reduce((n, kind) => n + answeredCount(kind as CallKind), 0), total: cases.regression.length * 3 } },
    static: {
      n: cases.static.length,
      accuracy: wilson(rep.correct, rep.total),
      macroF1: rep.macroF1,
      recall: Object.fromEntries(NLI.slice(0, 3).map((l) => [l, rep.per[l].recall])),
      binaryAccuracy: wilson(binCorrect, cases.static.length),
      abstain: rows.filter((r) => r.pred === "Abstain").length,
      brier: probs.length ? brier(probs) : null,
      confusion: m,
      meanDecisionConfidence: confidenceValues.length ? confidenceValues.reduce((sum, x) => sum + x, 0) / confidenceValues.length : null,
      choiceCalibration,
    },
    cuad: { n: cuadRows.length, attempted: attemptedCuadIds.size, answered: cuadRows.filter((row) => Boolean(get(row.id, "cuad")?.answer)).length, cases: cases.cuadStatic.length, negativeCases: cuadRows.filter((x) => !x.hasClause).length, accuracy: wilson(cuadRows.filter((x) => x.correct).length, cuadRows.length), falsePassRate: wilson(cuadRows.filter((x) => !x.hasClause && x.predicted).length, cuadRows.filter((x) => !x.hasClause).length), categories: catStats },
    regression: { pairs: cases.regression.length, usable, detected, falseAlarm, separates, recallAll: wilson(detectedAll, cases.regression.length) },
    product: pu || rs.length ? { usable: pu, flaggedPos: fp, flaggedCtrl: fc, failPos: failP, reviewPos: revP, failCtrl: failC, reviewCtrl: revC } : null,
    quotes: qTotal ? { total: qTotal, verified: qVerified } : null,
    latency: { p50: percentile(ok.map((r) => r.ms), 0.5), p90: percentile(ok.map((r) => r.ms), 0.9), p95: percentile(ok.map((r) => r.ms), 0.95), p99: percentile(ok.map((r) => r.ms), 0.99) },
    tokens: inTok || outTok ? { input: inTok, output: outTok } : null,
  };
}

export function readRaw(file: string): RawRecord[] {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RawRecord) : [];
}

/** Price per token from OpenRouter's public model list (USD). Returns undefined if unavailable: we never invent a price. */
export async function openRouterPrice(model: string): Promise<{ prompt: number; completion: number } | undefined> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    const data = (await res.json()) as { data: { id: string; pricing: { prompt: string; completion: string } }[] };
    const m = data.data.find((x) => x.id === model);
    return m ? { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) } : undefined;
  } catch {
    return undefined;
  }
}

const fmtMs = (ms: number) => (Number.isNaN(ms) ? "n/a" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

export function renderMarkdown(args: { summaries: JudgeSummary[]; cases: CasesFile; config: Record<string, unknown>; prices: Record<string, { prompt: number; completion: number } | undefined>; jevNote: string; generatedAt: string }): string {
  const { summaries, cases, config, prices, jevNote, generatedAt } = args;
  const L: string[] = [];
  L.push("# CLAUSE CI benchmark results", "", `Generated ${generatedAt} by \`pnpm bench:ci:report\` from the raw answers in \`bench/ci/results/\`. Nothing below is typed by hand.`, "");
  L.push("## What was measured", "");
  L.push("Can a judge tell whether a contract **satisfies a requirement**, and does it notice when an edit **stops** satisfying it? Data: [ContractNLI](https://stanfordnlp.github.io/contract-nli/) (Koreeda & Manning, *Findings of EMNLP 2021*; CC BY 4.0): real NDAs with expert labels and evidence spans. The requirement text is ContractNLI's own hypothesis wording.", "");
  L.push(`- **Static task** (n=${cases.static.length}, 20 per label from the test split): classify each document as *Entailment*, *Contradiction* or *NotMentioned* for one hypothesis.`);
  L.push(`- **Regression task** (n=${cases.regression.length} pairs): for a hypothesis the experts marked *Entailment*, (a) **delete the expert-marked evidence sentences** (should stop being satisfied) and (b) as a control **delete ${cases.meta.controlSpans} unrelated sentences** (should stay satisfied). Edits are applied with CLAUSE's own edit engine.`);
  L.push(`- **CUAD task** (n=${cases.cuadStatic.length} fixed cases, contracts ≤${cases.meta.maxCuadDocChars.toLocaleString()} characters): test contract clauses across ${new Set(cases.cuadStatic.map((c) => c.category)).size} expert-annotated categories. Each category contributes a deterministic positive and negative example when available; cases use the official CUAD test split.`);
  L.push(`- Cases, seed (${cases.meta.seed}) and thresholds were **committed before any judge ran** on them (commit \`cafc0d5\`). The keyword baseline's one threshold was tuned on the dev split only (dev macro-F1 ${config.heuristicDevMacroF1}).`, "");
  L.push("## Judges", "", `- **keyword-baseline**: no model; best-matching sentence by distinctive-word overlap (τ=${config.heuristicTau}), negation mismatch ⇒ contradicted. Its quotes are real sentences, so they verify.`);
  for (const s of summaries.filter((x) => x.judge !== "keyword-baseline")) L.push(`- **${s.judge}**`);
  L.push(`- ${jevNote}`, "");

  L.push("## Static task: three-way classification", "", "| Judge | Answered / frozen | Accuracy [95% CI] | Macro-F1 | Entailment recall | Contradiction recall | NotMentioned recall | Abstained/errored | Brier |", "|---|---:|---|---:|---:|---:|---:|---:|---:|");
  for (const s of summaries) L.push(`| ${s.judge} | ${s.coverage.static.answered}/${s.coverage.static.total} | ${fmtCi(Math.round(s.static.accuracy.p * s.static.n), s.static.n)} | ${s.static.macroF1.toFixed(3)} | ${pct(s.static.recall.Entailment!)} | ${pct(s.static.recall.Contradiction!)} | ${pct(s.static.recall.NotMentioned!)} | ${s.static.abstain} | ${s.static.brier === null ? "n/a" : s.static.brier.toFixed(3)} |`);
  L.push("", "Chance for three balanced classes is 33.3% accuracy. *Brier* scores the judge's own P(entailed) against the truth (lower is better; 0.25 = coin flip); the keyword baseline has no probability.", "");
  L.push("## Choice confidence and calibration", "", "| Judge | Mean selected-label confidence | Selected-label Brier | 10-bin ECE | n |", "|---|---:|---:|---:|---:|");
  for (const s of summaries) L.push(`| ${s.judge} | ${s.static.meanDecisionConfidence === null ? "n/a" : s.static.meanDecisionConfidence.toFixed(3)} | ${s.static.choiceCalibration?.brier.toFixed(3) ?? "n/a"} | ${s.static.choiceCalibration?.ece.toFixed(3) ?? "n/a"} | ${s.static.choiceCalibration?.n ?? 0} |`);
  L.push("", "Selected-label probability calibration uses the probability Jev assigned to its chosen class. The separately returned Jev `confidence` field is only a distribution-shape measure; its mean is shown for context and is not treated as probability of correctness.", "");

  L.push("## Regression task: does a judge notice that an edit broke a requirement?", "", "Counted only on pairs where the judge saw the requirement as satisfied **before** the edit (otherwise there is nothing to regress).", "", "| Judge | Answered texts / 90 | Usable pairs | Edit that removes the evidence is flagged | Harmless edit wrongly flagged | Tells the two apart | Flagged, counting unusable pairs as misses |", "|---|---:|---:|---|---|---|---|");
  for (const s of summaries) { const r = s.regression; L.push(`| ${s.judge} | ${s.coverage.regressionTexts.answered}/${s.coverage.regressionTexts.total} | ${r.usable}/${r.pairs} | ${fmtCi(r.detected, r.usable)} | ${fmtCi(r.falseAlarm, r.usable)} | ${fmtCi(r.separates, r.usable)} | ${fmtCi(Math.round(r.recallAll.p * r.pairs), r.pairs)} |`); }
  L.push("", "*Tells the two apart* = flagged the evidence-deleting edit **and** did not flag the harmless one, in the same pair (the strictest, paired measure).", "");

  L.push("## What a user would actually see (CLAUSE CI's policy applied to each judge alone)", "", "A PASS needs a quote that is verified verbatim in the text, so a judge that cites nothing can never PASS.", "", "| Judge | Usable pairs (PASS before) | Evidence-deleting edit: FAIL / NEEDS_REVIEW | Harmless edit: FAIL / NEEDS_REVIEW |", "|---|---|---|---|");
  for (const s of summaries) { const p = s.product; if (!p) continue; L.push(`| ${s.judge} | ${p.usable}/${s.regression.pairs} | ${p.failPos} / ${p.reviewPos} (of ${p.usable}) | ${p.failCtrl} / ${p.reviewCtrl} (of ${p.usable}) |`); }
  L.push("");

  L.push("## CUAD: clause detection", "", "A raw `entailed` model label is counted as clause detection so Jev can be compared despite not generating a quote. Product PASS still requires verified evidence from the existing judge. False PASS rate is measured on agreements annotated as lacking the category. Provider failures count as no detection; answered and attempted coverage are shown.", "", "| Judge | Answered / attempted / frozen | Accuracy [95% CI] | False PASS rate [95% CI] |", "|---|---:|---|---|");
  for (const s of summaries) {
    L.push(`| ${s.judge} | ${s.cuad.answered}/${s.cuad.attempted}/${s.cuad.cases} | ${fmtCi(Math.round(s.cuad.accuracy.p * s.cuad.n), s.cuad.n)} | ${s.cuad.negativeCases ? fmtCi(Math.round(s.cuad.falsePassRate.p * s.cuad.negativeCases), s.cuad.negativeCases) : "n/a"} |`);
  }
  for (const s of summaries) {
    L.push("", `### ${s.judge} by CUAD category`, "", "| Category | Cases | Accuracy [95% CI] | False PASS [95% CI] |", "|---|---:|---|---|");
    for (const [category, m] of Object.entries(s.cuad.categories)) {
      L.push(`| ${category} | ${m.answered}/${m.n} | ${fmtCi(Math.round(m.accuracy.p * m.n), m.n)} | ${m.negativeCases ? fmtCi(Math.round(m.falsePassRate.p * m.negativeCases), m.negativeCases) : "n/a"} |`);
    }
  }

  L.push("## Evidence integrity, latency, cost", "", "| Judge | Calls / errors | Quotes found verbatim in the text | Latency p50 / p90 / p95 / p99 per answered call | Tokens (in / out) | Estimated cost from reported tokens |", "|---|---:|---|---|---|---|");
  for (const s of summaries) {
    const price = prices[s.judge];
    const cost = s.tokens && price ? `$${(s.tokens.input * price.prompt + s.tokens.output * price.completion).toFixed(2)}` : s.tokens ? "price unavailable" : "n/a";
    L.push(`| ${s.judge} | ${s.calls} / ${s.errors} | ${s.quotes ? fmtCi(s.quotes.verified, s.quotes.total) : "n/a (no quotes)"} | ${fmtMs(s.latency.p50)} / ${fmtMs(s.latency.p90)} / ${fmtMs(s.latency.p95)} / ${fmtMs(s.latency.p99)} | ${s.tokens ? `${s.tokens.input.toLocaleString()} / ${s.tokens.output.toLocaleString()}` : "n/a"} | ${cost} |`);
  }
  L.push("", "## How to read this, and its limits", "");
  L.push(`- **Small samples.** n=${cases.static.length} static items and ${cases.regression.length} pairs give wide intervals (a 95% interval on 30 trials is roughly ±17 points). Differences between rows that fall inside each other's intervals are **not evidence that one judge is better**.`);
  L.push("- **Automatic labels have noise.** The regression 'truth' assumes the experts marked *all* supporting sentences; if one was missed, deleting the marked ones may not remove entailment, which would show up as a missed flag that is the label's fault, not the judge's.");
  L.push(`- ContractNLI covers English NDAs up to ${cases.meta.maxDocChars.toLocaleString()} characters; CUAD covers commercial contracts across 41 categories, sampled from contracts up to ${cases.meta.maxCuadDocChars.toLocaleString()} characters.`);
  L.push("- One run per judge at temperature 0; models can change behind an alias, so the exact model ids above are part of the result.");
  L.push("- This measures whether a judge's answer matches the experts' labels. It does not measure legal correctness, and CLAUSE CI's reports remain advisory.", "");
  L.push("Datasets: ContractNLI, Koreeda & Manning (2021), CC BY 4.0, https://stanfordnlp.github.io/contract-nli/; CUAD, The Atticus Project (2021), CC BY 4.0, https://www.atticusprojectai.org/cuad/.", "");
  return L.join("\n");
}

async function main() {
  const dir = join(import.meta.dirname, "results");
  const cases = JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")) as CasesFile;
  const config = JSON.parse(readFileSync(join(import.meta.dirname, "config.json"), "utf8")) as Record<string, unknown> & { llmModel: string; jevModel: string };
  const { buildJobs } = await import("./run.ts");
  const texts: Texts = { static: new Map(), cuad: new Map(), before: new Map(), after_pos: new Map(), after_ctrl: new Map() };
  for (const j of buildJobs()) texts[j.kind].set(j.caseId, j.text);

  const arms = [
    { id: "keyword-baseline", file: "raw-keyword-baseline.jsonl" },
    { id: config.llmModel, file: "raw-llm.jsonl" },
    { id: config.jevModel, file: "raw-jev.jsonl" },
  ].map((a) => ({ ...a, raw: readRaw(join(dir, a.file)) })).filter((a) => a.raw.length > 0);

  const truth = new Map<string, Nli>();
  const summaries = arms.map((a) => summarize(a.id, a.raw, cases, texts, truth));
  const prices: Record<string, Awaited<ReturnType<typeof openRouterPrice>>> = {};
  for (const s of summaries) {
    if (s.judge === config.llmModel) prices[s.judge] = await openRouterPrice(s.judge);
    if (s.judge === config.jevModel) prices[s.judge] = { prompt: 0.042 / 1_000_000, completion: 0 };
  }

  const jevRan = arms.some((a) => a.id === config.jevModel);
  const jevNote = jevRan
    ? `**${config.jevModel}** via the official TypeSafe SDK direct API (pinned model id).`
    : `**${config.jevModel}: not run in this benchmark invocation.** Set a replacement \`TYPESAFE_API_KEY\` to produce measured results. No performance or accuracy claim is made without those results.`;

  const md = renderMarkdown({ summaries, cases, config, prices, jevNote, generatedAt: new Date().toISOString().slice(0, 10) });
  writeFileSync(join(import.meta.dirname, "RESULTS.md"), md);
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summaries, null, 1) + "\n");
  console.log(md);
}

if (import.meta.main) await main();
