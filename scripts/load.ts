/**
 * A small load check: starts a throwaway API (SQLite, temp file) and measures edit and search latency at a fixed
 * concurrency on ~1 MB documents, the size INFRA.md plans around. Run by hand: `pnpm load [workers] [seconds]`.
 * It measures ONE instance on THIS machine, so it checks the order of magnitude of the targets in INFRA.md, not a
 * production capacity.
 *
 * Numbers are only worth quoting after a warm-up: the first seconds against a fresh database are slower (caches, index
 * pages, JIT), so each scenario first runs for WARMUP seconds (default 3, `--warmup=0` turns it off) and discards them.
 * `--storage=postgres` runs the same scenarios against Postgres with documents sized to its 500,000-character cap; it
 * needs `CLAUSE_LOAD_DATABASE_URL` (a disposable database: the documents it creates are deleted at the end).
 *
 * `pnpm load 8 10 --client=oha` drives the read and search scenarios with oha (a load generator written in Rust,
 * `cargo install oha`) instead of this Node process. The client shares the machine with the server, so a lighter
 * client takes less CPU away from what is being measured. Edits stay on the Node client either way: each edit must send
 * the version the previous one returned, which a fixed-request generator cannot do.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const OHA = process.argv.includes("--client=oha");
const POSTGRES = process.argv.includes("--storage=postgres");
const WARMUP = Number(process.argv.find((a) => a.startsWith("--warmup="))?.split("=")[1] ?? 3);
const DATABASE_URL = process.env.CLAUSE_LOAD_DATABASE_URL;
if (POSTGRES && !DATABASE_URL) throw new Error("--storage=postgres needs CLAUSE_LOAD_DATABASE_URL (a disposable database)");
const WORKERS = Number(args[0] ?? 8);
const SECONDS = Number(args[1] ?? 10);
const ohaVersion = OHA ? execFileSync("oha", ["--version"], { encoding: "utf8" }).trim() : "";
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "clause-load-"));
const server = spawn("node", [join(import.meta.dirname, "../apps/api/src/server.ts")], {
  env: { ...process.env, PORT: String(PORT), CLAUSE_CREATE_PER_HOUR: "100000", OPENROUTER_API_KEY: "", AI_GATEWAY_API_KEY: "", ...(POSTGRES ? { CLAUSE_STORAGE: "postgres", DATABASE_URL: DATABASE_URL! } : { CLAUSE_STORAGE: "sqlite", CLAUSE_DB: join(dir, "load.db") }) },
  stdio: "ignore",
});
const stop = () => { server.kill(); rmSync(dir, { recursive: true, force: true }); };
process.on("exit", stop);

async function api<T>(method: string, path: string, body?: unknown, expect = 200): Promise<T> {
  const res = await fetch(BASE + path, { method, ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (res.status !== expect) throw new Error(`${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 120)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

const paragraph = (n: number) => `${n}.1 The Receiving Party shall not disclose Confidential Information to any third party, and shall protect it with reasonable care for a period of ${n % 7 + 1} years. `;
// ~1.1 MB on SQLite; ~0.47 MB on Postgres, which refuses documents over 500,000 characters.
const PARAGRAPHS = POSTGRES ? 2600 : 6000;
const body = (marker: string) => `${Array.from({ length: PARAGRAPHS }, (_, i) => paragraph(i)).join("\n\n")}\n\nMARKER ${marker} END\n`;
const docs = await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
  const content = body(`A-${w}`);
  const d = await api<{ id: string; version: number }>("POST", "/documents", { title: `load ${w}`, content }, 201);
  return { id: d.id, version: d.version, flip: false, w, size: content.length };
}));
console.log(`${WORKERS} workers x ${SECONDS}s per scenario; ${docs.length} documents of ${(docs[0]!.size / 1e6).toFixed(2)} MB (${new Date().toISOString().slice(0, 10)}, node ${process.version}, ${POSTGRES ? "Postgres" : "SQLite"}, warm-up ${WARMUP}s per scenario; reads and searches driven by ${OHA ? ohaVersion : "this Node process"})\n`);

type Row = { name: string; n: number; rps: number; p50: number; p95: number; p99: number; errors: number };
async function scenario(name: string, step: (w: number) => Promise<void>): Promise<Row> {
  if (WARMUP > 0) {
    const warmEnd = Date.now() + WARMUP * 1000;
    await Promise.all(Array.from({ length: WORKERS }, async (_, w) => { while (Date.now() < warmEnd) { try { await step(w); } catch { /* warm-up results are discarded */ } } }));
  }
  const lat: number[] = [];
  let errors = 0;
  const end = Date.now() + SECONDS * 1000;
  await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
    while (Date.now() < end) {
      const t = performance.now();
      try { await step(w); lat.push(performance.now() - t); } catch { errors++; }
    }
  }));
  lat.sort((a, b) => a - b);
  const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? NaN;
  return { name, n: lat.length, rps: lat.length / SECONDS, p50: q(0.5), p95: q(0.95), p99: q(0.99), errors };
}

/** The same GET, driven by oha with WORKERS connections for SECONDS. Percentiles come from oha's own JSON report. */
function ohaScenario(name: string, path: string): Row {
  if (WARMUP > 0) execFileSync("oha", ["-z", `${WARMUP}s`, "-c", String(WORKERS), "--no-tui", "--output-format", "quiet", BASE + path], { stdio: "ignore" });
  const out = execFileSync("oha", ["-z", `${SECONDS}s`, "-c", String(WORKERS), "--no-tui", "--output-format", "json", BASE + path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const r = JSON.parse(out) as { summary: { requestsPerSec: number }; latencyPercentiles: Record<string, number>; statusCodeDistribution: Record<string, number> };
  const n = Object.values(r.statusCodeDistribution).reduce((a, b) => a + b, 0);
  const ok = r.statusCodeDistribution["200"] ?? 0;
  const ms = (p: string) => (r.latencyPercentiles[p] ?? NaN) * 1000;
  return { name: `${name} [oha]`, n, rps: r.summary.requestsPerSec, p50: ms("p50"), p95: ms("p95"), p99: ms("p99"), errors: n - ok };
}

const reads: [string, string][] = [
  ["read one document (1 MB)", `/documents/${docs[0]!.id}`],
  ["search: words, all documents", "/documents/search?q=confidential+information&mode=words&limit=10"],
  ["search: exact phrase, all documents", `/documents/search?q=${encodeURIComponent("shall not disclose")}&mode=exact&limit=10`],
];
const rows: Row[] = [];
for (const [name, path] of reads) {
  // The Node client reads each worker's own document; oha sends one fixed URL, so it reads the first document.
  rows.push(OHA ? ohaScenario(name, path) : await scenario(name, async (w) => { await api("GET", name.startsWith("read") ? `/documents/${docs[w]!.id}` : path); }));
}
rows.push(await scenario("edit: one replacement in 1 MB (own document)", async (w) => {
  const d = docs[w]!;
  const [from, to] = d.flip ? [`B-${w}`, `A-${w}`] : [`A-${w}`, `B-${w}`];
  const r = await api<{ version: number }>("PATCH", `/documents/${d.id}`, { expectedVersion: d.version, changes: [{ operation: "replace", target: { quote: { exact: from, prefix: "MARKER " } }, replacement: to }] });
  d.version = r.version; d.flip = !d.flip;
}));

const f = (x: number) => x.toFixed(x < 10 ? 1 : 0);
console.log("| scenario | requests | req/s | p50 ms | p95 ms | p99 ms | errors |\n|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.n} | ${f(r.rps)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${r.errors} |`);
const edit = rows[3]!; const words = rows[1]!; const exact = rows[2]!;
const verdict = (r: Row, target: number) => `${r.p95 < target ? "met" : "MISSED"} (${f(r.p95)} ms)`;
console.log(`\nINFRA.md targets: edit p95 < 500 ms -> ${verdict(edit, 500)}; words search p95 < 300 ms -> ${verdict(words, 300)}; exact search p95 < 300 ms -> ${verdict(exact, 300)}`);
if (POSTGRES) for (const d of docs) await api("DELETE", `/documents/${d.id}`, undefined, 204).catch(() => {}); // leave the database as found
stop();
process.exit(rows.some((r) => r.errors > 0) ? 1 : 0);
