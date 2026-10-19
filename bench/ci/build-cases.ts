/**
 * Builds bench/ci/cases.json: the benchmark's fixed inputs. Deterministic (seeded) and committed BEFORE any judge is run,
 * so the cases cannot be tuned to the results. The file holds ids and offsets only, never dataset text (CC BY 4.0 data
 * stays in the git-ignored bench/ci/data/); `run.ts` rebuilds the texts from the dataset.
 *
 *   static     60 real labelled items from ContractNLI test (20 per label): can a judge tell entailed / contradicted / not mentioned?
 *   regression 30 PAIRS from ContractNLI test, built from the experts' evidence spans:
 *                positive: delete every evidence span of an entailed hypothesis -> it should STOP being satisfied
 *                control:  delete 3 non-evidence sentences                       -> it should STILL be satisfied
 *   dev        60 labelled items from ContractNLI dev (20 per label): the ONLY data any threshold may be tuned on.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { annotationsOf, loadSplit, type NliDocument, type NliLabel } from "./dataset.ts";
import { loadCuadSplit } from "./cuad-dataset.ts";
import { mulberry32, shuffle } from "./metrics.ts";

export const SEED = 20261015;
const MAX_DOC_CHARS = 20_000; // cost bound; the median ContractNLI NDA is ~9.6k
const MAX_CUAD_DOC_CHARS = 20_000; // keep frozen CUAD prompts below the configured provider input budget
const PER_LABEL = 20;
const PAIRS = 30;
const CONTROL_SPANS = 3;
const MIN_CONTROL_SPAN_CHARS = 30;
const MAX_EVIDENCE_COVERAGE = 0.4;

export interface StaticCase { id: string; split: "dev" | "test"; docId: number; hypothesis: string; label: NliLabel }
export interface RegressionPair { id: string; docId: number; hypothesis: string; evidenceSpans: [number, number][]; controlSpans: [number, number][] }
export interface CuadCase { id: string; documentId: string; category: string; requirement: string; hasClause: boolean }
export interface CasesFile {
  meta: { seed: number; datasetZipSha256: string; cuadZipSha256: string; maxDocChars: number; maxCuadDocChars: number; perLabel: number; pairs: number; controlSpans: number; note: string };
  dev: StaticCase[];
  static: StaticCase[];
  regression: RegressionPair[];
  cuadDev: CuadCase[];
  cuadStatic: CuadCase[];
}

function cuadCases(split: "train" | "test", rnd: () => number): CuadCase[] {
  const items = loadCuadSplit(split).filter((x) => x.text.length <= MAX_CUAD_DOC_CHARS);
  const categories = [...new Set(items.map((x) => x.category))].sort();
  const out: CuadCase[] = [];
  for (const category of categories) {
    const usedDocs = new Set<string>();
    for (const hasClause of [false, true]) {
      const available = shuffle(items.filter((x) => x.category === category && x.hasClause === hasClause && !usedDocs.has(x.documentId)), rnd);
      const item = available[0];
      if (!item) continue;
      usedDocs.add(item.documentId);
      out.push({ id: `cuad-${split}-${item.id}`, documentId: item.documentId, category, requirement: item.requirement, hasClause });
    }
  }
  return out;
}

function stratified(split: "dev" | "test", rnd: () => number): StaticCase[] {
  const data = loadSplit(split);
  const all: StaticCase[] = [];
  for (const d of data.documents) {
    if (d.text.length > MAX_DOC_CHARS) continue;
    for (const [hyp, a] of Object.entries(annotationsOf(d))) all.push({ id: `${split}-${d.id}-${hyp}`, split, docId: d.id, hypothesis: hyp, label: a.choice });
  }
  const out: StaticCase[] = [];
  const perDoc = new Map<number, number>();
  for (const label of ["Entailment", "Contradiction", "NotMentioned"] as const) {
    let taken = 0;
    for (const c of shuffle(all.filter((x) => x.label === label), rnd)) {
      if (taken >= PER_LABEL) break;
      if ((perDoc.get(c.docId) ?? 0) >= 2) continue; // at most 2 items from one contract
      perDoc.set(c.docId, (perDoc.get(c.docId) ?? 0) + 1);
      out.push(c);
      taken++;
    }
    if (taken < PER_LABEL) throw new Error(`only ${taken} ${label} items available in ${split}`);
  }
  return out;
}

function regressionPairs(rnd: () => number): RegressionPair[] {
  const data = loadSplit("test");
  const candidates: RegressionPair[] = [];
  for (const d of data.documents as NliDocument[]) {
    if (d.text.length > MAX_DOC_CHARS) continue;
    for (const [hyp, a] of Object.entries(annotationsOf(d))) {
      if (a.choice !== "Entailment" || a.spans.length === 0) continue;
      const evidence = a.spans.map((i) => d.spans[i]!).sort((x, y) => x[0] - y[0]);
      const covered = evidence.reduce((s, [x, y]) => s + (y - x), 0);
      if (covered / d.text.length > MAX_EVIDENCE_COVERAGE) continue; // deleting most of the contract proves nothing
      const evidenceSet = new Set(a.spans);
      const spare = d.spans.map((s, i) => ({ s, i })).filter(({ s, i }) => !evidenceSet.has(i) && s[1] - s[0] >= MIN_CONTROL_SPAN_CHARS);
      if (spare.length < CONTROL_SPANS) continue;
      const control = shuffle(spare, rnd).slice(0, CONTROL_SPANS).map(({ s }) => s).sort((x, y) => x[0] - y[0]);
      candidates.push({ id: `reg-${d.id}-${hyp}`, docId: d.id, hypothesis: hyp, evidenceSpans: evidence, controlSpans: control });
    }
  }
  const out: RegressionPair[] = [];
  const docs = new Set<number>();
  for (const c of shuffle(candidates, rnd)) {
    if (docs.has(c.docId)) continue; // one pair per contract
    docs.add(c.docId);
    out.push(c);
    if (out.length === PAIRS) break;
  }
  if (out.length < PAIRS) throw new Error(`only ${out.length} regression pairs available`);
  return out;
}

export function buildCases(): CasesFile {
  const zip = join(import.meta.dirname, "data", "contract-nli.zip");
  return {
    meta: {
      seed: SEED,
      datasetZipSha256: createHash("sha256").update(readFileSync(zip)).digest("hex"),
      cuadZipSha256: createHash("sha256").update(readFileSync(join(import.meta.dirname, "data", "cuad.zip"))).digest("hex"),
      maxDocChars: MAX_DOC_CHARS,
      maxCuadDocChars: MAX_CUAD_DOC_CHARS,
      perLabel: PER_LABEL,
      pairs: PAIRS,
      controlSpans: CONTROL_SPANS,
      note: "Ids and offsets only. ContractNLI and CUAD source data are CC BY 4.0; see dataset provenance in RESULTS.md.",
    },
    dev: stratified("dev", mulberry32(SEED + 1)),
    static: stratified("test", mulberry32(SEED + 2)),
    regression: regressionPairs(mulberry32(SEED + 3)),
    cuadDev: cuadCases("train", mulberry32(SEED + 4)),
    cuadStatic: cuadCases("test", mulberry32(SEED + 5)),
  };
}

if (import.meta.main) {
  const cases = buildCases();
  writeFileSync(join(import.meta.dirname, "cases.json"), JSON.stringify(cases, null, 1) + "\n");
  const count = (xs: StaticCase[]) => xs.reduce<Record<string, number>>((m, x) => { m[x.label] = (m[x.label] ?? 0) + 1; return m; }, {});
  console.log("dev", count(cases.dev), "| static", count(cases.static), "| regression pairs", cases.regression.length);
  console.log("distinct docs: static", new Set(cases.static.map((c) => c.docId)).size, "regression", new Set(cases.regression.map((c) => c.docId)).size);
  console.log("CUAD dev/static", cases.cuadDev.length, cases.cuadStatic.length);
  console.log("overlap of dev docs with test docs (must be 0):", cases.dev.filter((d) => cases.static.some((s) => s.docId === d.docId)).length);
}
