/**
 * A small load check: starts a throwaway API (SQLite, temp file) and measures edit and search latency at a fixed
 * concurrency on ~1 MB documents, the size INFRA.md plans around. Run by hand: `pnpm load [workers] [seconds]`.
 * It measures ONE instance on THIS machine, so it checks the order of magnitude of the targets in INFRA.md, not a
 * production capacity.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORKERS = Number(process.argv[2] ?? 8);
const SECONDS = Number(process.argv[3] ?? 10);
const PORT = 3299;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "clause-load-"));
const server = spawn("node", [join(import.meta.dirname, "../apps/api/src/server.ts")], {
  env: { ...process.env, PORT: String(PORT), CLAUSE_DB: join(dir, "load.db"), CLAUSE_STORAGE: "sqlite", OPENROUTER_API_KEY: "", AI_GATEWAY_API_KEY: "" },
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
const body = (marker: string) => `${Array.from({ length: 6000 }, (_, i) => paragraph(i)).join("\n\n")}\n\nMARKER ${marker} END\n`;
const docs = await Promise.all(Array.from({ length: WORKERS }, async (_, w) => {
  const content = body(`A-${w}`);
  const d = await api<{ id: string; version: number }>("POST", "/documents", { title: `load ${w}`, content }, 201);
  return { id: d.id, version: d.version, flip: false, w, size: content.length };
}));
console.log(`${WORKERS} workers x ${SECONDS}s per scenario; ${docs.length} documents of ${(docs[0]!.size / 1e6).toFixed(2)} MB (${new Date().toISOString().slice(0, 10)}, node ${process.version})\n`);

type Row = { name: string; n: number; rps: number; p50: number; p95: number; p99: number; errors: number };
async function scenario(name: string, step: (w: number) => Promise<void>): Promise<Row> {
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

const rows: Row[] = [];
rows.push(await scenario("read one document (1 MB)", async (w) => { await api("GET", `/documents/${docs[w]!.id}`); }));
rows.push(await scenario("search: words, all documents", async () => { await api("GET", "/documents/search?q=confidential+information&mode=words&limit=10"); }));
rows.push(await scenario("search: exact phrase, all documents", async () => { await api("GET", `/documents/search?q=${encodeURIComponent("shall not disclose")}&mode=exact&limit=10`); }));
rows.push(await scenario("edit: one replacement in 1 MB (own document)", async (w) => {
  const d = docs[w]!;
  const [from, to] = d.flip ? [`B-${w}`, `A-${w}`] : [`A-${w}`, `B-${w}`];
  const r = await api<{ version: number }>("PATCH", `/documents/${d.id}`, { expectedVersion: d.version, changes: [{ operation: "replace", target: { quote: { exact: from, prefix: "MARKER " } }, replacement: to }] });
  d.version = r.version; d.flip = !d.flip;
}));

const f = (x: number) => x.toFixed(x < 10 ? 1 : 0);
console.log("| scenario | requests | req/s | p50 ms | p95 ms | p99 ms | errors |\n|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.name} | ${r.n} | ${f(r.rps)} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${r.errors} |`);
const edit = rows[3]!; const search = rows[1]!;
console.log(`\nINFRA.md targets: edit p95 < 500 ms -> ${edit.p95 < 500 ? "met" : "MISSED"} (${f(edit.p95)} ms); search p95 < 300 ms -> ${search.p95 < 300 ? "met" : "MISSED"} (${f(search.p95)} ms)`);
stop();
process.exit(rows.some((r) => r.errors > 0) ? 1 : 0);
