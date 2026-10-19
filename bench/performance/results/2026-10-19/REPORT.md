# Performance and operations follow-up — October 19, 2026

## Changes in this follow-up

- Removed the per-candidate primary-key lookup from Postgres word search. Search vectors now flow from the original GIN match into scoring; full chunk text is still fetched only for snippets on the selected page.
- Added p90 to k6 percentile summaries and a maximum of 100 attempted writes per write scenario. Attempted writes, committed writes and CAS conflicts are reported separately.
- Added OpenTelemetry OTLP authentication header support through `OTEL_EXPORTER_OTLP_HEADERS` and documented the Preview configuration.
- Added a Postgres pool error listener. A dropped idle database connection now increments a fixed-name error metric instead of becoming an uncaught process error.

## Matched local comparison

The pre-change commit (`15da2be`) and current code ran on Node 24.15.0, PostgreSQL 16.14, the same Mac arm64 host, separate disposable databases on the same local Postgres cluster, and matching fictional fixtures (32 documents, 400,000 UTF-8 bytes each). Each scenario used eight clients and a five-second per-revision warmup. Read and search ran for 15 seconds. Each measured edit scenario attempted and committed 100 writes, with zero request failures. The runner and raw summaries are in [paired-local-controlled](paired-local-controlled/); the fixture inventories were deleted after the run.

The machine was heavily loaded throughout: one-minute load average rose from 302 to 395. Treat this run as diagnostic evidence, not a capacity claim or an SLO pass. Values are p50 / p90 / p95 / p99 in milliseconds.

| Scenario | Pre-change | Updated | Observation |
|---|---:|---:|---|
| Metadata read, 400 KB | 3.7 / 11.2 / 21.0 / 107.1 | 2.5 / 18.7 / 32.7 / 72.3 | Median and p99 improved; p90 and p95 regressed in this noisy run. |
| Word search, 400 KB | 731.3 / 1,235.0 / 1,625.5 / 2,117.9 | 35.7 / 82.7 / 102.8 / 173.2 | Large reduction across all reported percentiles. |
| Edit, 400 KB | 226.2 / 342.6 / 408.7 / 474.9 | 116.0 / 210.4 / 246.0 / 291.3 | Improvement across all reported percentiles; 100/100 commits on both. |

The query plan on the updated fictional corpus completed in 31.8 ms. Its GIN index scan returned 1,732 candidate chunks, deduplication produced 1,632 scoring rows, and the snippet path performed the remaining primary-key lookups for the selected results. See [updated query plan](word-search-plan-local.json). The older 96 ms plan was captured with a different 1 MiB hosted corpus, so it is not a controlled plan-to-plan comparison.

The previous pre-change revision had no hosted percentile sample. The October 18 intermediate hosted run did record p99 but not p90. Its eight-client p95 values (metadata 121 ms, search 348 ms, separate-document edit 268 ms) were measured before this query rewrite and are retained as prior evidence, not after-change results. The new hosted 1/8/32-client matrix was initially blocked because the Vercel-configured Neon project rejected connections with SQLSTATE `53000` (account/project quota exceeded). The October 19 infrastructure follow-up below restored Preview readiness by switching Preview to a new Neon project; it did not restore or modify the previous project.

## Operations verification

- Local outage/recovery check: `/health` returned 200 throughout; `/ready` returned 200 with Postgres available, 503 in 9.5 ms while it was stopped, and 200 after restart. The API process remained alive. The added pool-error regression test also verifies the dropped-connection metric path.
- Authenticated OTLP delivery to a local collector endpoint succeeded with a 5,669-byte metrics payload. A real app request was included; the contract body, title and document ID were absent from the captured payload. The test credential was not printed or saved.
- Hosted OTLP remains unverified: no OTLP endpoint or header secret is present in local configuration or Vercel Preview. No collector secret was invented or committed.
- Vercel CLI access can reach the protected Preview for point checks and load runs. The Preview automation bypass was read in memory and never printed. An operations token is configured for Preview and saved in ignored `.env.local` for authenticated diagnostics.
- Hosted OTLP delivery remains blocked because Preview has no collector endpoint or authenticated headers configured. Local OTLP delivery is verified above.

## Hosted Preview matrix and large reads

The run used Node 24.15.0 on a local Mac arm64 generator, k6 2.3.0, the fresh Preview deployment above, 32 fictional 1 MiB documents, and a 100-write maximum per write scenario. Each scenario was run at 1, 8, and 32 clients. Metadata and search ran for 15 seconds; write scenarios stopped after 100 attempts. All HTTP failure and 5xx counters were zero. Fixture cleanup deleted all 32 documents after the matrix. At 8 clients, k6 returned threshold-failure exit codes for metadata, edit, contention, and mixed scenarios; the failures were latency thresholds, not request errors. Values below are p50 / p90 / p95 / p99 milliseconds.

| Clients | Scenario | Metadata | Search | Edit | Attempts / commits / CAS conflicts |
|---:|---|---:|---:|---:|---:|
| 1 | Metadata | 71.3 / 133.1 / 136.8 / 157.7 | — | — | — |
| 1 | Search | — | 84.0 / 143.9 / 154.2 / 187.9 | — | — |
| 1 | Separate-document edit | 60.1 / 129.5 / 132.9 / 175.8 | — | 313.2 / 473.1 / 502.5 / 526.1 | 100 / 100 / 0 |
| 1 | Same-document contention | 55.5 / 109.2 / 131.5 / 146.7 | — | 374.0 / 473.9 / 479.5 / 551.8 | 100 / 100 / 0 |
| 1 | Mixed | 55.0 / 132.7 / 151.8 / 200.7 | 79.7 / 131.6 / 145.5 / 171.4 | 359.8 / 455.5 / 516.4 / 542.7 | 100 / 100 / 0 |
| 8 | Metadata | 86.2 / 139.3 / 156.6 / 241.3 | — | — | — |
| 8 | Search | — | 190.7 / 235.5 / 254.2 / 270.9 | — | — |
| 8 | Separate-document edit | 68.0 / 131.2 / 160.3 / 222.4 | — | 357.3 / 503.8 / 598.1 / 718.1 | 100 / 100 / 0 |
| 8 | Same-document contention | 64.8 / 126.6 / 134.3 / 145.8 | — | 343.0 / 416.7 / 439.3 / 499.5 | 100 / 13 / 87 |
| 8 | Mixed | 59.7 / 134.1 / 168.8 / 237.2 | 121.8 / 205.4 / 244.1 / 265.9 | 354.7 / 515.2 / 543.4 / 633.9 | 100 / 100 / 0 |
| 32 | Metadata | 56.8 / 127.0 / 147.3 / 2693.0 | — | — | — |
| 32 | Search | — | 270.3 / 505.2 / 669.9 / 907.5 | — | — |
| 32 | Separate-document edit | 59.5 / 133.2 / 146.7 / 188.5 | — | 465.6 / 688.8 / 772.6 / 787.1 | 100 / 100 / 0 |
| 32 | Same-document contention | 62.8 / 124.4 / 157.7 / 204.4 | — | 395.9 / 577.7 / 626.2 / 656.6 | 100 / 4 / 96 |
| 32 | Mixed | 67.9 / 146.7 / 168.9 / 225.9 | 140.0 / 197.2 / 229.6 / 279.8 | 406.8 / 563.3 / 580.3 / 781.0 | 100 / 100 / 0 |

The laptop matrix above was heavily contaminated by local load: its one-minute load average rose from 601 to 704. Do not use those percentiles for tuning or gate decisions. The [raw laptop run](hosted-neon-recovery/) remains saved to show why a nearby generator was needed.

### Earlier nearby Vercel build matrix (superseded)

The corrected generator ran in the Vercel build machine in Washington, D.C. (`iad1`), using Node 24.21.0 and k6 2.3.0. It hit the fresh Preview API in the same Vercel region. The Neon primary remains in AWS `us-east-2`. Thirty-two fictional 1 MiB fixtures were created and deleted. Each write scenario attempted at most 100 writes. All HTTP failures and 5xx counts were zero. Values are p50 / p90 / p95 / p99 milliseconds.

| Clients | Scenario | p50 / p90 / p95 / p99 |
|---:|---|---:|
| 1 | Metadata | 24.7 / 38.2 / 43.4 / 77.9 |
| 1 | Search | 49.4 / 68.2 / 80.3 / 131.5 |
| 1 | Separate-document edit | 253.5 / 308.1 / 338.0 / 377.7 |
| 8 | Metadata | 25.5 / 39.1 / 48.8 / 118.3 |
| 8 | Search | 117.4 / 167.1 / 193.1 / 291.3 |
| 8 | Separate-document edit | 299.9 / 465.2 / 539.2 / 667.8 |
| 32 | Metadata | 25.5 / 40.7 / 53.6 / 222.6 |
| 32 | Search | 359.1 / 1,280.3 / 1,468.6 / 1,683.8 |
| 32 | Separate-document edit | 527.1 / 780.5 / 923.6 / 1,007.4 |

At the 8-client gate, metadata and search pass; separate-document edit misses the 500 ms p95 target by 39.2 ms. Its server-timing p95 is 524.2 ms, so most of the overage is inside the API path. At 32 clients, p95 search is 1,468.6 ms and p95 edits are 923.6 ms. Same-document contention at 8 clients committed 13 of 100 attempts and reported 87 CAS conflicts; at 32 clients it committed 4 and reported 96 conflicts. Those conflict responses were expected and are not HTTP failures. Mixed traffic at 8 clients stayed within the three p95 gates (metadata 74.7 ms, search 161.6 ms, edit 447.2 ms).

The dedicated large reads also ran from the Vercel `iad1` build machine. Five signed downloads each matched the expected byte length and SHA-256. p50 / p90 / p95 / p99 are 70.4 / 201.4 / 201.4 / 201.4 ms for 10 MiB and 156.9 / 485.5 / 485.5 / 485.5 ms for 25 MiB. With five samples, p90, p95, and p99 all select the maximum. Both fixtures were deleted. Raw cloud results are in [cloud-matrix.json](hosted-neon-recovery/cloud-matrix.json) and [cloud-large-reads.json](hosted-neon-recovery/cloud-large-reads.json); the separate local large-read samples are retained as well.

The old hosted p90/p99 values remain unavailable; no historical values were inferred. The latest Preview deployment is [clause-take-home-ck62guqvn](https://clause-take-home-ck62guqvn-subomis-projects-22c86536.vercel.app). Its first authenticated diagnostics request returned a unique instance ID, `iad1`, and 9.7 seconds of uptime; a second probe hit the same instance. `/health` and `/ready` both returned 200. The operations token is saved in ignored `.env.local` and as a Preview secret. The cloud matrix targeted the preceding deployment, whose operations endpoint returned 503, so it has no per-instance database counters. Hosted OTLP remains unverified because Preview has no collector endpoint or authenticated headers configured. Neon is available again for Preview, but the Vercel Function region and Neon primary region still differ. Changing the shared Vercel region configuration would also affect future Production deployments, so it was left unchanged. No Production deployment, data pruning, or billing-tier change was made.

### Final nearby Vercel build matrix

After tracing edit latency to duplicate document reads and an unnecessary chunk metadata query, the edit path now reuses the body read during conditional validation and derives previous chunk identities from that verified body. The final generator ran from Vercel `iad1` on Node 24.21.0 with k6 2.3.0 against Preview. It used 32 fictional 1 MiB documents; each write scenario was capped at 100 attempts. Every scenario completed with zero request failures and zero 5xx responses. Fixtures and the temporary benchmark report document were deleted after collection. Values are p50 / p90 / p95 / p99 milliseconds.

| Clients | Scenario | p50 / p90 / p95 / p99 |
|---:|---|---:|
| 1 | Metadata | 25.8 / 39.5 / 45.6 / 90.5 |
| 1 | Search | 47.5 / 63.0 / 67.3 / 87.6 |
| 1 | Separate-document edit | 216.5 / 335.9 / 368.8 / 418.2 |
| 8 | Metadata | 25.5 / 40.2 / 51.7 / 142.9 |
| 8 | Search | 117.8 / 151.7 / 164.8 / 226.6 |
| 8 | Separate-document edit | 263.3 / 415.1 / 470.7 / 531.3 |
| 32 | Metadata | 26.0 / 43.0 / 65.4 / 2,171.5 |
| 32 | Search | 265.4 / 723.8 / 899.1 / 1,385.8 |
| 32 | Separate-document edit | 402.2 / 578.2 / 621.9 / 658.3 |

All existing eight-client p95 gates pass: metadata 51.7 ms (<100), search 164.8 ms (<300), and separate-document edits 470.7 ms (<500). Compared with the initial nearby run, search p95 improved from 193.1 to 164.8 ms and edit p95 from 539.2 to 470.7 ms (12.7%); metadata p95 moved from 48.8 to 51.7 ms. The earlier laptop run is excluded from these comparisons because its host was overloaded. Same-document contention committed 13/100 writes at eight clients and 4/100 at 32; remaining responses were expected CAS conflicts. Mixed traffic at eight clients measured p95 71.3 ms metadata, 148.1 ms search, and 418.7 ms edits. At 32 clients, p95s were 65.4 ms metadata, 899.1 ms search, and 621.9 ms edits; this is stress evidence, with no additional pass/fail thresholds defined.

The dedicated 10 MiB and 25 MiB signed-download checks remain the five-sample results above; each returned the expected byte length and SHA-256. Raw final matrix output is [cloud-matrix-after-chunk-diff.json](hosted-neon-recovery/cloud-matrix-after-chunk-diff.json). The run’s diagnostics sampled two different function instances, so query and pool counters are explicitly per-instance and cannot be interpreted as before/after or fleet totals. A separate authenticated probe verified a genuinely new instance by its unique instance ID and low uptime; `/health` and `/ready` both returned 200.

Hosted OTLP delivery is still unverified because the Preview environment has no collector endpoint or authenticated headers configured. The code supports `OTEL_EXPORTER_OTLP_HEADERS`, and local authenticated delivery was verified earlier. Preview Functions run in `iad1` while the Neon primary is in `us-east-2`; this cross-region placement remains a likely contributor under 32-client load. The Preview-only database switch is in place; Production configuration, billing tier, and the old Neon project were not changed. Temporary `CLAUSE_BENCH_*` variables have been removed; the Preview operations token remains configured for diagnostics.


The API now deploys to `cle1` in Preview, matching Neon `us-east-2`; Production and local builds remain `iad1`. The clean Preview deployment is [clause-take-home-gj87u9fay](https://clause-take-home-gj87u9fay-subomis-projects-22c86536.vercel.app). `/api/health` and `/api/ready` returned 200. Authenticated diagnostics on a newly started `cle1` instance showed 22 queries, zero query errors, and 44 ms aggregate query time across the health/readiness checks. This region correction happened after the final matrix above; the reported 8-client latency gate is from the immediately preceding `iad1` Preview, and a post-move 1/8/32 matrix has not been collected. Vercel Preview currently contains only `CLAUSE_OPERATIONS_TOKEN` among the `CLAUSE_*` operational variables.

## Verification

- Typecheck and lint passed; `git diff --check` is clean.
- SQLite coverage: 441 passed, 9 skipped. Postgres coverage: 449 passed, 2 skipped. The focused Postgres search suite passed 36 tests; the added liveness/readiness regression passed.
- API and web production builds passed. Nitro emitted nonfatal dependency-tracing and timing-group warnings; the Workflow bundle and three export-worker targets were generated.
- All 18 desktop/mobile browser journeys passed. The local Workflow export smoke passed.

## October 19 Preview database recovery

The user selected a Preview-only switch to Neon project `shiny-credit-77809818`, branch `production`. The new project is in `aws-us-east-2`, on Neon free_v3, and its Postgres 18 branch initially had no CLAUSE tables. A direct connection succeeded; application migrations completed. Vercel Preview `DATABASE_URL` and `POSTGRES_URL` were updated as secrets, and a fresh Preview deployment completed at `https://clause-take-home-c6z6nu23x-subomis-projects-22c86536.vercel.app`. Authenticated point checks returned `/api/health` 200 and `/api/ready` `{"status":"ready"}`. Production environment variables and the old Neon project were not changed. Vercel Functions remain pinned to `iad1` while this new Neon project is in `us-east-2`; record that region mismatch when interpreting hosted latency.

This restores Preview database readiness; it does not yet provide hosted performance evidence. The 1/8/32-client matrix, 10/25 MiB read percentiles, authenticated OTLP delivery, and cold-instance verification remain open.
