# CLAUSE

[![CI](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml/badge.svg)](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml)

**Live demo: https://clause-take-home.vercel.app** (no sign-in; API reference at [`/api/docs`](https://clause-take-home.vercel.app/api/docs)). Please don't paste real confidential text into it.

This is my take-home for Sandstone's full-stack interview. I'm going to explain it the way I'd explain it to you across a table: what I was asked, what I decided to build, what went wrong along the way, and, because it matters more, what I did *not* prove.

## What I was asked

Three things. (I'm paraphrasing; the assessment is marked confidential, so I'm not reproducing it.)

1. **Part I, an app.** A small "redlining and search" service: send a JSON edit ("replace this text with that text") for one document and get the updated text back, and search across documents for relevant snippets. Tests, sample requests, a README with performance notes and API reasoning. The optional extras were things like batch edits, 10 MB+ documents, version/ETag conflict detection, and an index.
2. **Part II, a one-page infra doc** on taking it to production. That's [`INFRA.md`](INFRA.md).
3. **Part III, a live session** to walk through both and code something live. That's the part I can't prepare in a README.

## The one idea the whole thing hangs on

The obvious implementation is `text.replace("shall not disclose", "may disclose")`. It silently edits whichever match comes first. In a contract that is the worst possible failure: a plausible-looking wrong edit, no error.

So I decided early that CLAUSE should **refuse rather than guess**. An edit is first *resolved* (where exactly does it land?) and only then *applied*, and the whole batch is resolved against one snapshot of the document so one change can never shift another's target.

| Situation | What happens |
|---|---|
| The target text matches 3 places and you didn't say which | `409 AMBIGUOUS_TARGET`, with every candidate's offsets and some surrounding text so you can pick |
| You edited an old version | `409 VERSION_CONFLICT` (or `412` for a stale `If-Match`). I never auto-merge. |
| Two changes in one batch overlap | `422 OVERLAPPING_CHANGES`, nothing applied |
| Any one change in a batch is bad | None of the batch is applied |
| Two people write at the same moment | Exactly one commit wins (compare-and-swap); the other gets a `409` |
| The replacement equals what's already there | `200`, `changed:false`, and no new version |

That table is the heart of Part I. Everything else is built to make it trustworthy or usable.

## The fastest way to see it

On the live site, start on the **Workspace** board (sample requests, one per piece of legal work). Open *Mutual confidentiality for Acme* and choose **Open in editor**. In the **Rules** tab pick the *NDA Playbook* and Apply it: its rules become this document's requirements. Then select a clause, **Replace** it, and press **Run Clause CI** to see which requirements the edit breaks (or select a phrase and choose **Protect** to add your own). Back on the Workspace board, **Run Clause CI** on the request audits the current text the same way. Nothing is saved until you press **Apply**. The **Activity** tab shows every version; restoring one makes a *new* version (history is never rewritten), and the Word redline downloads from there.

Locally (Node 24+ and pnpm):

```bash
pnpm install
pnpm seed          # five fictional contracts from fixtures/ into data/clause.db
pnpm dev           # API on http://127.0.0.1:3000   (docs at /docs)
pnpm dev:web       # UI on http://127.0.0.1:5173    (proxies /api to :3000)
./http/demo.sh     # the whole story in curl, needs jq
pnpm test
```

There's no native build step: storage is Node's built-in `node:sqlite`, and TypeScript runs directly under Node's type stripping (`pnpm typecheck` runs `tsc` as the real check).

## How I built it, in the order it happened

**1. The edit engine first** (`packages/core`). Pure functions, no I/O, no dependencies: resolve targets, check overlaps, rebuild the text in one forward pass. I wrote it before any server so I could hammer it. Besides the usual edge cases (CRLF, empty targets, emoji, adjacent edits), it has property tests that compare it to a deliberately dumb reference implementation, and check that rejected batches never touch the input.

**2. SQLite + FTS5 for storage and search.** One file, real transactions, built-in ranking. Search has two modes with different meanings on purpose: `words` is stemmed and ranked (like a search box), `exact` is a literal, case-sensitive match (the same rule an edit uses). Every hit comes with verified offsets *and a ready-made selector*, so "search, click a result, edit it" needs no copy-pasting of character positions.

**3. Then I measured, and found my first real mistake.** On a 10 MB contract, a search took **8.3 seconds** while the edit engine took 3 ms. FTS5's `snippet()` visits every match in the row and a contract has hundreds of thousands of them. I'd also been computing snippets for every matching document before paginating. I fixed both (rank first, snippet only the page, and a bounded linear scan above 256 KiB). 8,337 ms became 20 ms. [NOTES.md](NOTES.md) has this and every other bug story, because I think the stories say more about how I work than the finished code does.

**4. A UI**, because a redlining tool you can't see isn't much of a redlining tool: search, select text, stage changes, validate them live, see a redline, apply, handle conflicts. I drove it in a real browser and found things no test would: a "Redline" button that looked broken because the change was scrolled off-screen, and a green "Valid" box that stayed on screen under a conflict warning (true when it was computed, false by the time you saw it). Both are fixed and in the notes.

**5. Trying to break it.** Mutation testing (my own small harness, since StrykerJS didn't work with Vitest 5 and TypeScript 7; details in the notes) and Schemathesis API fuzzing. Fuzzing found five real bugs that a hundred hand-written tests had missed, including a 500 on NUL bytes in a search query.

**6. Undo and Word export.** Undo restores an old version's text as a *new* version, so history only ever grows. The Word export produces native tracked changes (`<w:ins>`/`<w:del>`) so Review → Accept/Reject works. I tested it by reading the XML back and doing what Word does (accept-all should give the new text, reject-all the old); that caught a real bug where an inserted line break wasn't tracked, so "Reject all" would have left a stray paragraph.

**7. Production shape.** The service now runs on Postgres as well as SQLite behind one `Store` interface, and *the same API test suite runs against both*. It's deployed on Vercel (frontend and API as two services of one project) with Neon Postgres. Two things bit me there: Vercel's builder crashes on TypeScript 7's API (so `apps/api` pins a local TS 5.9 for the build), and it hung because I was awaiting `listen()` in a serverless function. Both in the notes.

**8. AI, kept on a short leash.** `POST /documents/:id/suggest` asks a model for an edit, converts the answer into ordinary quote changes, and validates it with **the same engine as a human edit**. It never applies anything. The model proposes; the engine decides.

**9. Where it got ambitious: CLAUSE CI.** (Next section.)

**10. Settings.** A page that shows what the server is doing and keeps a few per-browser preferences. The product design I was working from also showed SSO, Slack, billing and so on. None of that exists here, so those rows are visibly disabled and say "Not in this prototype" instead of pretending.

**11. A real interface.** The first UI was three columns and a tab strip, and it looked like it. I rebuilt it as an app: a router (deep links and the back button work), a left rail, ⌘K search that jumps to the exact passage, and a document page with an Edit / Clause CI / Activity / Details structure. Editing happens in the document: select text and a small toolbar offers **Replace**, **Protect** (one click to turn a clause into a requirement) and **Find**. Proposed changes sit in a tray that says whether the engine accepts them before you can Apply. Light and dark themes, keyboard operable, works down to a phone.

I then redid the *look*, because my first pass (warm cream, serif headings, a dark sidebar) is exactly what an AI tends to produce by default. It now follows a stricter product register, written down in [`DESIGN.md`](DESIGN.md): neutral surfaces so status colours mean something, 6% hairline borders instead of shadows, one blue accent, two corner radii, and motion only where it explains a state change. The typeface is STK Miso (see the note in `DESIGN.md`: it is licensed, not open source). Icons are Phosphor (Lucide is what most generated UIs use). Off-the-shelf pieces: `sonner` toasts, `cmdk` for ⌘K, `@dnd-kit` for the request board (which also works from the keyboard), `@number-flow/react` for counts, `auto-animate` for lists, and two small components adapted from Motion Primitives.

**12. The rest of the workspace, built for real.** The design I was given also had a requests board, playbooks, a global activity feed and templates, and I did not want them to be pictures. So they have tables, endpoints and tests on both databases:
- **Requests** (`/requests`): a unit of legal work on a document (what was asked, priority, due date, status). Drag cards between Inbox, In progress, Needs review and Completed. **Run Clause CI** on a request audits the document's *current* text against its requirements and the request's own outcome, stores what it found, and moves an open request to Needs review if something fails. It never moves one to Completed; a person does that.
- **Playbooks** (`/playbooks`): named, reusable sets of requirements. Applying one copies its rules onto a document as ordinary requirements (duplicates skipped, the 8-per-document limit respected, and the response says what was skipped and why).
- **Activity** (`/activity`): the newest versions across all documents. It records edits only.
- **Templates** (`/templates`): the sample contracts as starting points.

What I deliberately did *not* draw, because there is nothing behind it: assignees, teams and avatars, comments, notifications, integrations, billing, a storage meter, and Jev's numbers. Requests have no owner field because this app has no users.

I went well past the suggested time-box. Treat steps 1-5 as the actual assignment and the rest as extras you're free to ignore.

## CLAUSE CI: "did this edit break anything?"

The mechanics guarantee *which bytes changed*. They say nothing about whether the change did what you wanted or broke something elsewhere. ("Two million dollars" became "three million" but "($2,000,000)" stayed in the same sentence; nothing in the engine can see that.)

So each document can carry **requirements**, like a test suite: *must mention X*, *must not contain Y*, *keep this sentence verbatim*, or a plain-English claim ("compelled disclosure is permitted"). Before you apply an edit, `POST /documents/:id/changes/check` runs them against the text before and after and reports each as held, regressed, achieved, still failing, or uncertain.

- The first three kinds are **exact checks**, no AI involved. The plain-English kind is judged by a model (`anthropic/claude-sonnet-5.5` via OpenRouter).
- A judge has to **quote the passage** it relied on, and I verify the quote appears word-for-word in the document. A "pass" with no verifiable quote becomes "needs review". Unverifiable quotes are shown struck through, never trusted.
- It's **advisory only**. It can't block or alter an edit, there is deliberately no green "safe" state, and if the model is down you get `UNAVAILABLE`, not a 500.
- A **Strict** setting makes a semantic pass need every judge to be at least 80% sure; it can only make a check more cautious.

### Does it actually work? I benchmarked it, with the caveats up front

I used [ContractNLI](https://stanfordnlp.github.io/contract-nli/) (Koreeda & Manning 2021, CC BY 4.0): real NDAs with expert labels. I committed the test cases and settings *before* running any judge, and tuned the baseline on a separate dev split only.

| (n = 60 documents, 30 edit pairs) | Keyword baseline | Claude Sonnet 5.5 |
|---|---|---|
| Right answer (entailed / contradicted / not mentioned) | 40.0% [29%, 53%] | **80.0% [68%, 88%]** |
| Noticed an edit that deleted the supporting sentences | 4 of 17 usable pairs | **22 of 28 usable pairs** |
| Wrongly flagged a harmless edit | 0 of 17 | 0 of 28 |
| Quotes that were really in the document | 100% | 100% (191/191) |

Brackets are 95% intervals. With samples this small they're wide, and **the model beating a keyword baseline is the only comparison I'd claim**. Latency was about 2.4 s median per call and the run cost $1.52.

What I did *not* measure: **Jev** (a cheaper specialist verification model I'd planned to combine with the LLM). Vercel's AI Gateway only serves it to paid teams, so the Jev judge is implemented and unit-tested but has **no results**, and I'm making no claim about it. The "regression" truth is also auto-labelled from the experts' evidence spans, which assumes they marked every supporting sentence. Full tables and limits: [`bench/ci/RESULTS.md`](bench/ci/RESULTS.md) (generated from the raw answers by `pnpm bench:ci:report`).

## Performance

`pnpm bench`, deterministic synthetic 10 MiB contract (10.3 M characters), SQLite, Apple M4, Node 26.7. The machine wasn't idle (load average about 8), so treat these as ±30%. Postgres was *not* benchmarked at this size; it has a 500,000-character cap (below), so the 10 MB case is a SQLite story.

| Operation on a 10 MiB document | Time |
|---|---|
| Engine: one unique replacement near the end | 7 ms |
| Engine: a 100-change batch | 9 ms |
| Engine: ambiguous target rejected (full scan) | 5 ms |
| `POST /documents` (insert, both indexes, v1 snapshot) | 589 ms |
| Search, rare word / very common phrase | 16 ms / 20 ms |
| Exact search, unique string / hundreds of thousands of hits | 14 ms / 51 ms |
| `PATCH` one replacement, whole stack (returns 9.8 MB) | 713 ms |
| `PATCH` 100-change batch, whole stack | 900 ms |
| Preview including the unified diff | 155 ms |
| `PATCH` against a stale version (rejected) | 14 ms |

The engine is not the bottleneck (7 ms of a 713 ms edit). The time goes to updating two search indexes, storing a full snapshot, and sending a 10 MB response. Peak memory was around 700 MB, about 70x the document; I didn't profile where it goes.

Complexity, honestly stated: resolving k targets is up to **O(k·n)** (one scan each), *not* linear overall; rebuilding is one forward pass, O(n + total replacement length).

## Trying the API

```bash
# an ambiguous edit is refused, and tells you where the candidates are
curl -s -X PATCH localhost:3000/documents/$ID -H 'content-type: application/json' -d '{
  "expectedVersion": 1,
  "changes": [{ "operation": "replace",
                "target": { "quote": { "exact": "shall not disclose" } },
                "replacement": "may disclose" }]}'
# -> 409 AMBIGUOUS_TARGET with each candidate's start/end and context

# pick one with a prefix or an occurrence number, or use a position with REQUIRED expectedText
"target": { "quote": { "exact": "shall not disclose", "prefix": "Disclosing Party ", "occurrence": 1 } }
"target": { "position": { "start": 1043, "end": 1061, "expectedText": "shall not disclose" } }
```

`http/demo.sh` runs the whole thing (create, ambiguous refusal, search-to-selector, preview, apply, stale write, no-op) against a local server.

### Endpoints

| | |
|---|---|
| `POST /documents` | create (v1). `201`, `ETag`, `Location` |
| `GET /documents?limit&offset` | metadata only |
| `GET /documents/:id` | full text; `ETag`, honours `If-None-Match` |
| `DELETE /documents/:id` | `204` |
| `PATCH /documents/:id` | apply a batch of changes → full updated text, new version, receipt |
| `POST /documents/:id/changes/preview` | same body as PATCH, same engine call, persists nothing; returns proposed text + unified diff |
| `GET /documents/:id/revisions[/:version]` | immutable history |
| `POST /documents/:id/revert` | undo = restore an old version's text as a new version |
| `GET /documents/:id/export.docx?from&to` | Word redline with native tracked changes |
| `GET /documents/search?q&mode&ids&limit&offset` | search across documents |
| `GET /documents/:id/search?q&mode&limit` | search inside one document |
| `GET/POST/DELETE /documents/:id/requirements` | CLAUSE CI requirements (max 8 per document) |
| `POST /documents/:id/changes/check` | run requirements (+ optional `goal`, `strictness`) against an edit |
| `POST /documents/:id/suggest` | optional AI proposal; never applies |
| `GET /settings/status` | read-only server facts (judge models, storage, limits); no secrets |
| `GET/POST /requests`, `GET/PATCH/DELETE /requests/:id` | units of legal work; `?status=` filters the list |
| `POST /requests/:id/check` | Clause CI audit of the linked document's current text; stores the result on the request |
| `GET/POST /playbooks`, `GET/PATCH/DELETE /playbooks/:id` | reusable sets of requirements |
| `POST /playbooks/:id/rules`, `DELETE /playbooks/:id/rules/:rid` | add or remove a rule |
| `POST /documents/:id/apply-playbook` | copy a playbook's rules onto a document as requirements |
| `GET /activity?limit` | newest versions across all documents |
| `GET /templates` | the sample contracts, for starting a new document |

A successful edit returns a **receipt**: `beforeHash`/`afterHash` (SHA-256) plus the exact spans that changed. It states which bytes changed. It does not claim the change is legally right.

### Semantics worth knowing (all tested)

- **Offsets are UTF-16 code units**, half-open `[start, end)`, the unit JavaScript strings use. A range that splits a surrogate pair is rejected (`422 SPLIT_SURROGATE`) rather than corrupting text. These are not code points, graphemes or bytes.
- **Quote targets are literal and case-sensitive**, never regex. `occurrence` is 1-based over non-overlapping matches counted *after* `prefix`/`suffix` filtering, and may be omitted only if exactly one passage matches.
- **Position targets must carry `expectedText`.** No blind writes by character offset.
- **One snapshot per batch.** Adjacent ranges are fine, overlaps are rejected, and two inserts at the same offset are rejected (the order would be arbitrary).
- **Preconditions:** `expectedVersion` (body) and `If-Match` (header, `"v3-<hash12>"`) may both be sent; if they disagree it's a `400`.
- **Errors** are always `{ "error": string, "code": number, "type": string, "details"?: {} }`. `409` is a state conflict (stale, ambiguous, text moved), `412` is `If-Match`, `422` can never succeed as written, `413` is too large. 5xx responses never include stack traces or document text.
- **Search:** `words` compiles user input into quoted FTS terms, so operators like `*`, `NEAR(` or column filters are inert; quoted phrases work and terms are ANDed. `total` counts documents, not occurrences. A committed edit is searchable immediately (indexes update in the same transaction).

## How I know the tests are any good

```bash
pnpm test             # 295 pass, 7 skipped on SQLite (the skips are Postgres-only); 301 pass on Postgres
pnpm typecheck        # strict TypeScript across core, API and web
pnpm bench            # the performance table
pnpm mutate           # bounded mutation run on the engine, about 30 s
./scripts/fuzz/run.sh # Schemathesis against /openapi.json on a throwaway DB (pip install schemathesis)
CLAUSE_TEST_DATABASE_URL=postgres://… pnpm test   # same suite on Postgres
```

CI runs the suite on Node 24 and 26 with SQLite, plus a Postgres 16 job.

- **A passing test proves little if it can't fail.** So I checked: I mutated the engine one operator at a time and re-ran the tests. First run killed 52 of 70 mutants; I added tests for the survivors that mattered and got to **65/70 killed**. The last five are explained as equivalent in the notes. It's my own small harness (first-order mutants only, no equivalent-mutant detection), not Stryker.
- **Concurrency** is tested with two separate database connections to one file, interleaved so both read v1, A commits, and B's compare-and-swap must fail. A single connection running sequentially would prove nothing.
- **Fuzzing:** 1,650 generated cases over 11 operations, 0 failures at the last run. Not covered: `DELETE` and `/suggest` (reasons in the notes) and stateful sequences.
- **The AI route** is tested with a stub provider (the safety logic) and had one live run against Sonnet 5.5: 8 of 8 checks across three scenarios, including a contract containing "ignore all previous instructions", which the model treated as text. That's one run of three cases. The route is safe because the engine validates every proposal, not because the model behaved.

## Decisions I'd defend, and what they cost

- **SQLite by default, Postgres in production.** SQLite means one file and nothing to run; `node:sqlite` is still "release candidate" in Node, so it sits behind a small `Store` interface. The cost: two backends to keep honest, and Postgres can't take huge documents the same way (a `tsvector` caps near 1 MB, so Postgres refuses documents over 500,000 characters with a clear error rather than failing mid-edit).
- **A full snapshot per revision.** Dead simple and any version is restorable, but a 10 MB document edited often costs ~10 MB per edit. `INFRA.md` has the production answer (content-addressed snapshots plus deltas).
- **`PATCH` returns the whole text**, because that's the contract I was given. For very large documents a pointer is the better design.
- **`expectedVersion` is optional.** Quote targets and `expectedText` are already content preconditions, and the compare-and-swap catches a stale commit anyway. A stricter deployment could require it.
- **REST shape.** *Preview* is its own sub-resource, not a `?dryRun` flag, so no cache or proxy can confuse it with a mutation. `PATCH` takes a list because the unit of atomicity is a batch.
- **Per-browser settings, not a server-side table.** The deployed workspace is open to everyone, so a shared settings row would let any visitor change the shared AI bill. Model choice stays in the server's environment.

## What isn't done, or isn't proven

- **It guarantees the mechanics of an edit, not its legal meaning.** (See the dollar example above.) CLAUSE CI helps; it doesn't solve that.
- **No authentication, tenancy or audit log.** The demo is deliberately open. Rate limits exist on the two paid routes (20 suggestions and 60 checks per IP per hour) but are in-memory and per-instance: a brake, not a quota. Nothing here is SOC 2 or GDPR compliant and I don't claim it; `INFRA.md` is the design for getting there.
- **Jev is unmeasured**, as above. The ensemble of Jev plus LLM was never evaluated.
- **I haven't opened the Word export in Microsoft Word itself.** It round-trips under accept/reject tests and opens in `python-docx`. Please open [`samples/mutual-nda-redline.docx`](samples/mutual-nda-redline.docx) once.
- **The web UI has only unit tests for its pure logic** (router, due dates, filters, word counts, settings parsing). The screens themselves I drove by hand in a browser at desktop, tablet and phone widths, in light and dark. The backend is where the real tests are.
- **Requests have no owner and no notifications**, because there are no users. Status moves are manual; the only automatic move is Clause CI sending a request with failing requirements to Needs review. Activity covers edits only, not CI runs or AI suggestions.
- **The sample requests and playbooks on the live site are fictional**, seeded once with the sample contracts.
- **Production writes weren't tested on the live site**: I confirmed search, the AI check and settings there, but left the sample contracts at v1 rather than editing them.
- **Plain text only.** No Word/PDF import, no formatting. Words-mode highlights on documents over 256 KiB mark the first occurrence, not FTS5's "best window". Exact search is case-sensitive only.
- The benchmark is **NDAs only, English, small samples** (see its limits).

## Using AI

I used Claude Code throughout, for the code, the docs and this README, and I've tried to make that safe to rely on: every behaviour above is covered by a test, a benchmark run, or a manual browser check recorded in `NOTES.md`, and the places where the AI's first answer was wrong (my own wrong expectation in a statistics test, a "fix" I reverted, an invented probability threshold I didn't ship) are in the notes too. I'm ready to explain any of it live.

## Where things are

```
packages/core/   the edit engine and requirement checks (pure, no I/O)
apps/api/        Fastify 5 + Zod 4; routes, services, SQLite and Postgres stores, CLAUSE CI judges
apps/web/        React 19 + Vite 8 + Tailwind 4 workspace
bench/           10 MiB performance benchmark; bench/ci/ is the ContractNLI benchmark and RESULTS.md
scripts/         mutation harness, fuzz runner, live smoke tests (suggest:smoke, ci:smoke)
samples/         an example Word redline
fixtures/        five fictional contracts
http/demo.sh     curl walkthrough
INFRA.md         Part II: production design
NOTES.md         the bugs, in order, and what each one taught me
```

To use the AI features locally, copy `.env.example` to `.env.local` and set `OPENROUTER_API_KEY`. Without a key the AI tab says how to enable it and everything else works.
