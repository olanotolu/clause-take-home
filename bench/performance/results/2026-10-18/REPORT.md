# CLAUSE implementation and performance evidence

Measurements recorded October 18, 2026, with an October 19 follow-up (America/New_York); raw artifacts use UTC. This report covers the current implementation, with the shared demo and authentication behavior preserved. No production rollout was performed.

## Rollout status

**Not ready for production promotion.** Correctness checks and large-document preview flows passed. The recorded eight-client benchmark misses the metadata and standalone search latency targets. A second run with a nearby cloud generator was blocked before fixture creation by Neon quota exhaustion. Hosted OTLP collection and a proven cold-instance matrix remain unverified.

The latest successfully built review preview is [mz3wt7ftu](https://clause-take-home-mz3wt7ftu-subomis-projects-22c86536.vercel.app). At the October 19 follow-up its database remains unavailable: `/api/health` returns 200 and `/api/ready` returns 503. See [quota and readiness evidence](cloud-blocked.json). Neon returned SQLSTATE `53000`: account or project quota exceeded. No plan upgrade was attempted. This new failure does not establish the cause of errors in earlier load runs.

## Verification

- Node 24.15.0 locally; the Vercel build reported Node 24.21.0. Deployment is configured for Node 24.x.
- Typecheck and lint pass. API and web builds pass, including generated Workflow endpoints and the packaged export worker.
- SQLite suite: 440 passed, 7 skipped. Postgres suite: 445 passed, 2 skipped, using disposable local Postgres 16. API/core and Postgres coverage gates pass. Backend-specific skips are intentional. A later parallel rerun had one Postgres test timeout under heavy laptop load; the final suite was rerun sequentially. The combined SQLite report includes browser libraries whose full behavior is exercised separately; its overall coverage is not the API/core gate.
- Desktop/mobile browser journeys: 18 passed, including large replacements, selection/navigation, preview checks, direct uploads and accessibility.
- Built local Workflow runtime passes a real queued Word export with SQLite and filesystem storage. [Local proof](local-workflow.json).
- A real OpenTelemetry collector received metrics and the sensitive-label checks passed. [Collector proof](telemetry.json). No hosted collector endpoint was configured, so fleet delivery is unverified.
- [Machine-readable checks](checks.json) records the latest completed gates. These are local and preview checks, not a claim that GitHub CI ran on an unpushed patch.

## Large document flows

Private Vercel Blob flows passed at exactly 1, 10 and 25 MiB: create, verified download/hash, preview, edit, exact search, revert, older immutable receipt download after a newer write, full replacement through a scoped upload, and a real durable Workflow Word export. [1 MiB](large-1-mib.json), [10 MiB](large-10-mib.json), [25 MiB](large-25-mib.json).

These checks request metadata/minimal receipts. Their largest recorded API JSON response is 984 bytes; document and generated export bodies travel through Blob. Inline compatibility up to 1 MiB, Unicode byte boundaries, omitted large span payloads, mismatch diagnostics, CAS races and immutable downloads are also covered by the suites. This does not claim every possible inline endpoint response is 984 bytes.

At 25 MiB, this single sequential check measured approximately 2.40 s for an edit, 2.96 s for revert and 2.79 s for full replacement completion. It is a functional check over the public network, not a 25 MiB concurrency benchmark or percentile estimate. Word export completed asynchronously and its ZIP archive was verified.

## Hosted load matrix: diagnostic laptop run

API and Workflow region: `iad1`, verified in Vercel deployment configuration and build output. The Neon primary endpoint is AWS `us-east-1`; no inference is made about its compute tier. Fixtures are 32 fictional documents, each 1 MiB. The generator was a macOS arm64 laptop with Node 24.15.0 and k6 2.3.0. Each warm point runs for 15 s after an initial metadata phase and a 5 s mixed warmup. Separate-document edits commit real writes; contention targets one document and records CAS conflicts separately.

**Generator load rose from 11.8 to 125.3.** These numbers include public network latency and are diagnostic only. They cannot establish a controlled improvement, a capacity limit, or a stable production SLO. The following table preserves failures and all matrix points. Each timing cell is **p50 / p95 / p99, milliseconds**; bytes include the load tool's received-byte accounting. [Environment](hosted/environment.json) and [all raw summaries](hosted/) retain server timing and complete counters.

| Clients | Scenario | Metadata | Search | Edit | Errors | CAS conflicts | Committed writes | Received bytes |
|---|---|---|---|---|---|---|---|---|
| 1 | metadata | 43 / 122 / 139 | — | — | 0 | 0 | 0 | 79757 |
| 1 | search | — | 84 / 165 / 214 | — | 0 | 0 | 0 | 470382 |
| 1 | edit | 42 / 101 / 132 | — | 152 / 208 / 215 | 0 | 0 | 57 | 73620 |
| 1 | contention | 43 / 89 / 111 | — | 150 / 226 / 231 | 0 | 0 | 58 | 74771 |
| 1 | mixed | 42 / 113 / 133 | 82 / 147 / 191 | 145 / 231 / 257 | 0 | 0 | 37 | 246821 |
| 8 | metadata | 43 / 121 / 145 | — | — | 0 | 0 | 0 | 622045 |
| 8 | search | — | 264 / 348 / 465 | — | 0 | 0 | 0 | 1877829 |
| 8 | edit | 49 / 133 / 229 | — | 175 / 268 / 360 | 0 | 0 | 400 | 520714 |
| 8 | contention | 45 / 127 / 215 | — | 139 / 237 / 263 | 0 | 410 | 62 | 479440 |
| 8 | mixed | 45 / 126 / 172 | 199 / 299 / 354 | 200 / 302 / 389 | 0 | 0 | 210 | 1414318 |
| 32 | metadata | 48 / 134 / 1782 | — | — | 0 | 0 | 0 | 1951134 |
| 32 | search | — | 945 / 2227 / 2444 | — | 15 | 0 | 0 | 2139202 |
| 32 | edit | 52 / 173 / 262 | — | 485 / 681 / 783 | 0 | 0 | 786 | 1123454 |
| 32 | contention | 44 / 125 / 162 | — | 106 / 381 / 729 | 1104 | 796 | 33 | 1759122 |
| 32 | mixed | 55 / 1100 / 1339 | 685 / 2451 / 3527 | 272 / 1043 / 2185 | 327 | 0 | 129 | 1844361 |

At eight clients:

- Metadata p95 121 ms exceeds the 100 ms target.
- Standalone word-search p95 348 ms exceeds the 300 ms target. Mixed search p95 299 ms narrowly meets it in this run.
- Separate-document edit p95 268 ms meets the 500 ms edit target, but the scenario's preceding metadata reads exceed their own target, so the scenario still fails.
- No eight-client application errors were observed. Same-document CAS conflicts are expected and reported separately.

Seven of fifteen warm scenarios passed their configured gates. The 32-client errors prevent a capacity claim. Server-Timing helps separate application time from network time but is not a substitute for fleet telemetry. Per-instance diagnostics recorded RSS around 200–256 MB and SQL counters; instances can change between snapshots, so these are not fleet totals or a reliable delta. The recorded zero event-loop value means no configured hosted sampling, not zero event-loop delay.

The sanitized [word-search EXPLAIN ANALYZE](word-search-plan.json) was captured after the final SQL change with the fictional corpus present. It reports about 96 ms database execution. The query starts from indexed matches, deduplicates chunk identities and bounds snippet work. Exact-search occurrence ranking and title tie ordering are unchanged. A single query plan is not a concurrency result.

## Browser observations

The >1 MiB replacement journey transferred at most 425 bytes in any API JSON request; large bodies used the direct upload route. Desktop observed 6 long tasks, max 266 ms, and max Event Timing 304 ms. Mobile viewport observed 2 long tasks, max 217 ms, and max Event Timing 224 ms. [Desktop](browser-desktop.json), [mobile](browser-mobile.json).

These are diagnostic observations from a desktop browser running desktop/mobile viewport projects, not p75 INP or measurements on physical low-end phones. Long tasks remain visible; no field responsiveness SLO is claimed.

## Remaining gates and recovery

1. Restore Neon availability through its account/project quota controls, then rerun the complete nearby cloud matrix. The opt-in cloud generator never ran a valid matrix; no failed cloud attempt is represented as passing evidence.
2. Meet the eight-client metadata/search/edit targets with a stable generator and investigate 32-client errors using bounded SQLSTATE logs and OTLP measurements. Do not hide failures by changing the targets.
3. Configure the hosted OTLP endpoint and verify collector delivery, queue/lock/query/Blob/AI metrics and sensitive-label exclusion across instances.
4. Run an observed cold-instance matrix and constrained-device responsiveness checks. Repeat 10/25 MiB concurrent traffic separately before publishing large-document capacity.
5. Follow the additive migration, backfill, verification, recovery rehearsal and explicit pruning order in [INFRA](../../../../INFRA.md). Local migration/recovery tests passed; no production prune was performed.

The owned earlier hosted fixtures were deleted (35 documents). The final cloud attempt failed on its first create, so it created no new fixtures or report document. Local disposable services are stopped after verification. Generated successful export objects follow their 24-hour retention policy. Live paid AI comparisons remain manual and outside routine CI.
