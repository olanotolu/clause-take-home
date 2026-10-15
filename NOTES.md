# Build notes (real findings only)

## 2026-10-15 — mutation sanity check on the engine
Manually mutating `end > text.length` to `end > text.length + 1` in `resolve.ts` was **not** caught by
the first 46 tests: the unit tests only tried ranges far beyond the end, and the property tests build
`expectedText` from `text.slice(start, end)`, which silently clamps. Added a regression test for a
range ending exactly one past the document. Lesson: slice-derived oracles hide bounds bugs.
