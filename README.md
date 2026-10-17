# clause

[![ci](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml/badge.svg)](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml)

**a redlining and search service for contracts.** point at exact text, stage changes, preview the redline, and apply them as a new version. search returns passages you can edit from. when a request is ambiguous, overlaps another change or was made against an old version, clause returns a precise error instead of guessing.

| open | what you'll see |
|---|---|
| **[live demo](https://clause-take-home.vercel.app/#/documents)** | the running app: open a sample contract, press **make a copy**, edit, run clause ci |
| **[walkthrough video (8:50)](https://clause-take-home.vercel.app/video)** | narrated tour with chapters, captions and a transcript |
| **[api reference](https://clause-take-home.vercel.app/api/docs/)** | interactive openapi reference, generated from the same schemas that validate requests |
| **[production design](INFRA.md)** | part ii, one page: measured numbers against targets, decisions by topic, risks |
| **[one-page pdf](output/pdf/CLAUSE-infrastructure.pdf)** | the same production design as a pdf |
| **[scope map](ASSESSMENT_SCOPE.md)** | each item in the brief mapped to the code and test that answer it; extras labelled |

[![clause ci on a proposed edit: 2 broken by this edit, exact checks 1 of 2, model-supported 3 of 4 (advisory)](docs/img/clause-ci.png)](https://clause-take-home.vercel.app/#/documents)
<sub>clause ci on a proposed edit to the sample nda: a protected passage was removed (exact check, no model involved), and the model flags that a notice obligation became optional (advisory). click to open the demo.</sub>

> the demo is a shared workspace with fictional contracts and no sign-in. the five sample contracts are read-only: use **make a copy** to edit one. don't put real contracts in it.

**on this page:** [where to look](#where-to-look) · [run it](#run-it) · [brief → implementation](#what-was-asked-and-where-it-is) · [api](#the-api-at-a-glance) · [design decisions](#design-decisions-and-trade-offs) · [performance](#performance) · [tests](#how-its-tested) · [clause ci and ai](#clause-ci-and-ai-suggestions) · [production](#production-design-part-ii) · [limits](#limits) · [repo map](#repository-map)

---

## where to look

| if you want to see… | open |
|---|---|
| how an edit is resolved and applied | [`packages/core/src/resolve.ts`](packages/core/src/resolve.ts), [`apply.ts`](packages/core/src/apply.ts): pure typescript, zero dependencies |
| how a write stays safe when two people edit | `commitRevision` in [`apps/api/src/store/sqlite.ts`](apps/api/src/store/sqlite.ts), and [`apps/api/test/concurrency.test.ts`](apps/api/test/concurrency.test.ts) |
| the api contract | [`apps/api/src/schemas.ts`](apps/api/src/schemas.ts) (validation and openapi from one source), [`errors.ts`](apps/api/src/errors.ts), [`routes/documents.ts`](apps/api/src/routes/documents.ts) |
| search | [`apps/api/src/search.ts`](apps/api/src/search.ts) |
| the tests | [`packages/core/test`](packages/core/test), [`apps/api/test`](apps/api/test), [`e2e/journeys.spec.ts`](e2e/journeys.spec.ts) |
| part ii | [`INFRA.md`](INFRA.md) (one page), with a longer [appendix](docs/INFRA_APPENDIX.md) |
| what is core and what is extra | [`ASSESSMENT_SCOPE.md`](ASSESSMENT_SCOPE.md) |
| what went wrong along the way | [`NOTES.md`](NOTES.md): every real bug, how it was found, what changed |

---

## run it

node 24.x and pnpm 10.33.0. there's no database server, no docker and no api key required.

```sh
pnpm install --frozen-lockfile
pnpm seed                 # five fictional contracts into a local sqlite file
pnpm dev                  # api on :3000, interactive openapi reference at /docs
pnpm dev:web              # ui on :5173, proxies /api to the api
./http/demo.sh            # curl walkthrough of the api (needs jq)
```

optional, in `.env.local` (copy `.env.example`): `OPENROUTER_API_KEY` turns on ai suggestions and ai-judged checks; `CLAUSE_STORAGE=postgres` with `DATABASE_URL` runs on postgres. without them, editing, search and the exact checks all work.

the api runs typescript directly under node's type stripping, so type checking is its own gate:

```sh
pnpm typecheck && pnpm lint && pnpm test:coverage
CLAUSE_TEST_DATABASE_URL=postgresql://… pnpm test:coverage   # the same suite on postgres (disposable database)
pnpm test:e2e             # real browser, desktop and 390 px phone, with accessibility checks
pnpm bench                # 10 mib benchmark;  pnpm load  for the concurrency check
```

---

## what was asked, and where it is

the brief, in my own words, with the part of the repo that answers each item.

| asked for | how clause does it | evidence |
|---|---|---|
| **edit a document** with a json change request and get the updated text back | `PATCH /documents/:id` with a `changes` array; each change targets a quote (with occurrence, prefix or suffix) or a position (with the text expected there). the response is a receipt with the full new text | [`packages/core/test`](packages/core/test), [`documents.test.ts`](apps/api/test/documents.test.ts) |
| **search** one or many documents for matching context | `GET /documents/search` and `GET /documents/:id/search`: ranked word search and literal exact search, with snippets and offsets you can edit from | [`search.test.ts`](apps/api/test/search.test.ts) |
| **tests** for change and search logic, including large files | unit, property and api tests on sqlite and postgres; a 10 mib benchmark; a load check | [how it's tested](#how-its-tested), [`bench/performance`](bench/performance/README.md) |
| **sample requests** | [`http/demo.sh`](http/demo.sh) (curl), plus the [openapi reference](https://clause-take-home.vercel.app/api/docs/) | |
| **readme** with setup, usage, performance and api rationale | this file | |
| correct **4xx/5xx** with a json `{ error, code }` body | one error shape for every response, including framework errors; a 500 never leaks a stack or document text | a forced-500 test, the weekly api fuzz |
| **bulk** changes | `changes` is an array of up to 5,000, applied all-or-nothing | `engine.test.ts`, `documents.test.ts` |
| **large documents**, near-linear | the new text is rebuilt in one pass; 7 ms for one edit on 10 mib. targets in large batches are found in one pass too (aho–corasick): 5,000 quote changes on 10 mib resolve in about 100 ms | [performance](#performance) |
| **concurrency** and repeated matches | `expectedVersion` or `If-Match`, then a compare-and-swap commit: a stale write gets 409 or 412. a quote that matches more than once is refused with every candidate listed | [`concurrency.test.ts`](apps/api/test/concurrency.test.ts), [`etag-race.test.ts`](apps/api/test/etag-race.test.ts) |
| **indexing**, and its trade-offs | inverted indexes inside the database (sqlite fts5 and trigram; postgres gin and pg_trgm), updated in the same transaction as the edit | [why not an in-memory inverted index](#why-not-an-in-memory-inverted-index) |
| **api design** rationale | resources for reads and writes, named actions where an action isn't a resource update | [design decisions](#design-decisions-and-trade-offs) |
| **part ii**: production design | [`INFRA.md`](INFRA.md): measured numbers against targets, a decision table by topic, the risks | [pdf](output/pdf/CLAUSE-infrastructure.pdf) |

built beyond the brief, and labelled as extras in [`ASSESSMENT_SCOPE.md`](ASSESSMENT_SCOPE.md): clause ci, ai suggestions, word tracked-changes export, the workspace ui (requests, playbooks, templates), the integrations demo, and the walkthrough video.

---

## the api at a glance

| method and path | what it does |
|---|---|
| `POST /documents` | create (201, `Location`, `ETag`) |
| `GET /documents` · `GET /documents/:id` | list (paged) · read; `If-None-Match` gives 304 |
| `PATCH /documents/:id` | apply a batch of changes; returns a receipt |
| `POST /documents/:id/changes/preview` | dry run through the same engine call; writes nothing |
| `POST /documents/:id/changes/check` | clause ci: check a proposed edit against saved requirements |
| `POST /documents/:id/revert` | restore an old version's text as a new version |
| `GET /documents/:id/revisions[/:version]` | history; one snapshot |
| `GET /documents/:id/export.docx?from&to` | word file with tracked changes between two versions |
| `GET /documents/search?q&mode=words\|exact` · `GET /documents/:id/search` | search everything · search one document |
| `POST /documents/:id/copy` · `DELETE /documents/:id` | copy (for the read-only samples) · delete |
| `…/requirements`, `/requests`, `/playbooks`, `/templates`, `/activity`, `/settings/status` | the workspace features ([reference](https://clause-take-home.vercel.app/api/docs/)) |

**an edit and its receipt:**

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
the response also carries `ETag: "v2-2454fa484923"`. send `Prefer: return=minimal` to get the receipt without `content` (on a 10 mib document, 10,486,119 bytes becomes 357).

**the same edit without `occurrence`** is refused, because the quote matches three passages:

```json
{ "error": "Target text matches 3 passages; add an occurrence, prefix or suffix", "code": 409, "type": "AMBIGUOUS_TARGET",
  "details": { "matchCount": 3, "candidates": [
    { "start": 1045, "end": 1066, "context": "…2.1 The Receiving Party shall not disclose…" },
    { "start": 1270, "end": 1291, "context": "…2.2 The Receiving Party shall take reasonable…" },
    { "start": 2239, "end": 2260, "context": "…the Receiving Party shall promptly return…" } ] } }
```

**targets.** a *quote* is literal, case-sensitive text, with an optional `occurrence`, `prefix` or `suffix`. a *position* is utf-16 offsets `[start, end)` plus the `expectedText` that must be there, so there are no blind writes by offset. offsets that would split a surrogate pair are refused. a delete is an empty replacement; an insert is a position where `start == end`.

**status codes.**

| code | meaning |
|---|---|
| 409 | the request is valid but the document's current state conflicts with it: stale `expectedVersion`, ambiguous quote, or text moved. re-read and retry |
| 412 | `If-Match` doesn't match the current etag |
| 422 | the request can never succeed as written: overlapping changes, target not found, bad range |
| 403 | shared sample, read-only (with a pointer to `/copy`) |
| 413 | larger than this deployment can index or export |
| 400 / 404 / 429 / 500 | invalid input (unknown keys refused) / not found / rate limited / server error |

every error body is `{ error, code, type, details? }`, with `code` as a number.

---

## design decisions and trade-offs

**1. a pure engine that refuses to guess.** all changes in a batch resolve against the same snapshot of the text. an ambiguous target, an overlap or two inserts at the same offset reject the whole batch. then the text is rebuilt in one forward pass. preview, commit, ai suggestions and clause ci all call the same function (`applyChanges`), so a preview and the commit can't disagree. *cost:* callers must be precise. the ui does that for you: it builds the shortest quote that resolves to exactly your selection (`selectorFor`) and checks it with the real resolver.

**2. compare-and-swap, not locks or merges.** a commit is `UPDATE … WHERE id = ? AND version = ?`. the new text, the search index and an immutable revision row land in one transaction, or nothing does. *why:* conflicts on one contract are rare, and people take minutes between reading and saving, so nothing should hold a lock across that. *cost:* the loser of a race re-validates, and the ui keeps their staged edits and re-checks them after reload. there is no automatic merge, because a merge of two lawyers' edits is new legal text that nobody approved.

**3. a response describes the operation it performed.** the etag on an edit or revert is built from that operation's receipt, never from re-reading the document afterwards. a re-read could pick up someone else's newer commit, or a delete. this was found in review and is pinned by a deterministic race test.

**4. rank first, build snippets second.** the first 10 mib search took 8,337 ms. the index lookup took about 0 ms; fts5's `snippet()` walks every match in the row, and i was building snippets for every matching document before paginating. now ranking happens alone, and snippets are built only for the returned page, with a bounded locator above 256 kib: 20 ms. *cost:* on very large documents the highlight is the first occurrence, not fts5's "best" window.

**5. every offset is verified.** a snippet once came from the wrong document: fts5 silently ignored `rowid = ?` next to `MATCH`, and the tests only checked the highlighted word. now the query filters on the joined document, the server re-finds each fragment in that document's own text before it attaches offsets, and the browser checks the version and the exact text again before selecting anything. search runs inside one read snapshot, so the ranking and the snippet come from the same version.

### why not an in-memory inverted index

the brief floats one. clause has inverted indexes, but they live in the database: fts5 for words and a trigram index for exact phrases on sqlite, gin indexes on postgres. they're updated in the same transaction as the edit, so a committed edit is searchable at once, and the database's page cache keeps the hot parts in memory. a second copy in memory wasn't built because the measurements pointed elsewhere. looking up a term was never slow (about 21 ms for a rare word and 25 ms for a common phrase on 10 mib). the 8.3 s was snippet generation, and of a roughly 790 ms edit, the engine is 7 ms. an in-memory index would speed up the step that was already fast, and costs a rebuild on every cold start, one copy per serverless instance, invalidation across instances, and memory. it pays off in one long-lived process answering many repeated queries on big documents. then i'd cache postings for hot terms keyed by `(query, version)`, so staleness is detectable.

**6. full snapshots per revision, for now.** every version stores its full text. restore and audit are trivially correct, and a restore is just a new version whose text equals an old one, so history only grows. *cost:* a frequently edited 10 mb document costs 10 mb per revision. the production design keeps snapshots in object storage, keyed by the sha-256 the service already computes, with a full copy every ~20 revisions and deltas between.

**7. resources plus named actions.** reads and writes are separate: gets never write, which is what makes caching by etag safe. edits are a `PATCH` on the document. things that aren't a resource update get a named sub-resource: `changes/preview` and `changes/check` compute without writing, `revert` names a version and the server derives the text, `copy` creates a derived document. *why:* a preview isn't a patch that happens not to save, and pretending it is would blur what changes state.

**8. one interface, two databases.** sqlite locally (nothing to install), postgres in production, both behind one `Store` interface, and the whole suite runs against each. that proves the interface describes the domain rather than one database's quirks. postgres uses a generated `tsvector` column, so its index can't drift from the text. its 500,000-character cap comes from the tsvector limit, and anything bigger is refused up front rather than stored unsearchable.

**9. ai proposes, the engine validates, a person applies.** a suggestion is at most five bounded quote replacements. it goes through a scope check, then the same engine validation as a human edit, then clause ci, and it comes back staged with `applied: false`. the document is treated as untrusted data in every prompt. each call has a 25 s deadline including queueing. if no ai provider is configured, editing, search and exact checks still work.

---

## performance

local measurements: apple m4, one process, sqlite, a seeded synthetic 10 mib contract ([`bench/run.ts`](bench/run.ts)). these are not hosted numbers.

| operation | measured |
|---|---|
| engine: one replacement in 10 mib · a 100-change batch | **7 ms** · 9 ms |
| full-stack edit, 10 mib | **789 ms**: index updates, the full snapshot and the response, not the engine |
| words search, 10 mib, rare · common term | **21 · 25 ms** (was 8,337 ms before the fix in decision 4) |
| exact search, 10 mib, unique · many hits | **16 · 52 ms** |
| a stale write refused, 10 mib | 409 in 14 ms |

concurrency check ([`scripts/load.ts`](scripts/load.ts), 1 mb documents, one process):

| p95 at 1 · 8 clients | measured | target | |
|---|---|---|---|
| read | 2 · 11 ms | 50 ms | met |
| words search | 2 · 173 ms | 300 ms | met |
| exact search | 5 · **435 ms** | 300 ms | **missed at 8** |
| edit | 61 · **879 ms** | 500 ms | **missed at 8**, throughput plateaus near 19 edits/s on one sqlite writer |

the same check on postgres at its hosted cap (`pnpm load 8 8 --storage=postgres`, 0.47 mb documents, warmed up, two runs, over http):

| p95 at 8 clients | measured | target | |
|---|---|---|---|
| read | 19–21 ms | 50 ms | met |
| words search | 129–158 ms | 300 ms | met |
| exact search | 240–246 ms | 300 ms | met |
| edit | 437–443 ms (27 edits/s) | 500 ms | met, with little headroom |

the misses in the sqlite table are written down rather than the targets moved, and postgres is a different story because its writers don't share one event loop. two cautions. laptop numbers swing about 2× with background load (the sqlite edit p95 was 1.8–2.4 s on a busy afternoon), so read them as ranges. and a freshly loaded postgres database was far slower for its first seconds (words search p95 4.4 s), which is why the tool now warms up before it measures. hosted postgres caps documents at 500,000 characters, so the 10 mib figures are sqlite only, and the 1 mib edit target can't be tested on postgres until the cap is lifted (that needs chunked indexes, see [`INFRA.md`](INFRA.md)). paired reruns and raw logs: [`bench/performance`](bench/performance/README.md).

---

## how it's tested

| layer | what | where |
|---|---|---|
| engine | unit tests and property tests (fast-check, fixed seed, 500 runs) | [`packages/core/test`](packages/core/test) |
| api | the full suite is 379 tests on sqlite and 384 on postgres, including two real connections racing on one version, a writer injected between commit and response, provider timeouts and cancellation | [`apps/api/test`](apps/api/test) |
| browser | 10 playwright journeys on desktop and a 390 px phone, with axe accessibility checks after each step | [`e2e/journeys.spec.ts`](e2e/journeys.spec.ts) |
| mutation | flip one operator at a time in the engine and see whether a test notices: 65 of 70 killed; the 5 survivors are equivalent | `pnpm mutate`, [`scripts/mutate.ts`](scripts/mutate.ts) |
| fuzzing | schemathesis against the openapi spec, seeded, weekly in ci; its first run found five bugs the hand-written tests had missed | [`scripts/fuzz`](scripts/fuzz) |

ci runs on every pr: typecheck, lint, tests with coverage floors on node 24 and 26, the full suite on postgres 16, browser journeys, and a production dependency audit. actions are pinned to commit shas. coverage floors: engine 98% lines / 95% branches; api 90% / 78%; postgres store 90% / 80%. package versions younger than three days can't be installed.

---

## clause ci and ai suggestions

**clause ci** checks a proposed edit against requirements saved on the document, before and after, and reports a delta for each: *held*, *broken by this edit*, *newly satisfied*, *still failing* or *uncertain*.
- **exact checks** use no model: must contain, must not contain, keep this passage verbatim. a broken verbatim rule names the change that broke it.
- **statement checks** are judged by a model. a pass needs a quote found verbatim in the document; judges that disagree, or a pass with no verifiable quote, become *needs review*. timeouts become *unavailable*, never a pass. these results are advisory and labelled that way.
- every result says how it was decided: `method: exact | model`, plus which judges answered.

it informs and the person decides; it doesn't block an edit. it was measured on contractnli before being trusted: [`bench/ci/RESULTS.md`](bench/ci/RESULTS.md) (cases frozen before any judge ran; sonnet 5.5 at 80% three-way accuracy vs a 40% keyword baseline on 60 ndas; 22 of 28 evidence-deleting edits flagged, none of 28 harmless ones). a separate [citation experiment](bench/citations/RESULTS.md) tests whether quotes support claims. neither establishes legal reliability.

**ai suggestions** are covered in design decision 9. the caps are 4,000 output tokens, five edits, 2,000 characters per target or replacement, and a 400-character rationale. oversized proposals are refused, not truncated. a timeout is `504 AI_TIMEOUT`.

---

## production design (part ii)

[`INFRA.md`](INFRA.md) is one page, every number tagged *measured*, *target* or *untested*. in short:
- **shape:** cdn and waf with sso in front of at least two stateless api replicas; postgres as the source of truth with the same compare-and-swap; object storage for snapshots; redis only for rate limits and hot search pages; a queue and workers for indexing, imports and ai.
- **scale:** chunked per-paragraph indexes, per-document row locks, replicas, then partitioning. each step is triggered by a measured problem, not added up front.
- **security:** oidc/saml, `tenant_id` plus postgres row-level security, per-tenant keys, and an audit log of hashes, never contract text.
- **operations:** latency by document size, conflict rate, index lag and ai cost per tenant; expand-and-contract migrations; progressive rollout.
- **risks, stated:** postgres untested at size, two missed p95 targets, no tenancy yet.

today it runs on vercel (web and api as one project) with neon postgres.

---

## limits

- no tenancy, sign-in or confidential audit trail on the demo, and no production security claim.
- full snapshots and full-text edit responses scale poorly for large documents (decision 6; `return=minimal` helps).
- rate limits and the verdict cache are per process, not per tenant.
- semantic checks are advisory. a verified quote proves the words exist, not that they support the conclusion.
- word exports pass xml and pandoc accept/reject checks; not every microsoft word version was tested.
- the integrations page runs on sample files. the real connectors exist and are tested with stubbed providers, but need oauth credentials the demo doesn't have.

---

## repository map

```text
packages/core     the edit engine: resolve, apply, anchor, exact requirement checks (no dependencies)
apps/api          fastify + zod api: routes, document service, storage (sqlite, postgres), search, clause ci, ai, word export
apps/web          react 19 + vite workspace ui
e2e/              playwright journeys
bench/            10 mib benchmark, contractnli judge benchmark, citation experiment
scripts/          load check, mutation harness, fuzz runner, smoke tests
http/demo.sh      curl walkthrough
fixtures/         the five fictional sample contracts
```

**further reading:** [`ASSESSMENT_SCOPE.md`](ASSESSMENT_SCOPE.md) maps the brief to code and labels the extras. [`NOTES.md`](NOTES.md) is the running dev log of real findings. [`docs/INFRA_APPENDIX.md`](docs/INFRA_APPENDIX.md) has the longer production detail. [`DESIGN.md`](DESIGN.md) covers the ui, including font licensing.

ai assistance was used throughout. the claims above rest on tests and measurements in this repository, not on assertions.
