# CLAUSE operations

How the hosted service runs day to day: deployment, durable jobs, migrations and recovery, telemetry, and the rollout gate. The production design (Part II) is the one page in [INFRA.md](../INFRA.md).

Hosted: Vercel (Fastify/Nitro on Node 24, `iad1`), Supabase Postgres (`us-east-1`), and private Vercel Blob for large bodies. Local development uses SQLite and immutable filesystem objects. Documents have a 25 MiB UTF-8 ceiling. API bodies stay inline up to 1 MiB; larger responses carry an immutable revision reference and a signed content URL.

## Deployment and region

Production moved from Neon to Supabase on 2026-10-18, after Neon began rejecting connections with SQLSTATE `53000` (account/project quota exceeded). The app connects through Supabase's transaction pooler (port 6543) as a dedicated `clause_app` role, not the project owner. TLS is verified against Supabase's own CA, supplied in `CLAUSE_DATABASE_CA` (PEM; `\n` escapes are expanded). The Vercel project reports `iad1`, Fluid compute enabled, and `functionDefaultRegions: ["iad1"]`; the repository pins the API and Workflow functions there.

The Supabase compute behind production allows 60 Postgres connections. Point disposable test and load runs at a separate database: the API test suite run against the production pooler exhausted it (`EMAXPOOLSREACHED`) on 2026-10-18 while it was serving traffic.

`/health` is process liveness and does not connect to the database. `/ready` checks the required schema version with a bounded database deadline. Production request startup does not run migrations, backfills, or verification. `attachDatabasePool` is applied in both the Fastify entrypoint and Workflow steps. Connection acquisition is limited to two seconds; large indexing transactions have a separate statement deadline.

`CLAUSE_DATABASE_SCHEMA` selects a validated Postgres schema for a disposable preview. Migrate that schema explicitly before deployment. Normal runtime connections never create it. Isolated schemas select `DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING` when provided: transaction poolers (Supabase on 6543, and Neon's) reject startup search-path options, so use Supabase's session pooler (5432) or a direct connection for them. Production data migrations and pruning are explicit operator commands.

## Durable jobs

Nitro compiles `workflows/jobs.ts` through `workflow/nitro`. Generated Workflow endpoints route before the frontend fallback. Export, provider import, content backfill, integrity sweep, and orphan cleanup jobs persist their payload, checkpoint, progress, and outcome in the application store. Payloads hold revision or object references rather than document text. Expiring signed URLs are generated when requested, never retained as permanent results.

The queue accepts 100 pending expensive jobs and runs at most two. Execution leases prevent duplicate deliveries from running one job concurrently. Transient failures receive three retries; invalid content terminates immediately. Import and backfill commits lock the job record and check cancellation in the same transaction as the data write. Export rendering runs in a worker thread. Cancellation terminates rendering and prevents output publication.

Large Word exports and provider imports return `202` with `jobId` and `statusUrl`. Poll that resource for progress; completed exports return a fresh download URL. `POST /jobs/:id/cancel` cancels pending work. A duplicate already imported file keeps the existing `200` response. The web client follows either response and shows progress. Signed-in connector administrators use live repositories; the open sample repository demo remains available.

`POST /jobs` queues maintenance and `POST /jobs/dispatch` retries dispatch of persisted queued/running jobs. Both require `CLAUSE_OPERATIONS_TOKEN`, at least 32 characters. A daily Vercel cron invokes `/internal/maintenance` with `CRON_SECRET` to queue integrity and cleanup. Cleanup waits for other active work and preserves committed content, active job objects, recovery manifests, and backup objects. Exports expire after 24 hours. Orphans younger than 24 hours are protected, covering in-flight uploads and interrupted transactions.

Local Workflow runs require a persistent SQLite file and a shared content directory. An in-memory database cannot be shared by separately resumed steps.

## Migration, recovery and pruning

From the repository root, run commands through `pnpm --filter @clause/api`:

1. `db:migrate` applies additive schema migrations.
2. `db:backfill-content` verifies and commits large snapshot objects in bounded batches, checkpointing each snapshot. Its output includes the job ID. Supply that ID to resume an interrupted command.
3. `db:verify-content` runs an integrity sweep over every revision.
4. `db:manifest-content` writes and verifies an immutable recovery manifest. Record its returned `path` and `hash`.
5. `db:rehearse-content MANIFEST_PATH` restores every referenced snapshot into a disposable database, verifies its bytes, hash, timestamp and summary, and writes a proof bound to that exact manifest.
6. `db:prune-content MANIFEST_PATH PROOF_PATH` re-verifies each object, registers the manifest and backups against garbage collection, then conditionally removes duplicate database bodies. It is safe to restart. Version IDs, hashes, history, summaries and timestamps stay intact.
7. `db:restore-content MANIFEST_PATH` restores duplicate database bodies from verified objects without creating revisions. Stale or missing database versions are skipped.

The same recovery suite exercises real prune/restore operations on SQLite and Postgres. SQLite keeps the current document body as the source for its local FTS index; duplicate revision bodies can be pruned. Postgres searches chunks and can prune both current and historical duplicate bodies. No automatic job prunes compatibility bodies.

For durable execution, `jobs:queue API_BASE content_backfill REQUEST_KEY` queues a job through the compiled Workflow API; use `integrity_sweep` or `orphan_cleanup` for the other maintenance operations. `jobs:dispatch API_BASE` recovers a dispatch failure. Direct CLI maintenance uses the same persisted job records and execution code.

## Large replacement protocol

Upload intents accept `operation: create`, `revision` or `preview`. Revision and preview intents require `documentId` and `expectedVersion`; signed claims bind the object path, operation, version, size and expiry. Completion verifies the uploaded bytes and hash before the compare-and-swap. Preview objects can only be consumed by the check route and are removed afterwards. A replay cannot delete an object referenced by a committed revision.

Changed-span text is optional when its total exceeds the response budget; positions and hashes stay present, and the browser rebuilds those spans from its pinned base and staged replacements. Large replacement bodies use direct uploads, and Clause CI accepts a preview upload reference. Download fallback uses the receipt's exact immutable version and verifies its hash. The browser worker keeps one active document while its content cache stays bounded. Evidence views load only the requested text windows; large insertions show an explicit excerpt while the full replacement stays in the staging form.

Word search uses PostgreSQL frequency ranking (`ts_rank`) over indexed chunk matches, with title ranking kept. Exact search keeps case-sensitive, non-overlapping occurrence counts and title tie ordering. The measured query plan is kept with the performance evidence. PostgreSQL documents the ranking trade-offs at https://www.postgresql.org/docs/current/textsearch-controls.html.

## Metrics and alerts

Set `OTEL_EXPORTER_OTLP_ENDPOINT` or the complete `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`. Authenticated collectors can use `OTEL_EXPORTER_OTLP_HEADERS` in OpenTelemetry's comma-separated `name=value` form (URL-encode values containing spaces, commas, or equals signs), for example `authorization=Bearer%20<secret>`. Store it as a Vercel secret; never commit it or paste it into benchmark output. The provider exports route duration and errors, store operations, SQL statement counts, execution and errors, pool acquisition duration and queue depth, sampled database lock waits, Blob bytes and latency, AI latency, errors, tokens and estimated cost, job queue age, event-loop delay, memory and browser vitals. Cost requires `CLAUSE_AI_COST_PER_MILLION_TOKENS` with exact model IDs. Vercel responses schedule bounded metric flushing; shutdown has a bounded helper.

Telemetry attributes contain route templates, fixed operation names, model IDs and status classes. They exclude document text, user identifiers, raw document IDs and signed URLs. `/internal/diagnostics`, protected by the operations token, exposes process-level counters and memory for controlled local benchmarks. A hosted instance snapshot is not a fleet-wide total.

Start the official OpenTelemetry Collector with `ops/otel-collector.yaml` and capture its output. Then run:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
CLAUSE_OTEL_CAPTURE=/tmp/clause-otel-collector.log \
pnpm exec node scripts/telemetry-smoke.ts
```

The smoke sends real application route and store measurements plus synthetic AI, Blob and SQL failure measurements. It verifies decoded metric delivery through the collector and rejects sensitive attributes. It does not spend provider credits. To exercise collector authentication locally, set `OTEL_EXPORTER_OTLP_HEADERS` to a collector-issued test credential. Configure the same endpoint and secret on Vercel, then verify a fresh instance exports before considering telemetry rollout complete.

## Jev semantic evaluation

`TYPESAFE_API_KEY` is server-only. `CLAUSE_JEV_MODE` accepts `off`, `shadow`, or `pilot`; production starts in `shadow`, where the existing judge remains authoritative and aggregate fixed-label agreement counters are exported. Jev uses the pinned `jev-1.14.0` ID and TypeSafe's standard context only. State and question text are capped conservatively before a request; oversized or failed Jev calls become unavailable and fall back to the current judge. A pilot routes only high selected-label-probability negative answers directly; positive and uncertain answers use the existing quote-producing judge. A Jev answer cannot create a PASS without a verified quote.

Before enabling pilot, run the frozen ContractNLI and CUAD benchmark with a replacement TypeSafe key, regenerate the report, and run `pnpm bench:ci:gate`. The gate requires all 60 static ContractNLI cases, 30 regression pairs, and 72 CUAD cases with no Jev provider failures, no higher CUAD false-PASS rate, and no lower regression-detection rate than the current judge. Only after a pass should `CLAUSE_JEV_MODE=pilot` and `CLAUSE_JEV_PILOT_GATE=passed` be set. The shared unauthenticated demo must display its TypeSafe document-text notice whenever Jev is enabled. Jev inputs are document text and requirement statements; no IDs, text, or signed URLs are added to telemetry.

Starter alerts: readiness unavailable for 2 minutes; HTTP 5xx above 2% for 5 minutes; database errors above 1% for 5 minutes; AI provider errors above 5% for 10 minutes; job queue age above 5 minutes; event-loop delay above 100 ms for 5 minutes. Latency targets: warm metadata p95 below 100 ms, search below 300 ms, and ordinary 1 MiB edits below 500 ms at eight clients. Publish 25 MiB measurements separately.

## Verification before rollout

Run typecheck, lint, coverage, the API and web builds, the disposable Postgres suite, and the desktop and mobile browser journeys. See [`bench/performance/README.md`](../bench/performance/README.md) for fixture preparation, k6 scenarios and result artifacts. Older reports describe their own runtime and architecture; they are not evidence for the current implementation. Hosted results must record deployment, region, Node and k6 versions, document size, concurrency, warm state, failures and transferred bytes.

## Recorded rollout gate

The [October 18 evidence](../bench/performance/results/2026-10-18/REPORT.md) holds the full diagnostic load matrix and the large-document checks; the [October 19 follow-up](../bench/performance/results/2026-10-19/REPORT.md) adds a matched local comparison after the word-search rewrite. Both hosted runs used Neon, before the move to Supabase, so no hosted number in them describes the current database.

The eight-client metadata and standalone search targets are not yet demonstrated by a stable hosted run. Rerun the hosted matrix, isolated 10 and 25 MiB reads, and an observed cold-instance test against Supabase, with a load generator near `iad1`. Hosted OTLP export is also still a gate: local collector delivery does not prove fleet delivery. No duplicate-body pruning has been performed.
