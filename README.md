# CLAUSE — versioned document editing and search

[![CI](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml/badge.svg)](https://github.com/olanotolu/clause-take-home/actions/workflows/ci.yml)

CLAUSE is a small service for making **exact, verifiable edits** to text documents and searching them. Its central design decision is separating *resolving* an edit (where does it land?) from *applying* it, so a whole batch is validated against one snapshot before a new revision is committed. If an edit is ambiguous, stale or overlapping, it is **refused rather than guessed**.

```bash
# Node >= 24 and pnpm required
pnpm install
pnpm seed                 # loads 5 fictional contracts from fixtures/ into data/clause.db
pnpm dev                  # API on http://127.0.0.1:3000   (docs: /docs, spec: /openapi.json)
pnpm dev:web              # optional UI on http://127.0.0.1:5173 (proxies /api to :3000)
./http/demo.sh            # end-to-end curl walkthrough (needs jq)
pnpm test                 # 150 tests
```

No native build step: storage is Node's built-in `node:sqlite`, and TypeScript runs directly under Node's type stripping (`pnpm typecheck` runs `tsc`).

## The problem it solves

`text.replace("shall not disclose", "may disclose")` silently edits the first of however many matches exist. CLAUSE instead:

| Situation | Behaviour |
|---|---|
| Target text matches 3 passages, no disambiguation | `409 AMBIGUOUS_TARGET` with every candidate's offsets and surrounding context |
| Client edited an older version | `409 VERSION_CONFLICT` (or `412` for a stale `If-Match`). Never auto-merged. |
| Two changes in a batch overlap | `422 OVERLAPPING_CHANGES`, nothing applied |
| Any change in a batch is invalid | None of the batch is applied (atomic) |
| Two writers race on the same version | Exactly one commit wins (compare-and-swap); the other gets `409` |
| Replacement equals existing text | `200`, `changed:false`, **no new version** |

## API

| | |
|---|---|
| `POST /documents` | create (version 1). `201`, `ETag`, `Location` |
| `GET /documents?limit&offset` | metadata only (no bodies) |
| `GET /documents/:id` | full document; `ETag`, honours `If-None-Match` |
| `DELETE /documents/:id` | `204` |
| `PATCH /documents/:id` | **apply changes** → full updated text, new version, receipt |
| `POST /documents/:id/changes/preview` | same body as PATCH; dry run through the *same engine call*; returns proposed text, unified diff, receipt. Persists nothing. |
| `GET /documents/:id/revisions[/:version]` | immutable history with full snapshots |
| `GET /documents/:id/export.docx?from&to` | **Word redline**: the differences between two versions (default: v1 → current) as native Word tracked changes. See below. |
| `POST /documents/:id/revert` | **undo**: `{toVersion, expectedVersion?}` restores an old version's text as a *new* version. History is never rewritten. Same preconditions, ETag and no-op rule as PATCH. |
| `GET /documents/search?q&mode&ids&limit&offset` | search across documents |
| `GET /documents/:id/search?q&mode&limit` | search inside one document (all hits) |
| `POST /documents/:id/suggest` | optional AI *proposal*; never applies (see below) |

### Changes

```jsonc
PATCH /documents/doc_123
{
  "expectedVersion": 3,                       // optional; 409 unless the document is exactly at v3
  "changes": [
    { "operation": "replace",
      "target": { "quote": { "exact": "shall not disclose", "prefix": "Disclosing Party ", "occurrence": 1 } },
      "replacement": "may disclose" },
    { "operation": "replace",                 // position form: expectedText is REQUIRED (no blind writes)
      "target": { "position": { "start": 1043, "end": 1061, "expectedText": "shall not disclose" } },
      "replacement": "" }                     // delete = empty replacement; insert = start === end
  ]
}
```

Response (abridged): `{ id, content, previousVersion, version, changed, beforeHash, afterHash, applied:[{index,start,end,before,after,newStart,newEnd}] }`. The `beforeHash`/`afterHash` (SHA-256) and `applied` spans form a **receipt**: it states exactly which bytes changed. It does not claim the change is legally correct.

**Semantics (all tested):**
- **Offsets are UTF-16 code units**, half-open `[start, end)`, the unit JavaScript strings use. A range starting or ending inside a surrogate pair is rejected (`422 SPLIT_SURROGATE`) rather than corrupting the text. These are not code points, graphemes or UTF-8 bytes.
- **Quote targets are literal and case-sensitive** (never a regex). Occurrences are 1-based over non-overlapping matches, counted *after* `prefix`/`suffix` filtering. Omitting `occurrence` is allowed only if exactly one passage matches.
- **One snapshot.** Every target resolves against the same version, never against text an earlier change in the batch already altered. Adjacent ranges are fine; overlaps are rejected; two inserts at the same offset are rejected (order would be arbitrary).
- **Preconditions.** `expectedVersion` (body) and `If-Match` (header, `"v3-<hash12>"`) may both be sent; if they disagree → `400`. There is **no auto-merge**.
- **Error body** is always `{ "error": string, "code": number, "type": string, "details"?: {} }`. `409` = state conflict (stale, ambiguous, text moved), `412` = `If-Match`, `422` = can never succeed as written, `413` = body too large, `5xx` never includes stack traces or document text.

### Search

Two modes with deliberately different semantics:

- **`mode=words`** (default): FTS5, Porter stemming + BM25 ranking, ranked snippets. Plain text only: user input is compiled into quoted FTS terms, so operators, `*`, `NEAR(`, column filters etc. are inert. `"quoted phrases"` work. Terms are ANDed.
- **`mode=exact`**: literal, case-sensitive substring (same rule as a quote target). A trigram FTS index only *narrows candidates*; every reported offset comes from scanning the real current text.

**Every hit carries a verified `start`/`end` and a ready-to-use `target` selector** that resolves to exactly that span in that version, so *search → select → edit* needs no hand-copied offsets:

```bash
curl -s "localhost:3000/documents/$ID/search?q=shall%20not%20disclose&mode=exact" | jq '.result.hits[1].target'
# {"quote":{"exact":"shall not disclose","prefix":"isclosing Party ","suffix":" Trade Secrets.\n"}}
```

`total` counts matching **documents**, not occurrences. Search reflects a committed edit immediately (the index is updated by triggers inside the same transaction).

### AI suggestions (optional, API only)

`POST /documents/:id/suggest {"instruction": "..."}` asks a model (AI SDK 7 through the AI Gateway) for a structured proposal, converts it to ordinary quote changes, and validates it with **the same engine as a human edit**. The response says `applied:false`, carries the version it was validated against, and the client commits it through normal `PATCH`. The model can propose; only the deterministic engine decides what is modified. Policy: ≤5 changes, each target ≤2,000 chars, documents >200k chars refused (no silently truncated contract).

**Configuration:** copy `.env.example` to `.env.local` (git-ignored; `pnpm dev` and `pnpm suggest:smoke` load it automatically) and set `OPENROUTER_API_KEY` (default model `anthropic/claude-sonnet-5.5`, override with `CLAUSE_SUGGEST_MODEL`). AI Gateway credentials also work. With no key the route answers 503 and the UI's **AI** tab says how to enable it; nothing else is affected.

**In the UI:** the **AI** tab sends your instruction, shows the model's rationale and the exact before → after, labels the source (`live model` vs `FIXTURE`), and lets you *stage* the change into the normal review → Apply flow.

> **Status, honestly:** the safety logic is covered by tests with a stub provider, and the UI flow (suggest → stage → validate → apply) was driven in a browser against a stub labelled `FIXTURE`. **It has also been run once against a live model** (`anthropic/claude-sonnet-5.5` via OpenRouter, 2026-10-15): `pnpm suggest:smoke` passed all 8 checks across three scenarios (a normal edit is accepted and not applied; an instruction hidden inside a contract is not obeyed; an impossible request invents nothing). That is one run of three cases, not a guarantee: models are non-deterministic, and the engine validating every proposal is what makes the route safe, not the model behaving.

### Word redline export

`GET /documents/:id/export.docx?from=1&to=7` returns a `.docx` whose differences are **native Word tracked changes** (`<w:ins>`/`<w:del>`, author `CLAUSE`, dated by the newer revision), so Word's Review pane lists them and Accept/Reject work. A ready-made example is in [`samples/mutual-nda-redline.docx`](samples/mutual-nda-redline.docx). The History tab links to it.

- Word-level diff (`jsdiff`); every line break ends a paragraph, and an inserted or deleted line break is tracked on the paragraph mark, so *Reject all* really restores the old paragraph structure.
- **Verified** by reading the generated XML back independently: *Accept all* reproduces the new text and *Reject all* reproduces the old text exactly, over a set of tricky pairs (empty paragraphs, emoji, `<`/`&`, repeated blank lines), and the sample opens in an unrelated library (`python-docx`). **I have not opened it in Microsoft Word itself**; please do that once with the sample.
- Plain text only: there is no original Word formatting, numbering or tables to preserve, so none is produced. Versions larger than 1,000,000 characters return `413` instead of attempting a super-linear diff.

## Performance

Measured by `pnpm bench` on a deterministic synthetic 10 MiB contract (10,306,991 chars; seeded-random clause paragraphs with newlines, accents, `§`, one rare token). Machine: Apple M4 (10 cores), 32 GiB, macOS, Node 26.7.0, SQLite 3.53.4. **Not an idle machine** (load average ≈ 8 from other apps), so treat figures as ±30%. Medians of 5 runs where marked.

| Operation (10 MiB document) | Time |
|---|---|
| Engine: unique replacement near end of file | 7 ms (median) |
| Engine: 100-change batch | 9 ms (median) |
| Engine: ambiguous target rejected (full scan) | 5 ms (median) |
| `POST /documents` (insert + words index + trigram index + v1 snapshot) | 589 ms |
| `GET search` words, rare token / very common phrase | 16 ms / 20 ms (median) |
| `GET search` exact, unique string / hundreds of thousands of hits | 14 ms / 51 ms (median) |
| `PATCH` unique replacement, full stack (returns 9.8 MB) | 713 ms |
| `PATCH` 100-change batch, full stack | 900 ms |
| `POST preview` incl. unified diff | 155 ms |
| `PATCH` with stale version (rejected) | 14 ms |
| Peak RSS / DB file after 3 revisions | 722 MB / 97 MB |

**What this says:** the edit engine is *not* the bottleneck (7 ms of a 713 ms edit). The cost is index maintenance (delete + reinsert of both FTS indexes), the full-snapshot revision, and serialising a 10 MB response. Peak RSS is ~70× the document size; I did not profile where it goes (several in-memory copies of the text plus the 10 MB response are the likely cause).

**Complexity** (n = document length, k = changes, r = total replacement length): quote resolution is one `indexOf` scan per target (**O(k·n)** worst case, *not* linear overall); ordering is O(k log k); rebuilding is a single forward pass **O(n + r)**; a stale version is rejected before any scanning (14 ms, which is just loading the row).

**A bug the benchmark caught:** FTS5's native `snippet()` is O(matches per row). It took **8.3 s** for a common phrase on this document, while the engine took 3 ms. The fix ranks with `bm25()` only, builds snippets only for the page returned, and above 256 KiB locates the highlight with one bounded regex scan (verified by slicing). 8,337 ms → 20 ms. See `NOTES.md`.

## Testing

```bash
pnpm test         # 150 tests: engine unit + property tests, API, search, concurrency, suggestions
pnpm typecheck    # strict TS across API, core and web
pnpm bench        # the table above (separate from `test`; takes well under a minute)
pnpm mutate       # bounded mutation run on the engine (~30 s)
./scripts/fuzz/run.sh   # Schemathesis against /openapi.json on a disposable DB (pip install schemathesis)
```

- **Engine** (`packages/core`): the full edge-case list (ambiguity, occurrence N, bounds, expected-text mismatch, overlaps, adjacency, empty target/replacement, CRLF, surrogate pairs, no-op) plus **property tests** (fast-check, fixed seed `20261015`, override with `FC_SEED`): rejected batches never mutate input; output equals a naive right-to-left reference implementation on every accepted batch; bytes outside the changed spans are preserved; reported new offsets locate the replacement; `selectorFor()` always resolves back to its span.
- **Concurrency** uses two independent SQLite connections to one file, interleaved so both read v1, A commits, and B's compare-and-swap fails with history still contiguous. (A single connection running sequentially would not prove this.)
- **Mutation testing:** StrykerJS 10 did not work with Vitest 5 / TypeScript 7 here (details in `NOTES.md`), so `scripts/mutate.ts` is a small first-order harness (70 mutants; skips lines containing string literals; no equivalent-mutant detection). First run killed 52/70; new tests killed 13 of the 18 survivors (surrogate-pair boundaries, `changed:true`, candidate context/cap, prefix at offset 0, suffix-only anchoring). **Final: 65/70 killed (92.9%)**; the 5 survivors are equivalent mutants, each explained in `NOTES.md`.
- **API fuzzing:** Schemathesis 4.4.4, seed `20261015`, 1,650 generated cases over 11 operations (incl. `/revert` and `/export.docx`), **0 failures**. It found five real bugs that 100+ hand-written tests missed (a 500 on NUL bytes in queries, over-lenient integer coercion, an incomplete OpenAPI contract…). `DELETE` and `/suggest` are excluded and stateful sequences aren't covered; reasons in `NOTES.md`.

## Design notes and trade-offs

- **SQLite + FTS5, `node:sqlite`.** One file, transactions, native BM25/snippets, no services to run. `node:sqlite` is still *Stability 1.2 (release candidate)* in Node 26.7, so storage sits behind a small `db.ts`; swapping in `better-sqlite3` is a one-file change. Both FTS tables are *external-content* (the text isn't stored twice) kept in sync by triggers.
- **Full snapshot per revision.** Simple and makes any version restorable, but a frequently edited 10 MB document costs ~10 MB per edit. Production would use content-addressed snapshots + deltas (see `INFRA.md`).
- **PATCH returns the full text** because that's the contract asked for; for very large documents an opt-out/pointer is the better design (also in `INFRA.md`).
- **`expectedVersion` is optional.** Quote targets and mandatory `expectedText` are themselves content preconditions, and omitting a version still can't commit against a stale read (the CAS fails). A stricter deployment can require it.
- **REST shape.** Resources are nouns; *preview* is its own sub-resource (`POST …/changes/preview`) rather than a `?dryRun` flag, so a cache or proxy can never confuse it with a mutation. `PATCH` carries a change list because the unit of atomicity is a batch.
- **Offsets, not code points.** UTF-16 offsets are the cheap, JS-native choice and are documented; the cost is that other-language clients must convert.

## Known limitations

- **CLAUSE guarantees the mechanics of an edit, not its legal meaning.** In testing, changing "two million dollars" left "($2,000,000)" in the same sentence; nothing here would notice.
- No authentication, tenancy, rate limiting or audit log (design in `INFRA.md`). Not SOC 2 / GDPR compliant, and nothing here claims to be.
- Documents are plain text only: no DOCX/PDF import and no formatting. The Word export is a plain-text redline.
- Words-mode highlights on documents >256 KiB mark the *first* occurrence of the query's words, not FTS5's "best window". Diacritic-insensitive matching (`café`/`cafe`) works in the index but not in that locator.
- Exact search is case-sensitive only; case-insensitive and regex search are not offered.
- Search results can be stale between a result and a later edit; each result carries its `version` and the UI only highlights hits whose version matches.
- Revisions are never pruned (undo adds a revision rather than removing one). `DELETE` removes a document and its history permanently.
- The AI route has had one live run (above), not a soak test. The UI has no automated tests; it was exercised manually in a browser (search, selection, staging, redline, conflict banner, reload, apply, restore, AI suggest against a stub, Word download).

## Repository

```
packages/core/   pure edit engine: resolve → order/validate → rebuild (no I/O, no dependencies)
apps/api/        Fastify 5 + Zod 4; routes are thin, services coordinate, repo is SQL only
apps/web/        React 19 + Vite 8 + Tailwind 4 workspace (search → select → preview → apply)
samples/         an example Word redline
fixtures/        fictional contracts (NDA, SaaS, MSA, DPA, employee confidentiality)
bench/           deterministic 10 MiB generator + benchmark
scripts/         mutation harness, Schemathesis runner + hook
http/demo.sh     curl walkthrough
INFRA.md         production design (Part II)
NOTES.md         real bugs found while building, and how
```

Built with AI assistance (Claude Code); every behaviour above is covered by a test, a benchmark run, or a manual browser check described in `NOTES.md`.
