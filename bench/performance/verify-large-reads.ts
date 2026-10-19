import { readFile, writeFile } from "node:fs/promises";
import { sha256 } from "../../packages/core/src/index.ts";
import { DocumentOut } from "../../apps/api/src/schemas.ts";

const [inventory, output = "/tmp/clause-large-reads.json", repetitionsArg = "5"] = process.argv.slice(2);
if (!inventory) throw new Error("Supply a disposable fixture inventory from prepare.ts");
const repetitions = Number(repetitionsArg);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("Repetitions must be between 1 and 20");
const fixture = JSON.parse(await readFile(inventory, "utf8"));
const headers = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
  ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
  : {};
const results = [];

for (const item of fixture.documents) {
  const metadataResponse = await fetch(`${fixture.base}/documents/${encodeURIComponent(item.id)}`, { headers });
  if (!metadataResponse.ok) throw new Error(`Metadata read failed: ${metadataResponse.status}`);
  const doc = DocumentOut.parse(await metadataResponse.json());
  if (!doc.title.startsWith("CLAUSE loadfixture ") || !doc.contentUrl) throw new Error("Expected an immutable download reference for a disposable fixture");
  const samples = [];
  for (let index = 0; index < repetitions; index++) {
    const started = performance.now();
    const response = await fetch(doc.contentUrl);
    if (!response.ok) throw new Error(`Content read failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const elapsedMs = performance.now() - started;
    if (bytes.byteLength !== doc.byteLength || sha256(bytes.toString("utf8")) !== doc.contentHash) throw new Error("Downloaded content failed byte-length or hash verification");
    samples.push({ elapsedMs, bytes: bytes.byteLength });
  }
  const sorted = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  results.push({
    byteLength: doc.byteLength,
    repetitions,
    verifiedBytes: samples.reduce((total, sample) => total + sample.bytes, 0),
    p50Ms: percentile(0.5),
    p90Ms: percentile(0.9),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    samplesMs: samples.map((sample) => sample.elapsedMs),
    allHashesVerified: true,
  });
}

const report = { generatedAt: new Date().toISOString(), node: process.version, base: fixture.base, results };
await writeFile(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));
