import { cpus, loadavg, platform, release, totalmem } from "node:os";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyChanges, type Change } from "../packages/core/src/index.ts";
import { buildApp } from "../apps/api/src/app.ts";
import { END_MARKER, generateContract, RARE_TOKEN } from "./generate.ts";

const SIZE = Number(process.env.BENCH_BYTES ?? 10 * 1024 * 1024);
const REPEATS = 5;

let peakRss = 0;
const sample = () => (peakRss = Math.max(peakRss, process.memoryUsage().rss));
const ms = (t0: number) => +(performance.now() - t0).toFixed(1);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function time<T>(fn: () => Promise<T> | T): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  sample();
  return { ms: ms(t0), value };
}

async function repeat(fn: () => Promise<unknown> | unknown): Promise<{ median: number; runs: number[] }> {
  const runs: number[] = [];
  for (let i = 0; i < REPEATS; i++) runs.push((await time(fn)).ms);
  return { median: median(runs), runs };
}

const dir = mkdtempSync(join(tmpdir(), "clause-bench-"));
const dbPath = join(dir, "bench.db");
const app = await buildApp({ dbPath });
const rows: Record<string, unknown>[] = [];
const report = (stage: string, detail: Record<string, unknown>) => {
  rows.push({ stage, ...detail });
  console.log(`${stage.padEnd(46)} ${JSON.stringify(detail)}`);
};

console.log(`CLAUSE benchmark  size=${(SIZE / 1048576).toFixed(1)} MiB  node=${process.version}  sqlite=${process.versions.sqlite}`);
console.log(`machine: ${cpus()[0]?.model} x${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(0)} GiB RAM, ${platform()} ${release()}`);
console.log(`load average at start: ${loadavg().map((n) => n.toFixed(1)).join(" ")}  (high load inflates every number below; rerun on an idle machine)\n`);

const gen = await time(() => generateContract(SIZE));
const content = gen.value;
report("generate synthetic contract", { ms: gen.ms, chars: content.length, bytes: Buffer.byteLength(content) });

// --- pure engine, no I/O
const unique: Change = { operation: "replace", target: { quote: { exact: END_MARKER } }, replacement: "THE-LAST-CLAUSE-EDITED" };
report("engine: replace unique target near EOF", { medianMs: (await repeat(() => applyChanges(content, [unique]))).median });

const many: Change[] = [];
for (let i = 1; i <= 100; i++) many.push({ operation: "replace", target: { quote: { exact: `Clause ${i * 40} café`, prefix: "", occurrence: 1 } }, replacement: `Clause ${i * 40} CAFE` });
report("engine: 100-change batch (quote targets)", { medianMs: (await repeat(() => applyChanges(content, many))).median });

const ambiguous = await repeat(() => applyChanges(content, [{ operation: "replace", target: { quote: { exact: "shall not disclose" } }, replacement: "x" }]));
report("engine: ambiguous target rejected (full scan)", { medianMs: ambiguous.median });

// --- through the full stack (HTTP serialization + SQLite + FTS triggers)
const created = await time(async () => app.inject({ method: "POST", url: "/documents", payload: { title: "Big MSA", content } }));
if (created.value.statusCode !== 201) {
  throw new Error(`POST /documents benchmark setup failed: ${created.value.statusCode} ${(await created.value.body).slice(0, 300)}`);
}
const doc = created.value.json() as { id: string; version: number };
report("POST /documents (insert + 2 FTS indexes + v1 snapshot)", { ms: created.ms, status: created.value.statusCode, dbMB: +(statSync(dbPath).size / 1048576).toFixed(1) });

const words = await repeat(() => app.inject({ method: "GET", url: `/documents/search?q=${RARE_TOKEN}` }));
report("GET search words (rare token)", { medianMs: words.median });
const wordsCommon = await repeat(() => app.inject({ method: "GET", url: "/documents/search?q=confidential%20information" }));
report("GET search words (very common phrase)", { medianMs: wordsCommon.median });
const exact = await repeat(() => app.inject({ method: "GET", url: `/documents/search?q=${encodeURIComponent(END_MARKER)}&mode=exact` }));
report("GET search exact (unique string)", { medianMs: exact.median });
const exactCommon = await repeat(() => app.inject({ method: "GET", url: "/documents/search?q=shall%20not%20disclose&mode=exact" }));
report("GET search exact (hundreds of thousands of hits)", { medianMs: exactCommon.median });

const patch1 = await time(() =>
  app.inject({ method: "PATCH", url: `/documents/${doc.id}`, payload: { expectedVersion: 1, changes: [unique] } }),
);
const p1 = patch1.value.json() as { version: number; content: string };
report("PATCH unique replace near EOF (full stack)", { ms: patch1.ms, status: patch1.value.statusCode, newVersion: p1.version, responseMB: +(p1.content.length / 1048576).toFixed(1) });

const patch100 = await time(() =>
  app.inject({ method: "PATCH", url: `/documents/${doc.id}`, payload: { expectedVersion: 2, changes: many } }),
);
report("PATCH 100-change batch (full stack)", { ms: patch100.ms, status: patch100.value.statusCode });

const prev = await time(() => app.inject({ method: "POST", url: `/documents/${doc.id}/changes/preview`, payload: { changes: [{ operation: "replace", target: { quote: { exact: "THE-LAST-CLAUSE-EDITED" } }, replacement: "X" }] } }));
report("POST preview incl. unified diff (full stack)", { ms: prev.ms, status: prev.value.statusCode });

const stale = await time(() => app.inject({ method: "PATCH", url: `/documents/${doc.id}`, payload: { expectedVersion: 1, changes: [unique] } }));
report("PATCH stale version rejected", { ms: stale.ms, status: stale.value.statusCode });

report("memory", { peakRssMB: +(peakRss / 1048576).toFixed(0), finalDbMB: +(statSync(dbPath).size / 1048576).toFixed(1) });
await app.close();
rmSync(dir, { recursive: true, force: true });
