# CLAUSE

[![CI](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml/badge.svg)](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml)

**A redlining and search service for contracts.** Point at exact text, stage changes, preview the redline, and apply them as a new version. Search returns passages you can edit from. When a request is ambiguous, overlaps another change or was made against an old version, CLAUSE returns a precise error instead of guessing.

[Live demo](https://clause-take-home.vercel.app) · [Walkthrough video (8:50)](https://clause-take-home.vercel.app/video) · [API reference](https://clause-take-home.vercel.app/api/docs) · [Production design](INFRA.md) · [One-page PDF](output/pdf/CLAUSE-infrastructure.pdf) · [Scope map](ASSESSMENT_SCOPE.md)

> The demo is a shared workspace with fictional contracts and no sign-in. The five sample contracts are read-only: use **Make a copy** to edit one. Don't put real contracts in it.

**On this page:** [Where to look](#where-to-look) · [Run it](#run-it) · [Brief → implementation](#what-was-asked-and-where-it-is) · [API](#the-api-at-a-glance) · [Design decisions](#design-decisions-and-trade-offs) · [Performance](#performance) · [Tests](#how-its-tested) · [Clause CI and AI](#clause-ci-and-ai-suggestions) · [Production](#production-design-part-ii) · [Limits](#limits) · [Repo map](#repository-map)

---

## Where to look

| If you want to see… | Open |
|---|---|
| How an edit is resolved and applied | [`packages/core/src/resolve.ts`](packages/core/src/resolve.ts), [`apply.ts`](packages/core/src/apply.ts): pure TypeScript, zero dependencies |
| How a write stays safe when two people edit | `commitRevision` in [`apps/api/src/store/sqlite.ts`](apps/api/src/store/sqlite.ts), and [`apps/api/test/concurrency.test.ts`](apps/api/test/concurrency.test.ts) |
| The API contract | [`apps/api/src/schemas.ts`](apps/api/src/schemas.ts) (validation and OpenAPI from one source), [`errors.ts`](apps/api/src/errors.ts), [`routes/documents.ts`](apps/api/src/routes/documents.ts) |
| Search | [`apps/api/src/search.ts`](apps/api/src/search.ts) |
| The tests | [`packages/core/test`](packages/core/test), [`apps/api/test`](apps/api/test), [`e2e/journeys.spec.ts`](e2e/journeys.spec.ts) |
| Part II | [`INFRA.md`](INFRA.md) (one page), with a longer [appendix](docs/INFRA_APPENDIX.md) |
| What is core and what is extra | [`ASSESSMENT_SCOPE.md`](ASSESSMENT_SCOPE.md) |
| What went wrong along the way | [`NOTES.md`](NOTES.md): every real bug, how it was found, what changed |

---

## Run it

Node 24.x and pnpm 10.33.0. There's no database server, no Docker and no API key required.

```sh
pnpm install --frozen-lockfile
pnpm seed                 # five fictional contracts into a local SQLite file
pnpm dev                  # API on :3000, interactive OpenAPI reference at /docs
pnpm dev:web              # UI on :5173, proxies /api to the API
./http/demo.sh            # curl walkthrough of the API (needs jq)
```

Optional, in `.env.local` (copy `.env.example`): `OPENROUTER_API_KEY` turns on AI suggestions and AI-judged checks; `CLAUSE_STORAGE=postgres` with `DATABASE_URL` runs on Postgres. Without them, editing, search and the exact checks all work.

The API runs TypeScript directly under Node's type stripping, so type checking is its own gate:

```sh
pnpm typecheck && pnpm lint && pnpm test:coverage
CLAUSE_TEST_DATABASE_URL=postgresql://… pnpm test:coverage   # the same suite on Postgres (disposable database)
pnpm test:e2e             # real browser, desktop and 390 px phone, with accessibility checks
pnpm bench                # 10 MiB benchmark;  pnpm load  for the concurrency check
```

---

## What was asked, and where it is

The brief, in my own words, with the part of the repo that answers each item.

| Asked for | How CLAUSE does it | Evidence |
|---|---|---|
| **Edit a document** with a JSON change request and get the updated text back | `PATCH /documents/:id` with a `changes` array; each change targets a quote (with occurrence, prefix or suffix) or a position (with the text expected there). The response is a receipt with the full new text | [`packages/core/test`](packages/core/test), [`documents.test.ts`](apps/api/test/documents.test.ts) |
| **Search** one or many documents for matching context | `GET /documents/search` and `GET /documents/:id/search`: ranked word search and literal exact search, with snippets and offsets you can edit from | [`search.test.ts`](apps/api/test/search.test.ts) |
| **Tests** for change and search logic, including large files | Unit, property and API tests on SQLite and Postgres; a 10 MiB benchmark; a load check | [How it's tested](#how-its-tested), [`bench/performance`](bench/performance/README.md) |
| **Sample requests** | [`http/demo.sh`](http/demo.sh) (curl), plus the [OpenAPI reference](https://clause-take-home.vercel.app/api/docs) | |
| **README** with setup, usage, performance and API rationale | This file | |
| Correct **4xx/5xx** with a JSON `{ error, code }` body | One error shape for every response, including framework errors; a 500 never leaks a stack or document text | a forced-500 test, the weekly API fuzz |
| **Bulk** changes | `changes` is an array of up to 5,000, applied all-or-nothing | `engine.test.ts`, `documents.test.ts` |
| **Large documents**, near-linear | The new text is rebuilt in one pass; 7 ms for one edit on 10 MiB. Finding targets is one scan per quote, so O(changes × length) overall, and I say so | [Performance](#performance) |
| **Concurrency** and repeated matches | `expectedVersion` or `If-Match`, then a compare-and-swap commit: a stale write gets 409 or 412. A quote that matches more than once is refused with every candidate listed | [`concurrency.test.ts`](apps/api/test/concurrency.test.ts), [`etag-race.test.ts`](apps/api/test/etag-race.test.ts) |
| **Indexing**, and its trade-offs | Inverted indexes inside the database (SQLite FTS5 and trigram; Postgres GIN and pg_trgm), updated in the same transaction as the edit | [Why not an in-memory inverted index](#why-not-an-in-memory-inverted-index) |
| **API design** rationale | Resources for reads and writes, named actions where an action isn't a resource update | [Design decisions](#design-decisions-and-trade-offs) |
| **Part II**: production design | [`INFRA.md`](INFRA.md): measured numbers against targets, a decision table by topic, the risks | [PDF](output/pdf/CLAUSE-infrastructure.pdf) |

Built beyond the brief, and labelled as extras in [`ASSESSMENT_SCOPE.md`](ASSESSMENT_SCOPE.md): Clause CI, AI suggestions, Word tracked-changes export, the workspace UI (requests, playbooks, templates), the Integrations demo, and the walkthrough video.

---

## The API at a glance

| Method and path | What it does |
|---|---|
| `POST /documents` | Create (201, `Location`, `ETag`) |
| `GET /documents` · `GET /documents/:id` | List (paged) · read; `If-None-Match` gives 304 |
| `PATCH /documents/:id` | Apply a batch of changes; returns a receipt |
| `POST /documents/:id/changes/preview` | Dry run through the same engine call; writes nothing |
| `POST /documents/:id/changes/check` | Clause CI: check a proposed edit against saved requirements |
| `POST /documents/:id/revert` | Restore an old version's text as a new version |
| `GET /documents/:id/revisions[/:version]` | History; one snapshot |
| `GET /documents/:id/export.docx?from&to` | Word file with tracked changes between two versions |
| `GET /documents/search?q&mode=words\|exact` · `GET /documents/:id/search` | Search everything · search one document |
| `POST /documents/:id/copy` · `DELETE /documents/:id` | Copy (for the read-only samples) · delete |
| `…/requirements`, `/requests`, `/playbooks`, `/templates`, `/activity`, `/settings/status` | The workspace features ([reference](https://clause-take-home.vercel.app/api/docs)) |

**An edit and its receipt:**

```sh
curl -s -X PATCH http://localhost:3000/documents/DOC_ID -H 'content-type: application/json' \
  -d '{"expectedVersion":1,"changes":[{"operation":"replace","target":{"quote":{"exact":"Receiving Party shall","occurrence":2}},"replacement":"Recipient shall"}]}'
```
```json
{ "id": "doc_…", "previousVersion": 1, "version": 2, "changed": true,
  "beforeHash": "8b7a4c52…", "afterHash": "2454fa48…",
  "applied": [{ "index": 0, "start": 1270, "end": 1291, "before": "Receiving Party shall", "after": "Recipient shall", "newStart": 1270, "newEnd": 1285 }],
  "content": "…the full updated text…" }
```
The response also carries `ETag: "v2-2454fa484923"`. Send `Prefer: return=minimal` to get the receipt without `content` (on a 10 MiB document, 10,486,119 bytes becomes 357).

**The same edit without `occurrence`** is refused, because the quote matches three passages:

```json
{ "error": "Target text matches 3 passages; add an occurrence, prefix or suffix", "code": 409, "type": "AMBIGUOUS_TARGET",
  "details": { "matchCount": 3, "candidates": [
    { "start": 1045, "end": 1066, "context": "…2.1 The Receiving Party shall not disclose…" },
    { "start": 1270, "end": 1291, "context": "…2.2 The Receiving Party shall take reasonable…" },
    { "start": 2239, "end": 2260, "context": "…the Receiving Party shall promptly return…" } ] } }
```

**Targets.** A *quote* is literal, case-sensitive text, with an optional `occurrence`, `prefix` or `suffix`. A *position* is UTF-16 offsets `[start, end)` plus the `expectedText` that must be there, so there are no blind writes by offset. Offsets that would split a surrogate pair are refused. A delete is an empty replacement; an insert is a position where `start == end`.

**Status codes.**

| Code | Meaning |
|---|---|
| 409 | The request is valid but the document's current state conflicts with it: stale `expectedVersion`, ambiguous quote, or text moved. Re-read and retry |
| 412 | `If-Match` doesn't match the current ETag |
| 422 | The request can never succeed as written: overlapping changes, target not found, bad range |
| 403 | Shared sample, read-only (with a pointer to `/copy`) |
| 413 | Larger than this deployment can index or export |
| 400 / 404 / 429 / 500 | Invalid input (unknown keys refused) / not found / rate limited / server error |

Every error body is `{ error, code, type, details? }`, with `code` as a number.

---

## Design decisions and trade-offs

**1. A pure engine that refuses to guess.** All changes in a batch resolve against the same snapshot of the text. An ambiguous target, an overlap or two inserts at the same offset reject the whole batch. Then the text is rebuilt in one forward pass. Preview, commit, AI suggestions and Clause CI all call the same function (`applyChanges`), so a preview and the commit can't disagree. *Cost:* callers must be precise. The UI does that for you: it builds the shortest quote that resolves to exactly your selection (`selectorFor`) and checks it with the real resolver.

**2. Compare-and-swap, not locks or merges.** A commit is `UPDATE … WHERE id = ? AND version = ?`. The new text, the search index and an immutable revision row land in one transaction, or nothing does. *Why:* conflicts on one contract are rare, and people take minutes between reading and saving, so nothing should hold a lock across that. *Cost:* the loser of a race re-validates, and the UI keeps their staged edits and re-checks them after reload. There is no automatic merge, because a merge of two lawyers' edits is new legal text that nobody approved.

**3. A response describes the operation it performed.** The ETag on an edit or revert is built from that operation's receipt, never from re-reading the document afterwards. A re-read could pick up someone else's newer commit, or a delete. This was found in review and is pinned by a deterministic race test.

**4. Rank first, build snippets second.** The first 10 MiB search took 8,337 ms. The index lookup took about 0 ms; FTS5's `snippet()` walks every match in the row, and I was building snippets for every matching document before paginating. Now ranking happens alone, and snippets are built only for the returned page, with a bounded locator above 256 KiB: 20 ms. *Cost:* on very large documents the highlight is the first occurrence, not FTS5's "best" window.

**5. Every offset is verified.** A snippet once came from the wrong document: FTS5 silently ignored `rowid = ?` next to `MATCH`, and the tests only checked the highlighted word. Now the query filters on the joined document, the server re-finds each fragment in that document's own text before it attaches offsets, and the browser checks the version and the exact text again before selecting anything. Search runs inside one read snapshot, so the ranking and the snippet come from the same version.

### Why not an in-memory inverted index

The brief floats one. CLAUSE has inverted indexes, but they live in the database: FTS5 for words and a trigram index for exact phrases on SQLite, GIN indexes on Postgres. They're updated in the same transaction as the edit, so a committed edit is searchable at once, and the database's page cache keeps the hot parts in memory. A second copy in memory wasn't built because the measurements pointed elsewhere. Looking up a term was never slow (about 21 ms for a rare word and 25 ms for a common phrase on 10 MiB). The 8.3 s was snippet generation, and of a roughly 790 ms edit, the engine is 7 ms. An in-memory index would speed up the step that was already fast, and costs a rebuild on every cold start, one copy per serverless instance, invalidation across instances, and memory. It pays off in one long-lived process answering many repeated queries on big documents. Then I'd cache postings for hot terms keyed by `(query, version)`, so staleness is detectable.

**6. Full snapshots per revision, for now.** Every version stores its full text. Restore and audit are trivially correct, and a restore is just a new version whose text equals an old one, so history only grows. *Cost:* a frequently edited 10 MB document costs 10 MB per revision. The production design keeps snapshots in object storage, keyed by the SHA-256 the service already computes, with a full copy every ~20 revisions and deltas between.

**7. Resources plus named actions.** Reads and writes are separate: GETs never write, which is what makes caching by ETag safe. Edits are a `PATCH` on the document. Things that aren't a resource update get a named sub-resource: `changes/preview` and `changes/check` compute without writing, `revert` names a version and the server derives the text, `copy` creates a derived document. *Why:* a preview isn't a PATCH that happens not to save, and pretending it is would blur what changes state.

**8. One interface, two databases.** SQLite locally (nothing to install), Postgres in production, both behind one `Store` interface, and the whole suite runs against each. That proves the interface describes the domain rather than one database's quirks. Postgres uses a generated `tsvector` column, so its index can't drift from the text. Its 500,000-character cap comes from the tsvector limit, and anything bigger is refused up front rather than stored unsearchable.

**9. AI proposes, the engine validates, a person applies.** A suggestion is at most five bounded quote replacements. It goes through a scope check, then the same engine validation as a human edit, then Clause CI, and it comes back staged with `applied: false`. The document is treated as untrusted data in every prompt. Each call has a 25 s deadline including queueing. If no AI provider is configured, editing, search and exact checks still work.

---

## Performance

Local measurements: Apple M4, one process, SQLite, a seeded synthetic 10 MiB contract ([`bench/run.ts`](bench/run.ts)). These are not hosted numbers.

| Operation | Measured |
|---|---|
| Engine: one replacement in 10 MiB · a 100-change batch | **7 ms** · 9 ms |
| Full-stack edit, 10 MiB | **789 ms**: index updates, the full snapshot and the response, not the engine |
| Words search, 10 MiB, rare · common term | **21 · 25 ms** (was 8,337 ms before the fix in decision 4) |
| Exact search, 10 MiB, unique · many hits | **16 · 52 ms** |
| A stale write refused, 10 MiB | 409 in 14 ms |

Concurrency check ([`scripts/load.ts`](scripts/load.ts), 1 MB documents, one process):

| p95 at 1 · 8 clients | Measured | Target | |
|---|---|---|---|
| Read | 2 · 11 ms | 50 ms | met |
| Words search | 2 · 173 ms | 300 ms | met |
| Exact search | 5 · **435 ms** | 300 ms | **missed at 8** |
| Edit | 61 · **879 ms** | 500 ms | **missed at 8**, throughput plateaus near 19 edits/s on one SQLite writer |

The misses are written down rather than the targets moved. The targets are for the Postgres design, which hasn't been load-tested yet; [`INFRA.md`](INFRA.md) has the plan (per-document row locks, chunked indexes, replicas). Hosted Postgres caps documents at 500,000 characters, so the 10 MiB figures are SQLite only. Paired reruns and raw logs: [`bench/performance`](bench/performance/README.md).

---

## How it's tested

| Layer | What | Where |
|---|---|---|
| Engine | Unit tests and property tests (fast-check, fixed seed, 500 runs) | [`packages/core/test`](packages/core/test) |
| API | The full suite is 378 tests on SQLite and 383 on Postgres, including two real connections racing on one version, a writer injected between commit and response, provider timeouts and cancellation | [`apps/api/test`](apps/api/test) |
| Browser | 10 Playwright journeys on desktop and a 390 px phone, with axe accessibility checks after each step | [`e2e/journeys.spec.ts`](e2e/journeys.spec.ts) |
| Mutation | Flip one operator at a time in the engine and see whether a test notices: 65 of 70 killed; the 5 survivors are equivalent | `pnpm mutate`, [`scripts/mutate.ts`](scripts/mutate.ts) |
| Fuzzing | Schemathesis against the OpenAPI spec, seeded, weekly in CI; its first run found five bugs the hand-written tests had missed | [`scripts/fuzz`](scripts/fuzz) |

CI runs on every PR: typecheck, lint, tests with coverage floors on Node 24 and 26, the full suite on Postgres 16, browser journeys, and a production dependency audit. Actions are pinned to commit SHAs. Coverage floors: engine 98% lines / 95% branches; API 90% / 78%; Postgres store 90% / 80%. Package versions younger than three days can't be installed.

---

## Clause CI and AI suggestions

**Clause CI** checks a proposed edit against requirements saved on the document, before and after, and reports a delta for each: *Held*, *Broken by this edit*, *Newly satisfied*, *Still failing* or *Uncertain*.
- **Exact checks** use no model: must contain, must not contain, keep this passage verbatim. A broken verbatim rule names the change that broke it.
- **Statement checks** are judged by a model. A PASS needs a quote found verbatim in the document; judges that disagree, or a pass with no verifiable quote, become *Needs review*. Timeouts become *Unavailable*, never a pass. These results are advisory and labelled that way.
- Every result says how it was decided: `method: exact | model`, plus which judges answered.

It informs and the person decides; it doesn't block an edit. It was measured on ContractNLI before being trusted: [`bench/ci/RESULTS.md`](bench/ci/RESULTS.md) (cases frozen before any judge ran; Sonnet 5.5 at 80% three-way accuracy vs a 40% keyword baseline on 60 NDAs; 22 of 28 evidence-deleting edits flagged, none of 28 harmless ones). A separate [citation experiment](bench/citations/RESULTS.md) tests whether quotes support claims. Neither establishes legal reliability.

**AI suggestions** are covered in design decision 9. The caps are 4,000 output tokens, five edits, 2,000 characters per target or replacement, and a 400-character rationale. Oversized proposals are refused, not truncated. A timeout is `504 AI_TIMEOUT`.

---

## Production design (Part II)

[`INFRA.md`](INFRA.md) is one page, every number tagged *measured*, *target* or *untested*. In short:
- **Shape:** CDN and WAF with SSO in front of at least two stateless API replicas; Postgres as the source of truth with the same compare-and-swap; object storage for snapshots; Redis only for rate limits and hot search pages; a queue and workers for indexing, imports and AI.
- **Scale:** chunked per-paragraph indexes, per-document row locks, replicas, then partitioning. Each step is triggered by a measured problem, not added up front.
- **Security:** OIDC/SAML, `tenant_id` plus Postgres row-level security, per-tenant keys, and an audit log of hashes, never contract text.
- **Operations:** latency by document size, conflict rate, index lag and AI cost per tenant; expand-and-contract migrations; progressive rollout.
- **Risks, stated:** Postgres untested at size, two missed p95 targets, no tenancy yet.

Today it runs on Vercel (web and API as one project) with Neon Postgres.

---

## Limits

- No tenancy, sign-in or confidential audit trail on the demo, and no production security claim.
- Full snapshots and full-text edit responses scale poorly for large documents (decision 6; `return=minimal` helps).
- Target resolution costs up to O(changes × document length).
- Rate limits and the verdict cache are per process, not per tenant.
- Semantic checks are advisory. A verified quote proves the words exist, not that they support the conclusion.
- Word exports pass XML and pandoc accept/reject checks; not every Microsoft Word version was tested.
- The Integrations page runs on sample files. The real connectors exist and are tested with stubbed providers, but need OAuth credentials the demo doesn't have.

---

## Repository map

```text
packages/core     the edit engine: resolve, apply, anchor, exact requirement checks (no dependencies)
apps/api          Fastify + Zod API: routes, document service, storage (SQLite, Postgres), search, Clause CI, AI, Word export
apps/web          React 19 + Vite workspace UI
e2e/              Playwright journeys
bench/            10 MiB benchmark, ContractNLI judge benchmark, citation experiment
scripts/          load check, mutation harness, fuzz runner, smoke tests
http/demo.sh      curl walkthrough
fixtures/         the five fictional sample contracts
```

**Further reading:** [`ASSESSMENT_SCOPE.md`](ASSESSMENT_SCOPE.md) maps the brief to code and labels the extras. [`NOTES.md`](NOTES.md) is the running dev log of real findings. [`docs/INFRA_APPENDIX.md`](docs/INFRA_APPENDIX.md) has the longer production detail. [`DESIGN.md`](DESIGN.md) covers the UI, including font licensing.

AI assistance was used throughout. The claims above rest on tests and measurements in this repository, not on assertions.
