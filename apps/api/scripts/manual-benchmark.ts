import { fileURLToPath } from "node:url";

// A one-off preview build may opt into load generation near the hosted API.
if(process.env.CLAUSE_BENCH_BASE) {
  process.chdir(fileURLToPath(new URL("../../../",import.meta.url)));
  await import("../../../bench/performance/cloud-run.ts");
}
