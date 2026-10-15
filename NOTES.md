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
