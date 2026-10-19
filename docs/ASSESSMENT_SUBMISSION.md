---
title: "CLAUSE | Full-Stack Engineering Assessment"
subtitle: "Take-home implementation, infrastructure design, and live discussion guide"
author: "Confidential interview submission"
date: "October 19, 2026"
lang: en-US
geometry: margin=0.72in
fontsize: 10pt
mainfont: Arial
monofont: Menlo
colorlinks: true
linkcolor: blue
urlcolor: blue
---

\thispagestyle{empty}
\vspace*{1.0in}

**FULL-STACK ENGINEERING ASSESSMENT**

# CLAUSE

## Contract editing, redlining, and search

\vspace{0.3in}

**A reviewable implementation and evidence-led design response**

Take-home build · Infrastructure assessment · Live discussion preparation

\vspace{0.45in}

**Prepared:** October 19, 2026

**Demo:** [clause-take-home.vercel.app](https://clause-take-home.vercel.app/#/documents)

**Repository:** [olanotolu/clause-take-home](https://github.com/olanotolu/clause-take-home)

\vspace{0.45in}

> CLAUSE is a shared, fictional-data demonstration. It is not a secure workspace for real contracts. This submission distinguishes implemented behavior, measured results, design targets, and remaining verification work.

\vfill

**Confidential interview material**

AI tools were used during implementation and drafting. The design choices, code, measurements, and limitations are documented in the repository and are intended to be explained directly in the live discussion.

\newpage

\tableofcontents
\newpage

# Executive summary

CLAUSE is a full-stack contract editing and search service. A reviewer selects exact language, stages a replacement, previews the redline, checks the request against the current document version, and commits a new immutable revision. Search returns ranked snippets with source offsets that can be used to stage a change. The core is deliberately conservative: ambiguous matches, overlapping edits, stale versions, and invalid ranges fail with specific errors instead of silently choosing an interpretation.

The take-home core is implemented in a dependency-free TypeScript engine, exposed through a Fastify API with schemas that drive both validation and OpenAPI, and exercised through unit, property, API, database, and browser tests. The app includes the requested change and search behavior, plus bounded bulk edits, ETags, persistent search indexes, large-document transfer, a document UI, and representative fictional contracts.

The repository also contains optional product and operations extensions: Clause CI, advisory AI suggestions, Word tracked-changes export, playbooks, templates, provider adapters, durable jobs, private Blob storage, OpenTelemetry, and migration/recovery commands. These are clearly separable from the assessed core. They should not be mistaken for proof that the shared demo is ready to process customer contracts.

## Results at a glance

| Area | Evidence | Status and boundary |
|---|---|---|
| Exact edits | Quote or UTF-16 range targets; atomic batches; stale writes return conflict | Implemented and tested on SQLite and Postgres |
| Search | Word search and literal exact search; indexed candidates; snippets and offsets | Implemented; search equivalence tests cover phrase and ranking behavior |
| Large documents | 1 MiB inline threshold; private immutable Blob path above it; 25 MiB UTF-8 ceiling | 1, 10, and 25 MiB functional flows verified; concurrent 25 MiB load not claimed |
| 8-client hosted p95 | Metadata 51.7 ms; search 164.8 ms; separate-document edit 470.7 ms | Meets existing 100 / 300 / 500 ms targets on the measured Preview run |
| Postgres search change | 400 KB local Postgres word-search p95 moved from 1,625.5 to 102.8 ms | Matched diagnostic run on a heavily loaded laptop; not a capacity claim |
| Production isolation | Open shared demo, fictional fixtures | Authentication and tenant isolation are intentionally outside this build |
| Current Preview placement | Vercel Function `cle1`; Neon primary `us-east-2` | Region aligned after the hosted matrix; post-move matrix still required |
| Hosted telemetry | Local authenticated OTLP delivery verified | Hosted collector endpoint and credentials were not supplied, so hosted delivery remains unverified |

## How to evaluate this submission

1. Start with the editing and search contract in Part I; these are the brief's central behaviors.
2. Use the evidence section to distinguish correctness, performance, and operational claims.
3. Read the one-page Part II design as the production proposal. The following notes explain why its trade-offs fit this prototype.
4. Use Part III for the walkthrough and collaborative coding discussion. The prompt for that live exercise is not known in advance, so the guide focuses on a repeatable problem-solving method rather than pretending to supply a solution to an unseen task.

\newpage

# Part I — Take-home app build

## Product behavior

The main flow is deliberately easy to demonstrate:

1. Open one of the fictional sample agreements or create a document.
2. Search across documents or within one document. Results show the relevant words or literal passage in context.
3. Select a passage or a search hit. The UI constructs a precise target and stages the replacement.
4. Preview the result and inspect inserted/deleted text before writing.
5. Commit against the version that was reviewed. On success, CLAUSE records a new revision and returns the committed spans and hashes.
6. Revert by creating another revision from an earlier snapshot; the history is not rewritten.

The document surface uses CodeMirror as a read-only text view. Selection, hit highlighting, evidence navigation, and redline insertions/deletions are decorations. Editing remains in the staged-change flow so the exact change request is explicit and reviewable. The web worker handles indexing, hashes, counts, and text transformations; stale worker responses are discarded.

## API contract

The API separates document resources from actions that have distinct semantics. Reads use `GET`; a batch edit uses `PATCH`; preview is a non-writing action; revert creates a new revision; search is a query resource; and upload intent/completion make the large-body transfer lifecycle explicit.

```http
PATCH /documents/{id}
If-Match: "v7-<hash>"
Content-Type: application/json

{
  "expectedVersion": 7,
  "changes": [
    {
      "operation": "replace",
      "target": {
        "quote": { "exact": "Receiving Party shall", "occurrence": 2 }
      },
      "replacement": "Recipient shall"
    }
  ]
}
```

A successful write returns a receipt with the previous and committed versions, before/after hashes, exact applied spans, and (for inline-sized documents) the resulting body. `Prefer: return=minimal` omits the body. The ETag identifies the committed version. Large bodies use an immutable content reference and short-lived signed URL; they do not travel through the Function JSON response.

```json
{
  "id": "doc_…",
  "previousVersion": 7,
  "version": 8,
  "changed": true,
  "beforeHash": "…",
  "afterHash": "…",
  "applied": [
    { "index": 0, "start": 1270, "end": 1291,
      "before": "Receiving Party shall", "after": "Recipient shall",
      "newStart": 1270, "newEnd": 1285 }
  ]
}
```

Search supports ranked word queries and literal exact queries. Exact matches are case-sensitive and non-overlapping, ranked by occurrence count, then title for ties. Both return document version, bounded snippets, and source offsets. An offset can be fed back into a position-target change with its expected text, so the write still checks that the passage has not moved.

```http
GET /documents/search?q=limitation%20of%20liability&mode=words&limit=10&offset=0
GET /documents/search?q=Confidential%20Information&mode=exact&limit=10&offset=0
GET /documents/{id}/search?q=termination&mode=words
```

The same Zod schemas validate input and produce the OpenAPI reference. Errors share a JSON shape and carry a meaningful HTTP status: malformed input is 400/422; missing documents are 404; ambiguity or stale state is 409; an ETag mismatch is 412; rate limiting is 429; and unexpected server failures are 500 without returning stack traces or contract text.

## Edit-engine invariants

The core package is pure TypeScript with no runtime dependencies. Resolution and application are separate operations. Every target in a batch is resolved against the same original document snapshot; edits are sorted and checked for overlap; then the result is rebuilt in one forward pass. A failure rejects the entire batch.

- **Quote target:** exact, case-sensitive literal text, optionally disambiguated by occurrence, prefix, or suffix. If more than one candidate remains, CLAUSE returns candidate contexts rather than selecting one.
- **Position target:** UTF-16 code-unit offsets `[start, end)` plus `expectedText`. A mismatch fails, and a range that splits a UTF-16 surrogate pair is rejected.
- **Repeated matches:** raw matches are counted non-overlapping and left-to-right. The caller can choose an occurrence; the engine does not infer intent.
- **Batch semantics:** all changes are checked before any output is committed. Overlapping ranges or duplicate inserts at one location fail atomically.
- **Preview consistency:** preview and commit invoke the same edit engine. The user sees the same resolved spans that the write will apply.
- **Revision semantics:** writes append a version. Revert is also a new version, preserving the audit history and prior content references.

These rules trade convenience for predictable contract changes. For legal text, a refusal with a useful explanation is safer than a best-effort edit that might alter the wrong clause.

## Persistence, concurrency, and search

SQLite is the local default; Postgres is the hosted store. Both implement the same store contract. For a write, the metadata version/hash check, immutable revision reference, body reference, and search chunks change together. A compare-and-swap update (`WHERE id = ? AND version = ?`) is the final concurrency guard. Two editors can read the same version, but at most one commits against it; the other receives a conflict and must review the latest document.

The database stores document metadata, revision metadata, content references, and search indexes. Bodies up to 1 MiB remain inline. Larger versions are private immutable Blob objects addressed by content hash; local development uses filesystem storage. A signed upload intent is bound to a server-chosen path, operation, expected size, hash, version, and expiry. Completion verifies the uploaded object before committing the reference. A failed or conflicting write can leave an unreferenced object, which is cleaned up only after checking committed references and active jobs.

Search indexes paragraph chunks in the same write transaction as the revision. Postgres uses GIN search vectors over bounded chunks rather than a whole-document `tsvector`; this avoids the size ceiling and lets search rank candidates in SQL. Exact search uses indexed candidates then verifies literal, case-sensitive occurrences against document content. Only the chosen result page receives snippet windows. SQLite uses FTS5 and trigram-backed candidate filtering. The indexes make repeated search efficient while preserving search correctness from original text and offsets.

An in-memory-only inverted index was not selected as the source of truth: it would need replication, warmup, invalidation, and consistency handling across ephemeral function instances. The durable database index is transactionally updated with a revision. A separate cache can be added later for measured hot reads, but it is not required for correctness.

## Large-document path

Large bodies need a different data path because function request/response payloads and repeated whole-body loads become bottlenecks. The API keeps metadata and receipts small, while immutable content moves directly between the browser and Blob through time-limited signed URLs.

1. **Create/edit:** the API authorizes an upload intent and fixes object path, maximum bytes, version, and expiry. The browser uploads directly. Completion verifies size and digest, then commits the content reference with the database CAS.
2. **Read/revision:** metadata identifies a precise immutable revision. The API returns a signed URL pinned to that reference; the browser checks the downloaded bytes against the expected digest before attaching them to editor state.
3. **Edit after download:** the client applies committed spans locally when its base version and hash are available, then verifies the result in the worker. It downloads the body again only when the local base or verification is unavailable.
4. **Search:** indexed matches and snippets are bounded. The API does not return the candidate corpus to Node.
5. **Export:** small Word exports are synchronous. Large exports are queued; the completed file is stored as a temporary Blob object and a fresh signed URL is returned when requested.

The hard ceiling is 25 MiB of UTF-8 content. Metadata retains byte length, UTF-16 length, word count, hash, version, and content reference. This avoids mixing byte indexes with JavaScript string offsets and makes the input-size boundary explicit.

## Jobs and operations

Large exports, provider imports, backfills, integrity sweeps, and orphan cleanup use durable Workflow jobs. Job payloads carry immutable references, not document text. Job records report `queued`, `running`, `succeeded`, `failed`, or `cancelled`; idempotency keys protect retries and duplicate delivery. The shared policy caps expensive work at two concurrent jobs and 100 queued jobs, retries transient errors up to three times, expires export objects after 24 hours, and prevents a cancelled job from committing later state.

Database schema migration, content backfill, integrity verification, and body pruning are distinct operations. Backfill is resumable and bounded; hashes and history remain unchanged. Reads switch only after objects are verified. Duplicate inline bodies can be pruned only after a recovery manifest is verified and a restore rehearsal has succeeded. Request startup checks connectivity and schema version; it does not run a backfill. `/health` answers liveness, while `/ready` checks database/schema readiness.

## Verification evidence

The repository has a layered test strategy. The pure engine has unit and property tests, with deterministic randomized cases. API tests cover edits, search, errors, limits, imports, revisions, Blob flows, recovery, and jobs. SQLite and Postgres run the API suite independently against isolated stores. Browser journeys cover desktop and a 390-pixel mobile viewport with accessibility checks. The repository also has mutation testing and a weekly seeded OpenAPI fuzz job.

Recorded broad suite results before the final hosted tuning were 441 SQLite tests and 449 Postgres tests, with the documented skipped cases. The latest final tuning also passed 57 focused SQLite document/search tests, two focused Postgres conditional-read/chunk tests, and three telemetry tests. Typecheck, lint, API/web deployment build, and `git diff --check` passed. Eighteen desktop/mobile browser journeys and the Workflow smoke test passed earlier in this implementation cycle.

The large-document functional suite covers 1, 10, and 25 MiB, including direct upload, content verification, edit, preview, revert, search, and export. Single-run hosted checks at 10 and 25 MiB verified each of five signed downloads against byte length and SHA-256. These samples validate the content path; five reads are too few to establish stable tail latency.

\newpage

# Part I — Performance and AI evidence

## Hosted load results

The final measured matrix used a Vercel build-machine generator in `iad1`, Node 24.21.0, k6 2.3.0, 32 fictional 1 MiB documents, and up to 100 attempted edits per write scenario. All 15 scenarios completed with zero HTTP failures or 5xx responses. Times below are milliseconds in `p50 / p90 / p95 / p99` order.

| Clients | Metadata | Word search | Separate-document edit |
|---:|---:|---:|---:|
| 1 | 25.8 / 39.5 / 45.6 / 90.5 | 47.5 / 63.0 / 67.3 / 87.6 | 216.5 / 335.9 / 368.8 / 418.2 |
| 8 | 25.5 / 40.2 / 51.7 / 142.9 | 117.8 / 151.7 / 164.8 / 226.6 | 263.3 / 415.1 / 470.7 / 531.3 |
| 32 | 26.0 / 43.0 / 65.4 / 2,171.5 | 265.4 / 723.8 / 899.1 / 1,385.8 | 402.2 / 578.2 / 621.9 / 658.3 |

The existing 8-client p95 targets are metadata below 100 ms, search below 300 ms, and an ordinary separate-document edit below 500 ms. The measured run passed all three: 51.7, 164.8, and 470.7 ms respectively. Mixed traffic at eight clients measured 71.3 ms metadata, 148.1 ms search, and 418.7 ms edit p95. Same-document contention is reported separately: 13/100 commits at eight clients and 4/100 at 32; other attempts lost the expected compare-and-swap race rather than failing over HTTP.

The 32-client run is stress evidence, not a new gate. Its word-search p95 was 899.1 ms and edit p95 was 621.9 ms. Metadata p99 was 2.17 seconds, showing a tail outlier. The database is on Neon free tier; no paid-tier or production capacity conclusion follows from these numbers.

## What changed and what the comparison supports

The query plan showed that the Postgres word-search path repeated a primary-key lookup for candidate chunks after the GIN match. The implementation now carries the matching vectors through scoring and fetches full chunk text only for snippets in the selected result page. In the matched local Postgres run on 400 KB documents, eight-client search p95 moved from 1,625.5 to 102.8 ms (93.7% lower). That Mac was heavily loaded, so this is diagnostic evidence, not a capacity claim.

The hosted edit trace showed redundant document reads before a write. The API now uses one conditional query to load a body only when the expected version and hash match, and reuses the verified base body to update chunk identities. The nearby hosted run moved edit p95 from 539.2 to 470.7 ms, a 12.7% reduction. Search p95 moved from 193.1 to 164.8 ms; metadata p95 moved from 48.8 to 51.7 ms. These are comparable nearby Preview runs, but they are not an A/B test on one live function instance.

There was no recorded hosted p90 or p99 for the pre-change commit. Do not infer historical percentiles. The October 19 matrix did record p50/p90/p95/p99 for both its initial and updated nearby runs. Raw data, scenario summaries, and the query plan are in `bench/performance/results/2026-10-19/`.

## Region correction and interpretation

The hosted matrix above ran before the final Preview region correction. Preview’s database was moved from an unavailable, quota-limited Neon project to a fresh Neon project in AWS `us-east-2`. The API then moved to Vercel `cle1`, which is also AWS `us-east-2`; the Vercel configuration selects `cle1` only for Preview and keeps Production/local builds in `iad1`. The clean Preview API returned healthy/readiness status and diagnostics confirmed its runtime region as `cle1`.

The full 1/8/32 matrix has not been rerun after that move. The build runner needs the Preview protection bypass secret, which was not available in the final environment. Therefore the 8-client pass above describes the preceding `iad1` Preview deployment. A new matrix is a rollout gate before using the numbers to claim latency for the aligned `cle1` deployment.

## AI evaluation: useful evidence, narrow claim

Clause CI runs deterministic checks without a model for rules such as “must contain,” “must not contain,” and “keep this passage verbatim.” Model checks are advisory. A model PASS requires a quote that can be found verbatim in the document; an unsupported quote, disagreement, timeout, or provider failure becomes review/unavailable rather than a pass. This validates quote existence, not legal entailment.

The frozen evaluation uses contract-level held-out data and keeps the dev-tuned keyword baseline separate from evaluation. On 60 balanced ContractNLI test examples, `anthropic/claude-sonnet-5.5` reached 80.0% three-way accuracy (48/60; 95% Wilson interval 68.2–88.2%) versus 40.0% (24/60; 28.6–52.6%) for the keyword baseline. On 30 evidence-removal/control pairs, the model flagged 22/28 usable evidence-deleting edits (78.6%; 60.5–89.8%) and wrongly flagged 0/28 harmless edits (0%; upper 95% bound 12.1%). Four model calls errored; timeouts and errors were not scored as passes.

The frozen CUAD sample spans the dataset’s 41 clause categories. The keyword baseline attempted 72/72 cases and scored 58.3% accuracy (42/72; 46.8–69.0%) with a 43.6% false-PASS rate on annotated-absent examples (17/39; 29.3–59.0%). The model attempted only 4/72 due provider access/credit restrictions; its 50% accuracy estimate has a very wide interval and must not be generalized. Category samples are tiny (usually one or two examples), so per-category scores are descriptive only. The raw report records the category values and intervals rather than hiding them.

Quote integrity for model responses was 100% of verified quoted evidence (191/191; 95% interval 98.0–100%). Model-call latency was 2.4 seconds p50 and 5.0 seconds p95 per answered call, with 600,726 input and 32,145 output tokens and estimated cost of $1.52 for the recorded run. These results are offline benchmark evidence, not a production SLA. The exact model identifier is recorded; live paid-provider comparisons remain outside routine CI.

\newpage

# Part II — Production design (one-page deliverable)

**Goal.** Turn the shared fictional-data demo into a dependable contract service without losing an edit, sending large bodies through Function payloads, or presenting model output as legal judgment. The demo remains open and uses fictional material only. Preview currently uses Vercel, Fastify, Neon Postgres, private Vercel Blob, and durable Workflow jobs; verify Production's database region before rollout.

**Architecture.** Browser -> CDN/WAF -> stateless API -> Postgres (metadata, revisions, chunk indexes) and private Blob (immutable bodies, signed direct transfer). Durable jobs handle exports, imports, backfills, integrity checks, and cleanup. An LLM gateway may provide advisory checks. Postgres is authoritative for versions and indexes. Bodies up to 1 MiB may stay inline; larger bodies move directly to Blob, capped at 25 MiB UTF-8. One CAS transaction advances metadata, revision reference, and search chunks. Search ranks indexed candidates in SQL and returns bounded snippets.

**Security and compliance.** Before accepting customer contracts, add OIDC/SAML sign-in, tenant authorization on every resource, and Postgres row-level security. Require verified TLS, encryption at rest, least-privilege roles, short-lived signed URLs, and redacted logs. Audit actor, action, version, and hashes; exclude contract text and raw IDs from telemetry. Implement and test retention, export, and deletion across Postgres, Blob, caches, jobs, and backup expiry. Architecture alone does not establish SOC 2 or GDPR compliance; controls, evidence, vendor review, and incident procedures are required.

**Delivery, resilience, and cost.** CI gates typecheck, lint, coverage, SQLite/Postgres, browser/accessibility, dependencies, and seeded API fuzzing. Roll out additive schema first; backfill resumably; verify Blob hashes; switch reads; rehearse restoration; prune duplicates last. Use Preview canaries and readiness checks; keep data movement out of request startup. Scale stateless API, cap DB connections and job concurrency, preserve single-region CAS writes, use PITR and a verified content manifest, and expire exports after 24 hours. Add replicas, regional cells, or multi-region writes only when measurements or residency require them.

**Observability and gates.** Export OTLP route/SQL latency and errors, pool waits/locks, Blob bytes/latency, event-loop delay, queue age, AI latency/tokens/cost, and web vitals. Keep labels free of text, user IDs, document IDs, and signed URLs. Initial alerts: readiness failing for 2 minutes, 5xx above 2% for 5 minutes, queue age above 5 minutes, or pool saturation. Hosted OTLP still needs an endpoint and secret. Existing 8-client p95 goals are metadata <100 ms, search <300 ms, and a 1 MiB edit <500 ms; the preceding `iad1` run measured 51.7 / 164.8 / 470.7 ms. Rerun from aligned `cle1` before treating those goals as verified for the new placement. These are prototype gates, not availability or capacity guarantees.

\newpage

# Part II — Design rationale and rollout

## Why this shape

**Keep the database authoritative for version state.** A document edit is a transactional event: expected version, new revision reference, metadata, and search index all advance or none do. Immutable body objects make signed transfer and content-addressed verification practical. The cost is a cross-store lifecycle; orphan cleanup and a verified recovery manifest are mandatory, not optional housekeeping.

**Use a direct content path for large text.** A Function should authorize a bounded upload and verify completion, not relay 25 MiB in both directions. Pin every signed URL to one revision rather than resolving a stale metadata response through the mutable current pointer. The browser verifies hashes before display and caches immutable bodies by version and hash with a strict memory limit.

**Make expensive work durable and bounded.** Job records survive a function instance ending. Idempotency keys and immutable references make retry safe. Two concurrent expensive jobs and 100 queued jobs are conservative starting caps; raise them only after measuring database, Blob, and function saturation. A cancellation check must guard the final commit, not only the worker loop.

**Preserve one-region writes first.** Multi-region reads can be considered after tenant boundaries and freshness guarantees are explicit. Active-active writes would complicate version ordering and auditability. Place the function near the actual database, then benchmark; do not infer the winner from geography alone.

## Security model to add before customer use

The demo has no sign-in, tenant isolation, or confidential audit trail by design. For a customer product, the principal identity must be authenticated and mapped to an authorized tenant before any document lookup. The tenant identifier must be part of every primary key/index path and enforced in the database as well as application code. Separate roles for the API, migration runner, and background workers. Use a dedicated tenant-aware rate limit, signed uploads bound to tenant/document/version/operation/expiry, and an audit event for every read/export/edit/admin action according to policy.

Retention and erasure need to cover relational rows, immutable Blob versions, caches, exports, backups, and job payloads. A deletion request needs an auditable state machine and an explicit backup-expiry policy. Avoid storing contract text in logs, traces, metric labels, error reports, or AI prompts beyond the reviewed product purpose. Use a provider allowlist and customer-configurable AI policy before enabling model-based evaluation on sensitive agreements.

## Rollout sequence

1. **Local and CI:** schema compatibility, bounded writes, both stores, large-document boundary, deterministic search equivalence, job retry/cancel, browser journeys, telemetry label tests.
2. **Preview additive schema:** apply schema changes without removing old columns; confirm `/health` and `/ready`; keep request startup free of data movement.
3. **Backfill and verify:** run bounded resumable jobs; persist checkpoints; compare byte lengths and hashes for every object; test restart and missing/corrupt object recovery.
4. **Canary readers:** switch a Preview cohort to immutable content references; test concurrent version changes and expired signed URLs. Keep old bodies during the compatibility period.
5. **Capacity and telemetry:** execute the post-`cle1` matrix, deploy authenticated OTLP, inspect labels, and verify alerts by deliberately making readiness fail in an isolated environment.
6. **Recovery rehearsal and prune:** reconstruct from the verified manifest; only then remove duplicate database bodies. Record the person, time, manifest, and restoration result.
7. **Production promotion:** only after tenant/auth controls and operational sign-off exist. This implementation did not promote Production or alter its environment.

## Starter SLOs and alert interpretation

| Signal | Starting threshold | Response |
|---|---|---|
| API 5xx | >2% for 5 minutes | Check route, DB and provider error rates; rollback if correlated with deployment |
| Readiness | Fails for 2 minutes | Stop rollout; inspect schema, connection acquisition, and primary availability |
| Pool wait | p95 >100 ms for 5 minutes | Check connection leaks, statement duration, and pool sizing before raising max connections |
| Job queue age | Oldest queued job >5 minutes | Inspect concurrency caps, retry loops, provider latency, and backlog growth |
| Search latency | p95 >300 ms at 8-client representative load | Capture sanitized query plan and fixture profile; preserve relevance and exact semantics |
| Edit latency | p95 >500 ms for normal 1 MiB edits | Separate API time, Blob time, pool wait, CAS conflict, and network overhead |
| Content integrity | Any hash mismatch | Stop serving affected reference, alert, restore from verified source, preserve forensic evidence |

Thresholds are initial operational guardrails, not contractual availability commitments. Tune from representative customer traffic and agreed product SLOs.

\newpage

# Part III — Live discussion plan

The live exercise is interactive and its exact prompt is intentionally unknown. The goal is to make reasoning visible, keep communication clear, and reach a correct implementation before pursuing clever optimizations.

## Ten-minute app walkthrough

**Minute 0–1: state the product boundary.** “This is a shared demo with fictional documents. It demonstrates precise edits, version safety, search, and large-content handling; it is not ready for real contracts because it has no tenant isolation or sign-in.”

**Minutes 1–4: show the user flow.** Open a fictional NDA, select a sentence, stage a replacement, preview the redline, and apply it. Show the new revision and a stale update conflict. Explain why all changes are resolved against one snapshot and why the API refuses ambiguity.

**Minutes 4–6: show search.** Search for a word phrase, navigate to a hit, then run a literal query. Explain that indexed candidates are ranked before snippets are materialized and that returned offsets are tied to a document version.

**Minutes 6–8: explain the implementation boundary.** Point to the pure engine, schemas/routes, store CAS method, search adapter, and CodeMirror view. Mention what the tests establish and what they do not.

**Minutes 8–10: show one large-document path or evidence artifact.** Describe the 1 MiB inline cutoff, signed Blob transfer, hash verification, and 25 MiB limit. Use the raw hosted report for measured evidence and state that the post-region-change matrix remains open.

## Ten-minute infrastructure discussion

Lead with the one-page Part II. Be ready to discuss:

- Why Postgres remains authoritative for versions and search freshness.
- Why the browser transfers large content directly to private Blob.
- How CAS and immutable revision references handle concurrent edits.
- Why jobs are idempotent and have explicit queue/concurrency bounds.
- What must be added before customer data: authentication, tenant authorization, row-level security, audit, retention, and deletion controls.
- Why the 32-client search tail and missing hosted OTLP verification remain open rather than being hidden behind average latency.
- Which scale changes are evidence-triggered: more pool/compute headroom, partitioning, caches, regional cells, or replicas.

## Collaborative coding method

1. Read the prompt aloud in my own words and confirm input, output, mutation rules, constraints, and edge cases.
2. Ask only questions that change the algorithm. If a detail is unspecified, state a reasonable assumption and make it easy to revise.
3. Name the simplest correct solution and its time/space costs before coding.
4. Identify an invariant and use it to structure the implementation.
5. Test a smallest case, a boundary case, a repeated-value/duplicate case, and a case that challenges the invariant.
6. Improve complexity only after the correct version is clear; explain the trade-off and re-run the examples.
7. Finish by summarizing correctness, complexity, and what additional test or production guard would be appropriate.

## Example discussion problem: remove two vertices from a tree

If the discussion uses the style of Codeforces 2063C, the graph problem is to remove exactly two vertices from a tree and maximize the number of remaining connected components. A useful invariant is that deleting a vertex from a forest increases the component count by `degree_in_forest - 1` (unless no vertices remain, which the tiny-tree case handles explicitly).

For a pair `(u, v)`, the result is `degree[u] + degree[v] - 1` when they are non-adjacent, and `degree[u] + degree[v] - 2` when they share an edge. A direct pair scan is correct but O(n^2). For each `u`, temporarily remove `u` and all its neighbors from a multiset of degrees. The maximum remaining degree gives the best non-neighbor candidate; evaluate neighbors directly with the adjacent formula; then restore the removed degrees. Each tree edge is processed a constant number of times, so the total is O(n log n) with a multiset and O(n) additional space. Confirm the `n=2` case returns zero.

This is an illustration of the method, not a substitute for reading the actual live prompt. If the prompt differs, derive its invariant from the stated operation and constraints instead of forcing a memorized pattern.

## Questions worth asking in the discussion

- Which failure mode matters most for the first customer: a lost edit, a slow search, a cross-tenant disclosure, or an unavailable export?
- Are users allowed to edit the same document concurrently, and what user experience should a conflict produce?
- What are the expected document-size distribution, search fanout, and read/write ratio?
- Does the product require residency boundaries, customer-managed keys, or a specific retention policy?
- Which checks may be advisory, and which must be deterministic or block a commit?
- What would the team want measured before increasing capacity or changing the database topology?

\newpage

# Submission guide and repository map

## Running the project

Requirements: Node 24.x and pnpm 10.33.0. No external database, Docker, or API key is needed for local SQLite use.

```sh
pnpm install --frozen-lockfile
pnpm seed
pnpm dev          # API on :3000; OpenAPI reference at /docs
pnpm dev:web      # web UI on :5173; proxies /api to the API
./http/demo.sh    # curl walkthrough; requires jq
```

Useful verification commands:

```sh
pnpm typecheck
pnpm lint
pnpm test:coverage
CLAUSE_TEST_DATABASE_URL=postgresql://... pnpm test:coverage
pnpm test:e2e
pnpm bench
```

Hosted benchmarks require a disposable Preview workspace, protected-deployment access, and cleanup of the created fictional fixtures. Never point a benchmark at Production.

## Where to look in the code

| Concern | Source of truth |
|---|---|
| Edit resolution and application | `packages/core/src/resolve.ts`, `packages/core/src/apply.ts` |
| HTTP schemas and errors | `apps/api/src/schemas.ts`, `apps/api/src/errors.ts` |
| Document routes and service | `apps/api/src/routes/documents.ts`, `apps/api/src/documents.ts` |
| SQLite and Postgres stores | `apps/api/src/store/sqlite.ts`, `apps/api/src/store/postgres.ts` |
| Search semantics and SQL | `apps/api/src/search.ts`, `apps/api/src/store/word-search-sql.ts` |
| Blob content and wire references | `apps/api/src/content-storage.ts`, `apps/api/src/wire-content.ts` |
| Background jobs | `apps/api/src/jobs/`, `apps/api/workflows/` |
| Document UI and staged redlines | `apps/web/src/components/DocPane.tsx`, `apps/web/src/routes/DocumentView.tsx` |
| Operational rollout and recovery | `docs/OPERATIONS.md`, `docs/INFRA_APPENDIX.md` |
| Performance reports | `bench/performance/results/2026-10-19/REPORT.md` and adjacent JSON summaries |
| Scope map | `ASSESSMENT_SCOPE.md` |

## Clear limitations

- The shared demo has no authentication, tenancy, or confidential audit trail. Use only fictional data.
- Hosted OTLP delivery still needs a collector endpoint and authenticated headers.
- The final 1/8/32 performance matrix predates the Preview move to `cle1`; rerun it with the Preview protection bypass available.
- The 32-client run showed elevated search and edit tails. The 8-client targets passing does not imply unlimited capacity.
- CUAD's model judge attempted only 4 of 72 frozen examples because of provider access/credit restrictions. The dataset construction and keyword baseline are useful evaluation scaffolding; they do not establish broad model accuracy.
- Model quotes are checked for exact presence, not legal support. Clause CI is advisory, not legal advice or a substitute for lawyer review.
- Real provider OAuth credentials are not configured for the demo integrations; sample UI behavior is not proof of a live customer connector.
- Word export was validated through XML/Pandoc acceptance checks, not every Microsoft Word version.

## Closing position

The implementation demonstrates a clear contract-editing core: exact targets, atomic changes, explicit conflicts, persistent indexed search, and revision history. The architecture extends that core to large documents and durable work while preserving bounded transfer and transactional metadata. The strongest claims are backed by tests and recorded measurements; the remaining gaps are stated plainly. The next evidence-producing steps are a post-`cle1` hosted matrix and authenticated hosted telemetry. Customer use would additionally require the security and compliance controls in Part II.

\newpage

# Evidence and references

The assessment brief asks for a build, a short production design, and a live discussion. This document combines those deliverables with the supporting evidence needed to explain them. Raw numbers and test outputs remain in the repository so the reviewer can inspect the source rather than rely on summary claims.

- Project README and API examples: `README.md`
- Production design one-pager: `INFRA.md`
- Operations and recovery guide: `docs/OPERATIONS.md`
- Assessment-to-code map: `ASSESSMENT_SCOPE.md`
- Performance and operations report: `bench/performance/results/2026-10-19/REPORT.md`
- Frozen AI benchmark method and results: `bench/ci/RESULTS.md`
- Local authenticated OTLP smoke: `scripts/telemetry-smoke.ts`, `scripts/telemetry-auth-smoke.ts`
- Test workflows: `.github/workflows/ci.yml`
- Codeforces 2063C original problem statement: [codeforces.com/problemset/problem/2063/C](https://codeforces.com/problemset/problem/2063/C)

**Confidentiality:** all sample contracts used by this demo are fictional. No proprietary or prior-employer material is included.
