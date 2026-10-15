# Build notes (real findings only)

## 2026-10-15 — mutation sanity check on the engine
Manually mutating `end > text.length` to `end > text.length + 1` in `resolve.ts` was **not** caught by
the first 46 tests: the unit tests only tried ranges far beyond the end, and the property tests build
`expectedText` from `text.slice(start, end)`, which silently clamps. Added a regression test for a
range ending exactly one past the document. Lesson: slice-derived oracles hide bounds bugs.

## 2026-10-15 — FTS5 snippet() is O(matches); 8.3 s on a 10 MB contract
First 10 MB benchmark: `GET /documents/search?q=confidential information` took **8,337 ms**; the engine
itself took ~3 ms. Profiling the SQL (`bench` probe): MATCH 0 ms, bm25() 0 ms, `snippet()` ~8,200 ms,
`highlight()` ~19,500 ms. Both must visit every match position in the row, and a 10 MB contract has
hundreds of thousands. Two causes in my first design: (1) I computed a snippet for *every* matching
document and paginated afterwards; (2) native snippet() is unusable on huge, repetitive rows.
Fix: rank with bm25 only (phase 1), snippet only the returned page (phase 2), and above 256 KiB locate
the highlight with one bounded regex scan, verifying offsets by slicing. Result: 8,337 ms -> 20 ms.
Regression tests: "large documents use the linear locator" (correctness + generous time guard).
Trade-off kept honest: for big documents the highlighted word is the *first* occurrence of the query's
words, not FTS5's "best window".

## 2026-10-15 — porter stems are not what I assumed
My first stemming test assumed `disclosure` ~ `disclose`; Porter gives `disclosur` vs `disclos`. The test was
wrong, the code was right. Used `obligation(s)` and `terminate/termination` as the documented examples.

## 2026-10-15 — locator bug: stemming every word of a phrase
`locateTerms` shortened *every* word of a quoted phrase, so `shall not disclose` became `shal\s+not\s+disclo…`,
which can never match "shall" (the leftover "l" isn't whitespace). Caught by the locateTerms unit test, not by
the integration suite (those documents were small and used the native snippet path). Fix: only the last word
of a phrase is shortened. Lesson: the second code path needs its own tests; the large-document path is not
exercised by ordinary fixtures.

## 2026-10-15 — FTS5 silently ignores `rowid = ?` next to MATCH (wrong document's snippet)
Found by running the curl demo, not by the test suite: three different documents all showed the *same*
snippet (from the employment agreement). Cause: `SELECT snippet(...) FROM documents_words WHERE
documents_words MATCH ? AND rowid = ?` returned every matching row in this SQLite 3.53.4 build, and
`.get()` took the first. Plausible-looking text from the wrong contract is the worst failure class for this
product. Why tests missed it: they asserted the *highlighted word*, which was the same ("disclose") in
every document. Fix: filter on the joined `d.seq`, and verify the returned row's seq (defence in depth).
Regression test: "every result's snippet comes from ITS OWN document" (verified to fail on the old query).
Lesson: assert provenance (this text is in THIS document), not just plausibility.

## 2026-10-15 — mutation testing: StrykerJS 10 didn't work here; wrote a bounded harness instead
Tried StrykerJS 10.0.0 + vitest-runner on Vitest 5 / TypeScript 7. Findings, in order: (1) Stryker's tsconfig
preprocessor calls `ts.parseConfigFileTextToJson`, which doesn't exist in TS 7's native API ("TS7 experimental"
in its release notes) — bypassed with a nonexistent `tsconfigFile`; (2) pnpm's strict layout hid the runner
plugin — fixed with `plugins`; (3) the run then reported a **1.56% score, "0.07 tests per mutant"**, i.e. mutants
were never activated in the Vitest 5 runner (its init also crashed in debug logging). I did NOT report that number.
Removed Stryker and wrote `scripts/mutate.ts`: flips one operator at a time (<, <=, ===, &&, +, true, ...) in
`packages/core/src`, reruns the core tests, reports survivors. Honest limits: 70 mutants (lines containing string
literals are skipped), no equivalent-mutant detection, different operator set than Stryker.
Harness bugs I hit and fixed: (a) a mutant (`start - exact.length`) created an infinite synchronous loop that
Vitest cannot time out -> hard 20 s per-mutant kill, counted as detected; (b) my first version mutated the real
source tree, and a killed run left `resolve.ts` mutated (caught via `git status`, restored with `git checkout`)
-> it now mutates only throwaway copies in `.mutation-tmp/`.
Result: first run 52/70 killed (74.3%), 18 survivors. Triage: 10 were real test gaps (surrogate boundary code units,
`changed:true` never asserted at engine level, candidate context bounds, candidate cap of 10, prefix starting at
offset 0, suffix-only anchoring), now covered. Final: **65/70 killed (92.9%)**. The 5 survivors are equivalent:
`anchor.ts:17` (empty exact falls back to position either way), `resolve.ts:14` x3 (`charCodeAt` out of range is
NaN -> false either way), `apply.ts:11` (index tie-break is redundant given a stable sort over index-ordered input;
kept so `orderSpans` is deterministic for any input order).

## 2026-10-15 — UI findings from driving it in a real browser
1. **sr-only labels stretched the page**: `sr-only` is `position:absolute`; with no positioned ancestor, labels
   inside scroll containers extended the document height (docScroll 981 vs viewport 768), so the whole page
   scrolled. Fix: `relative` on scroll containers, `overflow-hidden` on the app root. Found by measuring, not guessing.
2. **Inspector vanished below 1100 px** (I had `hidden`). Now it stacks under the document.
3. **Selection highlight lost to the search-hit highlight** when they covered the same span (first range won).
   Selection now wins ties.
4. Sidebar showed a stale version after "Reload latest" (didn't refresh the list).
Verified end to end in the browser: search -> pick the second of two identical phrases -> stage -> redline shows only
that clause -> another writer commits -> Apply is refused with a conflict banner (staged edit kept) -> reload ->
edit re-validates (context anchor still unique) -> applied as v4; the identical phrase in 2.1 untouched.
**What this does NOT protect against** (said honestly): in that demo another writer changed "two million dollars"
to "three million dollars" but left "($2,000,000)" — a semantic inconsistency CLAUSE can't see. It guarantees the
*mechanics* of an edit, not its legal meaning.
