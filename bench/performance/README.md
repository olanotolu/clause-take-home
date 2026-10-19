# Search snapshot regression check

## Original measurement, retained

The previous README recorded a deterministic 10 MiB synthetic contract on local SQLite, Apple M4 / 32 GiB, Node 26.7, with load average around 8. Rare-word search took 16 ms, common-phrase search 20 ms, exact unique/common search 14/51 ms. A single full-stack edit took 713 ms, a 100-edit batch 900 ms, and preview 155 ms. These historical numbers remain historical; they are not a controlled comparison with Node 24.

## Paired rerun, October 16, 2026

The unchanged `bench/run.ts` generated the same 10,485,779-byte / 10,306,991-character contract, with five repeats per search. Both runs used local SQLite 3.53.0, Node 24.15.0, Apple M4 / 32 GiB, and the same machine session. The baseline was API commit `6cdb601`; the next run included snapshot reads. Each run used its own temporary database. Raw logs retain environment and every operation.

| Operation | Before | Snapshot reads | Change |
|---|---:|---:|---:|
| Words, rare token | 19.8 ms | 20.6 ms | +0.8 ms |
| Words, common phrase | 23.8 ms | 24.5 ms | +0.7 ms |
| Exact, unique | 15.8 ms | 15.8 ms | 0 |
| Exact, many hits | 51.8 ms | 52.2 ms | +0.4 ms |
| Full-stack single edit | 818.8 ms | 788.8 ms | -30.0 ms |
| Full-stack 100 edits | 852.5 ms | 772.6 ms | -79.9 ms |
| Preview | 122.4 ms | 122.6 ms | +0.2 ms |

[Before raw output](before-snapshot-node24.txt) · [After raw output](after-snapshot-node24.txt)

Search snapshot reads add about 1 ms in this run. The common-word path stays bounded; the previous multi-second native-snippet failure did not return. This is one paired run under background load, not a statistical performance guarantee. Unrelated edit timing varies and does not establish an improvement. No thresholds were tuned from these measurements. That historical hosted Postgres implementation had a 500,000-character cap; the current document ceiling is 25 MiB.

## Concurrency, SQLite and Postgres (October 17, 2026)

`pnpm load [workers] [seconds]` starts a throwaway server and drives read, search and edit scenarios at fixed concurrency. Two options matter for honest numbers:

- `--warmup=N` (default 3) runs each scenario for N seconds first and discards it. A freshly loaded Postgres database was far slower for its first seconds (words search p95 4,393 ms cold against 129–158 ms warmed); SQLite showed no difference. `--warmup=0` turns it off to see the effect.
- `--storage=postgres` uses documents sized to the hosted 500,000-character cap and needs `CLAUSE_LOAD_DATABASE_URL`, a disposable database (the documents it creates are deleted at the end).

Warmed, 8 clients, Node 24.15, over HTTP, on an Apple M4 that was busy with other work (load average 15–45), two runs each. These figures predate the 25 MiB chunk-index migration and are not a current capacity claim:

| p95 | SQLite, 1 MB docs | Postgres, 0.47 MB docs |
|---|---|---|
| read | 27–49 ms | 19–21 ms |
| words search | 522–543 ms | 129–158 ms |
| exact search | 1,096–1,159 ms | 240–246 ms |
| edit | 1,944–2,387 ms | 437–443 ms (27 edits/s) |

The SQLite figures are about twice the ones in `INFRA.md`, which were taken on a quiet machine; the load average, not the code, explains the gap, and that is why the tables in `INFRA.md` and the README call laptop numbers ranges. The old Postgres figures met the then-current targets, with little headroom on edits. Current hosted measurements are recorded separately below.

## Current hosted preview benchmark

Use Node 24 and k6 2.3.0. Create fictional documents in an isolated preview database; the scenarios perform real committed edits. Never use a production workspace. `prepare.ts` writes its fixture inventory after every document so interrupted preparation can be cleaned up.

```sh
CLAUSE_FIXTURE_BYTES=1048576 CLAUSE_FIXTURE_COUNT=32 \
node bench/performance/prepare.ts prepare https://PREVIEW/api /tmp/clause-fixtures.json
CLAUSE_FIXTURE_FILE=/tmp/clause-fixtures.json CLAUSE_ALLOW_WRITES=1 \
CLAUSE_VUS=8 CLAUSE_DURATION=30s CLAUSE_SCENARIO=mixed \
CLAUSE_RESULT_FILE=/tmp/clause-result.json k6 run bench/performance/k6.js
node bench/performance/prepare.ts cleanup https://PREVIEW/api /tmp/clause-fixtures.json
```

Repeat `metadata`, `search`, `edit` (separate documents), `contention` (one document), and `mixed` at 1, 8, and 32 clients. Set `VERCEL_AUTOMATION_BYPASS_SECRET` when preview protection is enabled. Repeat preparation with 10 and 25 MiB fixtures to publish their performance separately. Changes toggle equal-length markers, preserving the exact byte ceiling. Same-document conflicts are counted separately from errors.

Save JSON summaries, UTC date, deployment URL, Node/k6 versions, fixture size, regions, warmup policy and load-generator location. Current summaries include p50/p90/p95/p99, failures, response bytes, attempted and successful writes, and expected CAS conflicts. Each write scenario is capped at 100 patch attempts. Warm eight-client runs at 1 MiB enforce metadata/search/edit p95 targets of 100/300/500 ms. Other matrix points report measurements without asserting these targets. Public network latency is included. A first request is only called cold when a new function instance is observed; otherwise label it initial-request timing.

For a controlled local comparison, use the pre-change revision and updated build on Node 24 against separate databases on the same disposable PostgreSQL 16 instance. Prepare matching 32-document, 400,000-byte fixtures on each API, then run `node bench/performance/run-paired-local.ts /tmp/before-fixtures.json /tmp/after-fixtures.json bench/performance/results/paired-local`. The script alternates revisions per scenario, warms each endpoint for five seconds, runs the same eight-client metadata, word-search, and edit scenarios, limits each edit run to 100 attempts, records p50/p90/p95/p99 and failures, and rejects non-local fixture targets. The pre-change commit had no hosted percentile samples; the October 18 intermediate hosted matrix recorded p99 but not p90.

Use the protected `/internal/diagnostics` endpoint for per-instance SQL counts, memory and event-loop measurements. Counters from one serverless instance are not fleet totals. Export OTLP to a collector for aggregate server-side measurements. Compare browser responsiveness using web-vitals and the desktop/mobile browser journeys. These measurements must accompany hosted HTTP numbers before making a capacity claim.

The historical measurements above predate this implementation. They are retained as historical records, not current limits or a controlled before/after comparison. The October 18 diagnostic hosted run did record p99 but not p90; the pre-change commit has no hosted percentile samples.

## October 18 implementation evidence

[Measured results and rollout status](results/2026-10-18/REPORT.md) contain the hosted matrix, 1/10/25 MiB flow checks, browser responsiveness observations, query plan, local Workflow proof, and collector delivery check. Failed latency gates remain visible.

`run-hosted.ts` runs the complete 1/8/32 client matrix and stores every exit status, summary and environment snapshot. `run-paired-local.ts` compares the pre-change commit with an updated local build using matched disposable Postgres fixtures. `verify-large.ts` validates immutable hashes, edits, preview, exact search, revert and Word export using a fixture inventory. `query-plan.ts` captures a sanitized `EXPLAIN ANALYZE` tree against a disposable schema. Use Node 24 for every tool. Fixtures must be cleaned up after the runs.

[October 19 follow-up](results/2026-10-19/REPORT.md) records the query-plan change, p90 support, bounded-write benchmark, matched local percentiles, pool-outage recovery, authenticated local OTLP delivery, and external hosted blockers.

### Optional nearby cloud generator

A manual preview build can set `CLAUSE_BENCH_BASE` to a separate, disposable `https://PREVIEW.vercel.app/api`, plus `CLAUSE_BENCH_BYPASS`, `CLAUSE_BENCH_OPERATIONS_TOKEN`, and the verified `CLAUSE_BENCH_GENERATOR_REGION`. These are build environment variables, never browser variables. Normal builds and CI do not run load generation.

The API build's opt-in helper downloads k6 2.3.0 with a pinned SHA-256, prepares 32 fictional 1 MiB fixtures, runs the matrix, and transfers compressed JSON results into one temporary report document. Its identifier is printed as `CLAUSE_CLOUD_REPORT`. Read that document through the target API, decode its `gzip-base64` content, save the results, then delete that report document. The helper cleans its fixture inventory even when artifact transfer fails. If the target database is unavailable, restore it before retrying; a build failure is not benchmark evidence. The October 18 cloud attempt was blocked by Neon quota exhaustion before creating any fixtures.

Preview build success does not certify performance: inspect the report's `exitCode`, individual scenario gates, and errors. The helper deliberately preserves a completed report even when latency thresholds fail. Only use an isolated schema, and verify provider quotas before a sustained write run; immutable revision history consumes storage.
