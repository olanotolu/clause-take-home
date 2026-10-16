# CLAUSE

[![CI](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml/badge.svg)](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml)

[Open the demo](https://clause-take-home.vercel.app) · [API reference](https://clause-take-home.vercel.app/api/docs) · [Production design](INFRA.md) · [One-page PDF](output/pdf/CLAUSE-infrastructure.pdf)

CLAUSE edits plain-text documents with explicit, reviewable changes and searches their contents. Select a passage, stage a replacement, preview the redline, and apply the batch. Search results open the exact verified passage. Activity retains revisions and exports Word tracked changes.

**The public demo is a shared workspace with no sign-in required for documents or AI. Anyone can read, edit, or delete its fictional data. It is unsuitable for confidential contracts.** Integrations in the UI use clearly marked sample files. Optional real connectors require an authenticated admin and provider configuration.

## Run locally

Use Node **24.x** and pnpm **10.33.0**. Node 26 remains a CI compatibility check. Both TypeScript configurations use **5.9.3**.

```sh
pnpm install --frozen-lockfile
pnpm seed                 # five fictional contracts, local SQLite
pnpm dev                  # API :3000; OpenAPI /docs
pnpm dev:web              # UI :5173, proxies /api
./http/demo.sh            # curl walkthrough; requires jq
```

Copy `.env.example` to `.env.local` to configure optional AI or Postgres. Without AI credentials, editing, search, and exact Clause CI checks work. Secrets stay on the server. Source TypeScript runs under Node's type stripping; typecheck is a separate required gate.

## Try the API

```sh
curl -s http://localhost:3000/documents -H 'content-type: application/json' \
  -d '{"title":"Example NDA","content":"The recipient shall keep information confidential."}'

# Replace DOC_ID with the returned id.
curl -s -X PATCH http://localhost:3000/documents/DOC_ID \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":1,"changes":[{"operation":"replace","target":{"quote":{"exact":"confidential"}},"replacement":"strictly confidential"}]}'

curl -s 'http://localhost:3000/documents/search?q=confidential&mode=words&limit=10'
```

The [OpenAPI reference](https://clause-take-home.vercel.app/api/docs) documents previews, position selectors, history, restore, requirements, suggestions, and error shapes.

## Editing and search design

`packages/core` contains the dependency-free edit engine. It resolves every selector against one input snapshot, rejects ambiguity and overlap, and rebuilds text in one forward pass. A bad change rejects the whole batch. Positions use UTF-16 half-open offsets and require `expectedText`; surrogate pairs cannot be split. Quote selectors are literal, case-sensitive, and can include occurrence or surrounding context.

SQLite and Postgres implement one `Store` interface. Compare-and-swap commits update content, search indexes, and immutable revision history atomically. Stale versions return `409`; stale `If-Match` returns `412`. Restoring creates a new revision. No-op edits do not create revisions.

Words search uses SQLite FTS5 or Postgres GIN ranking. A single store operation returns the total and the paginated document/version/content snapshot. SQLite uses a read transaction; Postgres uses repeatable read. Only the selected page receives snippets; large documents use a bounded locator above 256 KiB. Exact search is literal and case-sensitive. The browser verifies version and selected text after loading and refuses stale offsets. Search cannot discard staged edits, and obsolete document loads cannot replace a newer navigation.

## AI boundaries

Suggestions are proposals, never writes. The same edit engine validates them before a person can apply. Each suggestion or Clause CI request has a 25-second overall deadline, including queued judging. Suggestions allow 4,000 output tokens, five edits, 2,000 characters per target/replacement, and a 400-character rationale. Oversized edits are rejected without truncation. Suggestion timeouts return `504 AI_TIMEOUT`; a successful proposal survives optional CI timeout with `ci: null`.

Clause CI compares saved requirements before and after an edit. Exact checks use no model. Semantic checks require verified quotes and remain advisory; failures and timeouts become `UNAVAILABLE`. Verifying a quote's existence does not establish its legal meaning. Jev is experimental and **disabled by default**. Its optional batch implementation sends one call per document state; the LLM judge remains a separate evidence source.

The [existing ContractNLI benchmark](bench/ci/RESULTS.md) measured the LLM baseline on NDA entailment. The separate [citation experiment](bench/citations/RESULTS.md) freezes 30 development and 30 held-out cases plus ten fabricated quotes, records model/input hashes and raw responses, and reserves at most $5 before serial calls. Provider access failures stop that arm. Neither experiment establishes legal reliability.

## Performance and verification

The original **local SQLite** 10 MiB benchmark measured rare/common words search at 16/20 ms and a full-stack single edit at 713 ms, on Apple M4 / Node 26.7 under load. The engine took 7 ms; index updates, full revision snapshots, and response transfer dominated. **Hosted Postgres has a 500,000-character limit**, so these are not hosted 10 MiB results. Original and comparable snapshot-read reruns are retained in [performance notes](bench/performance/README.md).

```sh
pnpm typecheck
pnpm lint
pnpm test:coverage
CLAUSE_TEST_DATABASE_URL=postgresql://… pnpm test:coverage # isolated disposable database
pnpm test:e2e             # real built app, desktop and 390px, axe checks
pnpm --filter @clause/web build
pnpm bench
```

CI checks Node 24/26, Postgres 16, browser journeys, coverage floors, and production dependency advisories. Core coverage floors are 98% lines / 95% branches; API 90% / 78%; Postgres store 90% / 80%. Tests cover atomic edits, concurrent writers/search, pagination/deletion, stale passage selection, staged work, provider cancellation, malformed answers, and citation preflight. Browser coverage is Chromium only.

## Scope and trade-offs

Full snapshots and full-text edit responses simplify review and restoration but scale poorly for large documents. Target resolution costs up to O(changes × document length). Rate limits and semantic caches are per process, not tenant quotas. No tenancy, ownership, confidential audit trail, or production security claim is made. Text import drops formatting; the template library is US-first and requires legal review. Word exports have XML/pandoc accept/reject checks, not a claim of testing every Microsoft Word version.

The expanded workspace exceeds the original time box. The assessment's core is the edit engine, API, search, tests, and measured trade-offs; integrations, templates, requests, and Clause CI are extras. [NOTES.md](NOTES.md) records debugging and earlier verification. [The infrastructure appendix](docs/INFRA_APPENDIX.md) retains production details. [DESIGN.md](DESIGN.md) covers the UI, including font licensing. AI assistance was used throughout; correctness claims above rely on executable checks and measurements.
