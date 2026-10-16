# CLAUSE

[![CI](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml/badge.svg)](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml)

CLAUSE is a text-editing service and UI for contracts. Select a passage, stage a replacement, preview the redline, apply the batch. Search results open the exact passage they matched. History keeps every revision and can export Word tracked changes.

[Open the demo](https://clause-take-home.vercel.app) · [Watch the walkthrough](https://clause-take-home.vercel.app/video) · [API reference](https://clause-take-home.vercel.app/api/docs) · [Production design](INFRA.md) · [One-page PDF](output/pdf/CLAUSE-infrastructure.pdf)

The demo is a shared workspace with no sign-in. Anyone can read, edit, or delete its fictional data, so do not put real contracts in it. The Integrations page uses labelled sample files; real connectors exist but require an admin sign-in and provider configuration.

## Run it

Node 24.x and pnpm 10.33.0. Node 26 stays a CI compatibility check. Both TypeScript configs are on 5.9.3.

```sh
pnpm install --frozen-lockfile
pnpm seed                 # five fictional contracts, local SQLite
pnpm dev                  # API on :3000, OpenAPI at /docs
pnpm dev:web              # UI on :5173, proxies /api
./http/demo.sh            # curl walkthrough, needs jq
```

Copy `.env.example` to `.env.local` for optional AI (OpenRouter) or Postgres. Without AI credentials, editing, search, and the exact Clause CI checks still work. Secrets stay on the server. Source TypeScript runs under Node's type stripping, so `pnpm typecheck` is a separate required gate.

## API example

```sh
curl -s http://localhost:3000/documents -H 'content-type: application/json' \
  -d '{"title":"Example NDA","content":"The recipient shall keep information confidential."}'

# Replace DOC_ID with the returned id.
curl -s -X PATCH http://localhost:3000/documents/DOC_ID \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":1,"changes":[{"operation":"replace","target":{"quote":{"exact":"confidential"}},"replacement":"strictly confidential"}]}'

curl -s 'http://localhost:3000/documents/search?q=confidential&mode=words&limit=10'
```

The OpenAPI reference also covers previews, position selectors, history, restore, requirements, suggestions, and error shapes.

## How editing and search work

**Edit engine** (`packages/core`, dependency-free). Every selector resolves against one input snapshot; ambiguity and overlap are rejected, not guessed. Text is rebuilt in one forward pass, and one bad change rejects the whole batch. Positions are UTF-16 half-open offsets and require `expectedText`; surrogate pairs cannot be split. Quote selectors are literal and case-sensitive, with optional occurrence and surrounding-context filters.

**Storage.** SQLite and Postgres implement the same `Store` interface. A compare-and-swap commit updates content, search indexes, and immutable revision history atomically. Stale versions return `409`; stale `If-Match` returns `412`. Restoring creates a new revision; no-op edits create none.

**Search.** Words mode uses SQLite FTS5 or Postgres GIN ranking. One store operation returns the total plus the paginated document/version/content snapshot (read transaction on SQLite, repeatable read on Postgres). Only the selected page gets snippets; documents over 256 KiB use a bounded locator. Exact mode is literal and case-sensitive. The browser re-verifies version and selected text after loading and refuses stale offsets. Search cannot discard staged edits, and an obsolete document load cannot replace a newer navigation.

### Why not an in-memory inverted index

The brief floats an in-memory inverted index for faster repeated searches. What this has is an inverted index (term to the documents and positions it appears in) that lives in the database: FTS5 for words and a trigram index for exact phrases on SQLite, GIN indexes on Postgres. It is updated in the same transaction as the edit, so a committed edit is searchable at once, and the database's page cache keeps the hot parts in memory. A second, in-memory copy was not built because the measurements pointed elsewhere: looking up a term was never slow (about 21 ms for a rare word and 25 ms for a common phrase on 10 MiB), the 8.3 s was snippet generation (fixed), and of a roughly 790 ms edit the engine is 7 ms. An in-memory index would speed up the step that was already fast, and costs a rebuild on every cold start, one copy per serverless instance, invalidation across instances, and more memory. It pays off in one long-lived process answering many repeated queries on big documents; then cache postings for hot terms keyed by `(query, version)` so staleness is detectable.

## AI boundaries

Suggestions are proposals. They go through the same edit engine, and a person applies them. Each suggestion or Clause CI request has a 25-second deadline including queued judging, plus caps of 4,000 output tokens, five edits, 2,000 characters per target/replacement, and a 400-character rationale. Oversized edits are rejected rather than truncated. A suggestion timeout returns `504 AI_TIMEOUT`; a valid proposal whose CI check timed out returns `ci: null`.

Clause CI compares saved requirements before and after an edit. Exact checks use no model. Semantic checks require verified quotes and stay advisory; failures and timeouts become `UNAVAILABLE`. Verifying that a quote exists does not establish what it means legally. Judges that support batching send one call per document state.

Two benchmarks exist: [ContractNLI](bench/ci/RESULTS.md) measured the LLM baseline on NDA entailment, and the [citation experiment](bench/citations/RESULTS.md) froze 30 development and 30 held-out cases plus ten fabricated quotes, recording model/input hashes and raw responses with at most $5 reserved for serial calls. Provider access failures stop that arm. Neither experiment establishes legal reliability.

## Performance and verification

The local SQLite 10 MiB benchmark (Apple M4, Node 24, paired rerun) measured words search at 21/25 ms for rare/common terms, exact search at 16/52 ms for unique/many hits, and a full-stack single edit at 789 ms, of which the engine took 7 ms; index updates, the full revision snapshot, and response transfer dominated. `Prefer: return=minimal` drops the text from the edit response (10 MiB: 10,486,119 → 357 bytes). Hosted Postgres has a 500,000-character limit, so these are not hosted 10 MiB results. Reruns are kept in [performance notes](bench/performance/README.md).

```sh
pnpm typecheck
pnpm lint
pnpm test:coverage
CLAUSE_TEST_DATABASE_URL=postgresql://… pnpm test:coverage   # isolated disposable database
pnpm test:e2e             # real built app, desktop and 390px, axe checks
pnpm --filter @clause/web build
pnpm bench
```

CI checks Node 24/26, Postgres 16, browser journeys, coverage floors, and production dependency advisories. Coverage floors: core 98% lines / 95% branches; API 90% / 78%; Postgres store 90% / 80%. Tests cover atomic edits, concurrent writers/search, pagination/deletion, stale passage selection, staged work, provider cancellation, malformed answers, and citation preflight. Browser coverage is Chromium only.

## Limits and scope

Full snapshots and full-text edit responses simplify review and restore but scale poorly for large documents. Target resolution costs up to O(changes × document length). Rate limits and semantic caches are per process, not tenant quotas. There is no tenancy, ownership, confidential audit trail, or production security claim. Text import drops formatting; the template library is US-first and needs legal review. Word exports pass XML/pandoc accept/reject checks; not every Microsoft Word version was tested.

The workspace grew past the original time box. The assessed core is the edit engine, API, search, tests, and measured trade-offs; integrations, templates, requests, and Clause CI are extras. [ASSESSMENT_SCOPE.md](ASSESSMENT_SCOPE.md) maps each brief item to its code and tests, and labels everything else. [NOTES.md](NOTES.md) is the running dev log, [docs/INFRA_APPENDIX.md](docs/INFRA_APPENDIX.md) keeps longer production detail, and [DESIGN.md](DESIGN.md) covers the UI including font licensing. AI assistance was used throughout; the correctness claims above rest on executable checks and measurements.
