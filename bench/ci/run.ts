/**
 * Runs the judges over bench/ci/cases.json and records every raw answer (resumable) in bench/ci/results/.
 *
 *   pnpm bench:ci                 # heuristic + LLM (needs OPENROUTER_API_KEY), 
 *   pnpm bench:ci -- --only llm   # one judge
 *
 * It exercises the PRODUCTION judges (createLlmJudge), so what is measured is what ships.
 * Nothing here is tuned: thresholds come from config.json, which was frozen before this ran.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyChanges, type Change } from "../../packages/core/src/index.ts";
import { createLlmJudge, openRouterGenerate } from "../../apps/api/src/review/judges/llm.ts";
import type { Judge, JudgeAnswer } from "../../apps/api/src/review/judges/types.ts";
import type { CasesFile } from "./build-cases.ts";
import config from "./config.json" with { type: "json" };
import { loadSplit, type NliDocument } from "./dataset.ts";
import { createHeuristicJudge } from "./heuristic.ts";
import { loadCuadSplit } from "./cuad-dataset.ts";
import { typeSafeJevJudge } from "../../apps/api/src/review/judges/jev.ts";

export type CallKind = "static" | "cuad" | "before" | "after_pos" | "after_ctrl";
export interface RawRecord {
  judge: string;
  caseId: string;
  kind: CallKind;
  answer: JudgeAnswer | null;
  error?: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Number of provider requests represented; one record per question, one request count per batch. */
  requestCount?: number;
}

const resultsDir = join(import.meta.dirname, "results");
mkdirSync(resultsDir, { recursive: true });
const cases = JSON.parse(readFileSync(join(import.meta.dirname, "cases.json"), "utf8")) as CasesFile;
const test = loadSplit("test");
const docs = new Map(test.documents.map((d) => [d.id, d]));
const cuad = new Map(loadCuadSplit("test").map((d) => [d.id, d]));

/** Deletes spans from a document using the product's own edit engine (position selectors with expectedText). */
function deleteSpans(doc: NliDocument, spans: [number, number][]): string {
  const changes: Change[] = spans.map(([start, end]) => ({ operation: "replace", target: { position: { start, end, expectedText: doc.text.slice(start, end) } }, replacement: "" }));
  const r = applyChanges(doc.text, changes);
  if (!r.ok) throw new Error(`could not apply deletion: ${JSON.stringify(r.error)}`);
  return r.value.content;
}

export interface Job { caseId: string; kind: CallKind; requirement: string; text: string }
export function buildJobs(): Job[] {
  const jobs: Job[] = [];
  for (const c of cases.static) jobs.push({ caseId: c.id, kind: "static", requirement: test.labels[c.hypothesis]!.hypothesis, text: docs.get(c.docId)!.text });
  for (const c of cases.cuadStatic) {
    const sourceId = c.id.slice("cuad-test-".length);
    const item = cuad.get(sourceId);
    if (!item) throw new Error(`missing CUAD item ${sourceId}`);
    jobs.push({ caseId: c.id, kind: "cuad", requirement: c.requirement, text: item.text });
  }
  for (const p of cases.regression) {
    const doc = docs.get(p.docId)!;
    const requirement = test.labels[p.hypothesis]!.hypothesis;
    jobs.push({ caseId: p.id, kind: "before", requirement, text: doc.text });
    jobs.push({ caseId: p.id, kind: "after_pos", requirement, text: deleteSpans(doc, p.evidenceSpans) });
    jobs.push({ caseId: p.id, kind: "after_ctrl", requirement, text: deleteSpans(doc, p.controlSpans) });
  }
  return jobs;
}

async function runPool<T>(items: T[], concurrency: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

function safeProviderError(error: unknown): string {
  const value = error as { name?: unknown; status?: unknown; statusCode?: unknown };
  const name = typeof value?.name === "string" ? value.name : "ProviderError";
  const status = typeof value?.statusCode === "number" ? value.statusCode : typeof value?.status === "number" ? value.status : undefined;
  return status === undefined ? name : `${name} (${status})`;
}

function loadDone(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { const r = JSON.parse(l) as RawRecord; return r.answer ? [`${r.caseId}|${r.kind}`] : []; }));
}

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined;
  const jobs = buildJobs();
  console.log(`${jobs.length} judge calls per model (${cases.static.length} ContractNLI + ${cases.cuadStatic.length} CUAD + ${cases.regression.length} regression texts)`);
  const jobsToRun = (file: string) => { const done = loadDone(file); return jobs.filter((j) => !done.has(`${j.caseId}|${j.kind}`)); };

  const arms: { id: string; file: string; make: (usage: { in: number; out: number }) => Judge; concurrency: number }[] = [
    { id: "keyword-baseline", file: "raw-keyword-baseline.jsonl", make: () => createHeuristicJudge(config.heuristicTau), concurrency: 8 },
  ];
  if (process.env.OPENROUTER_API_KEY) {
    const key = process.env.OPENROUTER_API_KEY;
    arms.push({ id: config.llmModel, file: "raw-llm.jsonl", concurrency: 4, make: (u) => createLlmJudge({ id: config.llmModel, generate: openRouterGenerate(key, config.llmModel, (x) => { u.in = x.inputTokens; u.out = x.outputTokens; }) }) });
  } else console.log("no OPENROUTER_API_KEY: skipping the LLM arm");
  if (process.env.TYPESAFE_API_KEY) {
    arms.push({ id: config.jevModel, file: "raw-jev.jsonl", concurrency: 4, make: (u) => {
      const judge = typeSafeJevJudge(process.env.TYPESAFE_API_KEY!, (event) => { if (event.usage) { u.in = event.usage.inputTokens; u.out = event.usage.outputTokens; } });
      return { ...judge, judge: judge.judge.bind(judge) };
    } });
  } else console.log("no TYPESAFE_API_KEY: skipping the Jev arm");

  for (const arm of arms.filter((a) => !only || a.file.includes(only))) {
    const file = join(resultsDir, arm.file);
    const todo = jobsToRun(file);
    console.log(`\n[${arm.id}] ${todo.length} calls to run (${jobs.length - todo.length} already done)`);
    let finished = 0;
    let fatal: string | undefined;
    if (arm.id === config.jevModel && process.env.TYPESAFE_API_KEY) {
      const groups = [...todo.reduce((map, job) => map.set(job.text, [...(map.get(job.text) ?? []), job]), new Map<string, Job[]>()).values()];
      console.log(`  batching ${todo.length} requirements across ${groups.length} unique document states`);
      await runPool(groups, arm.concurrency, async (group) => {
        if (fatal) return;
        const usage = { in: 0, out: 0 };
        const judge = typeSafeJevJudge(process.env.TYPESAFE_API_KEY!, (event) => { if (event.usage) { usage.in = event.usage.inputTokens; usage.out = event.usage.outputTokens; } });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.judgeTimeoutMs);
        const started = performance.now();
        try {
          const answers = await judge.judgeBatch!(group.map((job) => ({ requirement: job.requirement, text: job.text, isGoal: false, signal: controller.signal })));
          const ms = Math.round(performance.now() - started);
          group.forEach((job, index) => {
            const rec: RawRecord = { judge: arm.id, caseId: job.caseId, kind: job.kind, answer: answers[index]!, ms, requestCount: index === 0 ? 1 : 0, ...(index === 0 && usage.in ? { inputTokens: usage.in } : {}), ...(index === 0 && usage.out ? { outputTokens: usage.out } : {}) };
            appendFileSync(file, JSON.stringify(rec) + "\n");
          });
        } catch (error) {
          const safeError = safeProviderError(error);
          if (/401|402|403/.test(safeError)) fatal = safeError;
          const ms = Math.round(performance.now() - started);
          group.forEach((job, index) => { appendFileSync(file, JSON.stringify({ judge: arm.id, caseId: job.caseId, kind: job.kind, answer: null, error: safeError, ms, requestCount: index === 0 ? 1 : 0 }) + "\n"); });
        } finally {
          clearTimeout(timer);
        }
        finished += group.length;
        if (finished % 20 < group.length) console.log(`  ${finished}/${todo.length}`);
      });
      if (fatal) console.log(`  STOPPED: ${fatal}`);
      continue;
    }
    await runPool(todo, arm.concurrency, async (job) => {
      if (fatal) return;
      const usage = { in: 0, out: 0 };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.judgeTimeoutMs);
      const t0 = performance.now();
      const rec: RawRecord = { judge: arm.id, caseId: job.caseId, kind: job.kind, answer: null, ms: 0 };
      try {
        rec.answer = await arm.make(usage).judge({ requirement: job.requirement, text: job.text, isGoal: false, signal: controller.signal });
      } catch (e) {
        rec.error = safeProviderError(e);
        if (/401|402|403/.test(rec.error)) fatal = rec.error; // an access or credit problem: stop spending, don't repeat it across the corpus
      } finally {
        clearTimeout(timer);
      }
      rec.ms = Math.round(performance.now() - t0);
      rec.requestCount = 1;
      if (usage.in || usage.out) { rec.inputTokens = usage.in; rec.outputTokens = usage.out; }
      if (!fatal || rec.answer || rec.error) appendFileSync(file, JSON.stringify(rec) + "\n");
      if (++finished % 20 === 0) console.log(`  ${finished}/${todo.length}`);
    });
    if (fatal) console.log(`  STOPPED: ${fatal}`);
  }
}

if (import.meta.main) await main();
