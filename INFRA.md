# CLAUSE: production design

Where it stands: the deployed demo is open, shared, and fictional. Hosted runs on Vercel functions (`iad1`), Supabase Postgres (`us-east-1`) and private Vercel Blob; local runs on SQLite and the filesystem. Day-to-day operation (jobs, migrations, recovery, telemetry) is in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

Working assumptions (mine, not a brief): contracts around 1 MiB with a 25 MiB tail, hundreds of workspaces, up to 50 concurrent editors each, reads far above writes, 99.9% availability goal (unproven), US and EU customers.

Every number is tagged. **Measured** says where: a laptop (Apple M4, Node 24, local Postgres 16 or SQLite; numbers swing ~2× with background load) or **hosted** (Vercel `iad1` plus the database of the day, driven from a laptop over the public internet). **Target** is what production must hit. **Untested** means nobody has run it.

```text
Client → CDN/WAF (ETag 304, rate limit, OIDC) → Stateless API (Vercel, iad1) ──CAS──▶ Postgres (metadata, revisions, 8,000-char search chunks)
                                                   ├──▶ Blob (bodies > 1 MiB by SHA-256, signed URLs, 25 MiB ceiling)
                                                   ├──▶ Workflow jobs (export, import, backfill, integrity, cleanup)
                                                   └──▶ LLM gateway (advisory checks, suggestions)
```

## What the prototype measured

| Operation | Measured | Target | What it tells us |
|---|---|---|---|
| Edit engine, 1 replacement in 10 MiB (laptop) | **7 ms** | n/a | The algorithm is not the cost; a 100-change batch is 9 ms |
| Word search, 400 KB, 8 clients, p95 (laptop Postgres, Oct 19) | **103 ms** (was 1,626) | < 300 ms | The chunk query rewrite removed a per-candidate lookup; machine heavily loaded, diagnostic |
| Edit, 400 KB, 8 clients, p95 (laptop Postgres, Oct 19) | **246 ms** (was 409) | < 500 ms | 100 of 100 commits; same diagnostic caveat |
| Metadata read, 1 MiB, 8 clients, p95 (hosted, Neon, Oct 18) | **121 ms** | < 100 ms (**missed**) | Includes public-network latency; generator load 12→125 |
| Word search, 1 MiB, 8 clients, p95 (hosted, Neon, Oct 18) | **348 ms** | < 300 ms (**missed**) | Measured before the query rewrite above |
| Edit, own 1 MiB document, 8 clients, p95 (hosted, Neon, Oct 18) | **268 ms**, ~27 commits/s | < 500 ms (met) | Each client edits its own document; no errors. Same-document contention is measured separately as CAS conflicts |
| 32 clients (hosted, Neon) | errors in search and mixed load | no errors | No capacity claim at 32 |
| 25 MiB edit / revert / full replacement (hosted, single run) | **2.4 / 3.0 / 2.8 s** | publish separately | Functional check over Blob; API JSON stayed under 1 KB |
| LLM judge call | **~2,400 ms** median | hard deadline 25 s | Always advisory; the benchmark run cost $1.52 |

Sizing arithmetic (from the assumptions, not a load test): 500 concurrent editors at one edit per 15 s is ~33 edits/s. One Postgres committed ~27 separate-document edits/s at 8 clients, so production needs headroom: per-document row locks and more than one instance. **No hosted number above was taken on Supabase**; the matrix must be rerun there.

## Decisions by topic

| Topic | Design | Number | Trade-off |
|---|---|---|---|
| **Compute** | Stateless API on Vercel Fluid functions; slow work as durable Workflow jobs, at most 2 running, 100 queued | jobs: 3 retries, execution leases, 24 h export expiry | Two runtimes to observe vs. no request holding a 25 MiB export |
| **Storage** | Postgres: metadata, revisions, search chunks. Bodies above the 1 MiB inline limit live once in private Blob, keyed by SHA-256 | 25 MiB ceiling; duplicate DB bodies pruned only after a verified manifest and restore rehearsal | Two stores to keep consistent: integrity sweep and orphan cleanup run daily |
| **Search** | GIN over 8,000-character chunks (lifts the ~1 MB `tsvector` cap), `ts_rank`; `pg_trgm` for exact, case-sensitive matches; snippets only for the returned page | word p95 1,626 → 103 ms (laptop) | Chunk-level ranking, not whole-document |
| **Index freshness** | Chunks reindexed in the same transaction as the edit; large indexing has its own statement deadline | a committed edit is searchable at once | Long transactions on 25 MiB edits (~2.4 s) |
| **Caching** | Versions are immutable: cache by `(id, version/ETag)` at the edge; content by hash; Redis later only for rate limits and hot search pages | repeat reads `304` | Rate limits are per process today |
| **Concurrency** | Version compare-and-swap, `If-Match`, signed upload intents bound to `expectedVersion`; no auto-merge | stale write → `409`/`412` | Users retry; CRDTs would change the model |
| **Batching** | A PATCH batch is the atomic unit (5,000 changes); imports and backfills batched in jobs | 100 edits = 9 ms engine | A large batch holds the document longer |
| **CI/CD** | Typecheck, lint, coverage floors, SQLite and Postgres suites, browser + a11y, weekly fuzz, audit; migrations are explicit commands, never on startup; `/ready` gates traffic | engine ≥98% lines, API ≥90% | Slower pipeline vs. fewer bad deploys |
| **Security** | OIDC/SSO + roles; `tenant_id` + row-level security; app connects as a scoped DB role over CA-verified TLS; audit of actor, version, hashes (never text) | demo has none (open, labelled) | Per-tenant keys add key management; SOC 2/GDPR need audited evidence |
| **Resilience** | Managed Postgres backups + PITR; Blob content covered by a recovery manifest and a restore rehearsal | RPO ≈ 0 in region, RTO < 5 min (targets) | One writer per document, so no active-active |
| **Observability** | OTLP metrics: route, SQL, pool, lock waits, Blob, AI cost, queue age, event loop; no text or IDs in labels | alerts: 5xx > 2%, queue age > 5 min, readiness down 2 min | Local collector verified; hosted delivery untested |
| **Cost & regions** | Cap document and batch size; per-IP AI limits (20 suggestions / 60 checks per hour); right-size compute from p95; regional cells for residency | current compute allows 60 Postgres connections | Cells duplicate infra; multi-region writes deferred |

## Risks and first measurements

1. **Hosted targets are not demonstrated.** At 8 clients, metadata (121 ms) and word search (348 ms) missed on Neon, before the search rewrite; 32 clients produced errors. Rerun the matrix on Supabase from a generator near `iad1`.
2. **Connection budget.** 60 Postgres connections on the current compute. The test suite exhausted the pooler when pointed at production; tests and load need their own database, and production headroom is untested.
3. **No tenancy today.** Nothing here is customer-ready until authentication, row-level security and audit are in; SOC 2 and GDPR are evidence and review, not architecture.

Raw numbers: [October 18](bench/performance/results/2026-10-18/REPORT.md) and [October 19](bench/performance/results/2026-10-19/REPORT.md) reports, [`bench/performance`](bench/performance/README.md). Longer alternatives: [appendix](docs/INFRA_APPENDIX.md).
