# Walking the team through CLAUSE

For rehearsal. The three-minute path is for a live demo; the failure stories are for when someone asks "what went wrong?". Every number here is in the repo; the source is named next to it.

Use a copy for anything that edits: the five sample contracts are read-only on the shared demo (open one, press **Make a copy**).

## Three minutes

1. **Search a clause that appears twice.** Search `Confidential Information` in the NDA. Words mode and Exact mode both return every occurrence with its offset and surrounding text. (Search design: README, "Why not an in-memory inverted index".)
2. **Ask for an ambiguous edit.** Replace `Confidential Information` without saying which one. The engine refuses with `AMBIGUOUS_TARGET` and lists every candidate with its position. It never guesses.
3. **Resolve it.** Pick one by its position, or add `occurrence: 2`. The receipt shows the exact span, before and after hashes, and the new version.
4. **Show a conflict.** Edit the same copy in two tabs. The second save returns `409 VERSION_CONFLICT`, with the current version, and nothing is overwritten. The `ETag` on every response names the version in that response's own receipt (`apps/api/test/etag-race.test.ts`).
5. **Run Clause CI.** Save two requirements (one exact, such as "must not contain `perpetual`"; one semantic). Exact results say so, are never wrong in the way a model can be, and cost nothing. Semantic results are labelled model-supported and advisory; a model's quote only proves the words exist in the document, not that the conclusion follows.
6. **Close with the evidence, not adjectives.** `pnpm test` (SQLite and Postgres), the engine's 98% line floor, the weekly API fuzz run, and `bench/performance`.

## What went wrong, and what changed

- **The ETag could describe the wrong version.** PATCH and revert re-read the document after committing to build the `ETag`. A second writer landing in that gap changed the header, and a delete there turned into a 500. Found in review, reproduced with a deterministic test that injects the second writer between commit and response, then fixed by deriving the header from the receipt. (`apps/api/test/etag-race.test.ts`)
- **Search snippets were the cost, not the index.** Snippeting the whole row made a words search over a 10 MiB document take 8,337 ms. Paginating before snippeting brought it to about 21 ms. (INFRA.md measurement table.)
- **The shared demo could be wrecked by anyone.** Anyone could edit or delete the sample contracts, which are what a reviewer opens first. They are now read-only (`403 SAMPLE_READ_ONLY`), restored by the server if removed, and copyable.
- **A second AI judge never produced a number.** Its provider answered HTTP 403, so there was no measurement to report. It was removed rather than left behind a flag, and the benchmark keeps the record of why.
- **The walkthrough video 404'd silently.** The page referenced a file that was never committed, and the SPA rewrite answered with HTML. There is now a test that the file is a real MP4.

## What the INFRA document admits it has not proven

Exact search and edit p95 miss their targets at 8 concurrent clients on the single-process SQLite prototype (435 ms against a 300 ms target; 879 ms against 500 ms). Chunked indexes and per-document row locks are the proposed fix, not yet demonstrated. Postgres is untested at size. There is no tenancy. (INFRA.md, "Risks and first measurements".)

## If I rebuilt it in four hours

Keep the edit engine, atomic persistence with compare-and-swap, search correctness, the tests that pin them, and the API contract. That is the part the brief grades. Skip the workspace UI, Clause CI, integrations and templates, which exist, are labelled in [ASSESSMENT_SCOPE.md](../ASSESSMENT_SCOPE.md), and are not what I would defend first.
