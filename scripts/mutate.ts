/**
 * Bounded, first-order mutation run over the edit engine (packages/core/src).
 * Flips ONE operator at a time, reruns the core tests, and reports mutants the
 * tests failed to kill. This is NOT StrykerJS (see NOTES.md for why): small
 * operator set, no equivalent-mutant detection, so a survivor needs a human to
 * decide "missing test" vs "equivalent mutant".
 *
 * Safety: mutants are written ONLY into throwaway copies under .mutation-tmp/,
 * never into packages/core, so an interrupted run cannot leave the repo mutated.
 *
 *   node scripts/mutate.ts              # all engine files
 *   node scripts/mutate.ts apply.ts     # one file
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CORE = join(ROOT, "packages/core");
const TMP = join(ROOT, ".mutation-tmp"); // inside the repo so node_modules resolves
const VITEST = join(ROOT, "node_modules/vitest/vitest.mjs");
const WORKERS = 6;
const files = process.argv[2] ? [process.argv[2]] : ["resolve.ts", "apply.ts", "anchor.ts"];

const OPERATORS: [RegExp, string, string][] = [
  [/ <= /g, " <= ", " < "], [/ >= /g, " >= ", " > "], [/ < /g, " < ", " <= "], [/ > /g, " > ", " >= "],
  [/ === /g, " === ", " !== "], [/ !== /g, " !== ", " === "],
  [/ && /g, " && ", " || "], [/ \|\| /g, " || ", " && "],
  [/ \+ /g, " + ", " - "], [/ - /g, " - ", " + "], [/\+\+/g, "++", "--"],
  [/\btrue\b/g, "true", "false"], [/\bfalse\b/g, "false", "true"],
];

interface Mutant { file: string; line: number; from: string; to: string; code: string; text: string }

function generate(file: string): Mutant[] {
  const lines = readFileSync(join(CORE, "src", file), "utf8").split("\n");
  const out: Mutant[] = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.includes("`") || /^\s*(import|export type|export interface)/.test(line)) return;
    const code = line.replace(/\/\/.*$/, "");
    if (/["']/.test(code)) return; // never mutate inside string literals
    for (const [re, from, to] of OPERATORS) {
      for (const m of code.matchAll(re)) {
        const mutated = line.slice(0, m.index) + to + line.slice(m.index! + from.length);
        out.push({ file, line: i + 1, from: from.trim(), to: to.trim(), code: t, text: [...lines.slice(0, i), mutated, ...lines.slice(i + 1)].join("\n") });
      }
    }
  });
  return out;
}

/** A mutant can create an infinite synchronous loop (e.g. a scan that walks backwards). Kill it and count it as detected. */
const TIMEOUT_MS = 20_000;

function runTests(dir: string): Promise<{ status: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn("node", [VITEST, "run", "--config", join(dir, "vitest.config.ts"), "--root", dir], { cwd: ROOT, detached: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, TIMEOUT_MS);
    p.stdout.on("data", (d) => (output += d));
    p.stderr.on("data", (d) => (output += d));
    p.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output, timedOut });
    });
  });
}

function makeWorkerDir(n: number): string {
  const dir = join(TMP, `w${n}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  cpSync(join(CORE, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(CORE, "test"), join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "vitest.config.ts"), `import { defineConfig } from "vitest/config";\nexport default defineConfig({ test: { include: ["test/**/*.test.ts"] } });\n`);
  return dir;
}

const dirs = Array.from({ length: WORKERS }, (_, n) => makeWorkerDir(n));
const baseline = await runTests(dirs[0]!);
if (baseline.status !== 0) throw new Error(`baseline tests must pass first:\n${baseline.output}`);

const all = files.flatMap(generate);
console.log(`${all.length} mutants across ${files.join(", ")} (${WORKERS} workers)`);
const survived: Mutant[] = [];
let killed = 0, timeouts = 0, invalid = 0, next = 0, done = 0;

await Promise.all(
  dirs.map(async (dir) => {
    while (next < all.length) {
      const m = all[next++]!;
      const target = join(dir, "src", m.file);
      const original = readFileSync(join(CORE, "src", m.file), "utf8");
      writeFileSync(target, m.text);
      const r = await runTests(dir);
      writeFileSync(target, original);
      if (r.timedOut) { timeouts++; killed++; }
      else if (r.status === 0) survived.push(m);
      else if (/SyntaxError|Transform failed|Unexpected token/.test(r.output)) invalid++;
      else killed++;
      if (++done % 25 === 0) console.log(`  ${done}/${all.length}`);
    }
  }),
);

rmSync(TMP, { recursive: true, force: true });
const valid = all.length - invalid;
survived.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
console.log(`\nmutants: ${all.length}  killed: ${killed} (of which ${timeouts} by timeout/infinite loop)  survived: ${survived.length}  invalid(syntax): ${invalid}`);
console.log(`score (killed / valid): ${((killed / valid) * 100).toFixed(1)}%`);
for (const m of survived) console.log(`SURVIVED ${m.file}:${m.line}  ${m.from} -> ${m.to}   | ${m.code}`);
writeFileSync(join(ROOT, "mutation-report.json"), JSON.stringify({ total: all.length, killed, invalid, survived: survived.map(({ text: _t, ...m }) => m) }, null, 2));
