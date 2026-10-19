# What answers the assessment, and what is extra

The brief asks for a redlining and search service in 3 to 4 hours, with "a simple front-end" and focus on the API and core. This repository is larger than that. This page says which part is which, so the core is easy to find.

## The assessed core (start here)

| The brief asks for | Where it is | Evidence |
|---|---|---|
| Replace text in one document, get the updated text back | `PATCH /documents/:id`, `apps/api/src/routes/documents.ts`; engine in `packages/core/src` | `packages/core/test/*` (unit, property, mutation harness), `apps/api/test/documents.test.ts` |
| Search one or many documents, with snippets | `GET /documents/search`, `GET /documents/:id/search`; `apps/api/src/search.ts` | `apps/api/test/search.test.ts`, the 10 MiB benchmark in `bench/` |
| Bulk edits | `changes` is an array, applied atomically (all or none) | `engine.test.ts`, `documents.test.ts` |
| Concurrency: versions, ETag, repeated matches | `expectedVersion`, `If-Match`, compare-and-swap commit; quote + prefix/suffix/occurrence, or position + `expectedText` | `concurrency.test.ts` (two real connections), `etag-race.test.ts` |
| Errors: 4xx, and 5xx as `{ error, code }` | one error shape everywhere | `documents.test.ts`, weekly Schemathesis fuzz |
| 10 MB+ documents, near-linear | one forward pass to rebuild; measured numbers | `bench/performance/README.md`, `pnpm bench`, `pnpm load` |
| Search indexing and trade-offs | persistent inverted indexes (FTS5, Postgres GIN), discussed in the README | README "Why not an in-memory inverted index" |
| Tests, curl samples, README | `http/demo.sh`, README | `pnpm test:coverage` on SQLite and Postgres |
| Part II infra doc | `INFRA.md` (one page) and `output/pdf/CLAUSE-infrastructure.pdf` | measured milliseconds against targets, with the misses stated |

If I rebuilt this in four hours, I would keep: the pure edit engine, the compare-and-swap commit, search that ranks before it builds snippets, the tests that make those trustworthy, and the API shape. Everything below is an extension of those.

## Extras built on top of the core

Clause CI (checks an edit against saved requirements), AI suggestions (proposals only; the engine validates them), the Word tracked-changes export, the web app, requests/playbooks/templates, the Integrations page and the walkthrough video. Each works, none was asked for, and none is needed to evaluate the core.

## Things that look more finished than they are

- **Integrations:** the page in the UI runs on sample files and never calls the real connector API. The connectors exist and are tested with stubbed providers, but need OAuth credentials the demo does not have. Its "import" writes placeholder documents into the shared database.
- **Clause CI, semantic checks:** advisory. A quote is checked to exist in the document, not to support the model's conclusion.
- **Postgres at size:** the hosted database caps documents at 500,000 characters and has not been load-tested; the 10 MiB numbers are SQLite.
- **No tenancy, sign-in or audit trail** on the demo. It is a shared workspace; the five sample contracts are read-only, everything else is disposable.

## Not built, on purpose

A decision trace across suggestion, check, approval and commit. Today only the committed revision is persisted, so a trace would be mostly empty; it would need records for suggestions, CI runs and approvals, and real authentication.
