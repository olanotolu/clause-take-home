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
Result: first run 52/70 killed (74.3%), 18 survivors. Triage: 13 of the 18 were killable by new tests (surrogate boundary code units,
`changed:true` never asserted at engine level, candidate context bounds, candidate cap of 10, prefix starting at
offset 0, suffix-only anchoring), added. Final: **65/70 killed (92.9%)**. The 5 survivors are equivalent:
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

## 2026-10-15 — Schemathesis 4.4.4 (bounded, seeded) found five real problems
Setup: `scripts/fuzz/run.sh` (disposable DB, fixed seed 20261015, 150 examples/operation). Excluded on purpose:
`/suggest` (503 without AI credentials is correct but reported as "server error"), `DELETE` (the fuzzer deleted all
seeded docs in its first requests and starved every other operation), and the `positive_data_acceptance` check
(random-but-schema-valid edits are legitimately refused: stale version, text not found).
Runs, in order:
1. First run passed 660 cases but warned "8 operations repeatedly returned 404": random ids meant it **never reached
   the editing logic**. A pass with that warning is weak evidence. Added a hook that substitutes real ids — and made
   it substitute only values that were already valid, because overwriting a deliberately invalid value with a valid one
   (my first version did, for `version`) hides the very bugs negative testing looks for.
2. With real ids it found: (a) **500 "unterminated string"** for any search query containing NUL — SQLite treats NUL as
   end-of-string, truncating the FTS query mid-quote; my error mapping only recognised messages containing "fts5".
   Fixed (reject NUL with 400 INVALID_QUERY; broadened the SQLite-error mapping). (b) Related: documents/replacements
   with NUL would be silently *under-indexed* (FTS, length(), instr() stop at NUL) -> now refused with 400 at the door.
3. The OpenAPI document declared only 2xx responses, so every real 4xx was "undocumented", and 204/304 claimed a JSON
   `null` body. Declared response + error schemas on every route; stripped bodies from 204/304 in the spec.
4. Negative testing: `z.coerce.number()` turned `?offset=` into 0 and accepted `" 1"`, `"1e1"`, `"0x1"` as ids/limits.
   Replaced with strict base-10 integer parsing. `q` now has min/max length in the contract (empty `q` was valid per
   schema but rejected by the handler).
Final: 9 operations, 1350 generated cases, 0 failures. Not covered by this run: DELETE, /suggest, and stateful
sequences (no OpenAPI links defined).
Every one of these was missed by 100+ hand-written tests and found by a tool in under a minute — which is the argument for it.

## 2026-10-15 — a benchmark that silently doubled: orphaned workers
The "final" benchmark came out ~2x slower than the first (engine 3 ms -> 7 ms, 10 MB PATCH 815 -> 1569 ms) with no
code change. `uptime` showed load ~11: four orphaned Vitest workers (PPID 1, 31 min old) were each pinning a core.
They were infinite-loop mutants from my first mutation-harness run, left behind when the tool killed the harness
but not its children. Killed them, reran: back to the original range. Takeaways: (1) the harness now prints the
load average, because a benchmark number without machine state isn't reproducible; (2) the mutation harness now
kills its whole process group on timeout (`detached` + `process.kill(-pid)`).

## 2026-10-15 — "Redline doesn't do anything" (user report)
Reproduced: Redline *did* render, but in place and without scrolling, so when the changed clause was off-screen (or
the window was short, as in the small browser pane) clicking it appeared to do nothing. Fix: entering redline mode
scrolls to the first change, and a banner says "Redline preview of N staged changes ... Nothing is saved until you
click Apply". Verified: with the change scrolled out of view (scrollTop 0), clicking Redline moved the view to the
change (scrollTop 338) and showed the banner. Lesson: a mode switch with no visible feedback reads as a broken button.

## 2026-10-15 — stale "Valid" box under a conflict banner (user report from a screenshot)
While the "Document changed underneath you" banner was showing, the validation box still said a green
"Valid · v3 -> v4 / version 3 is still current": true when computed, false now. Apply was correctly refused, so it was
a trust bug, not a correctness bug. Fix: while a conflict is showing, the box says "Validation is out of date".
Verified in the browser (green tick absent, Apply disabled). Lesson: UI that reports a past check as the present one.

## 2026-10-15 — undo (POST /documents/:id/revert)
Design: undo is a NEW revision whose text equals an old one; history is only appended to, and the new revision's summary
records `{revertedTo: n}` so the audit trail says why it exists. It reuses the edit path's pieces (preconditions,
compare-and-swap commit, no-op rule), so a revert can't clobber someone else's newer edit. No-op is decided by TEXT, not
version number (v3 can equal v1). 11 tests, including search following the restored text and a two-connection race.
Verified in the browser: restoring v5 from v6 produced v7 whose hash equals v5's, v6 still listed. Fuzz over the new
endpoint: 1,500 cases, 0 failures. Side finding: the Restore button's accessible name was its long tooltip, not its visible
label ("label in name" mismatch); fixed with an explicit aria-label.

## 2026-10-15 — Word export: two bugs the accept/reject property caught
The export test reads the generated XML back and applies what Word does (Accept-all / Reject-all), then compares to the
two source texts. It failed twice, usefully:
1. **Test-reader bug**: the library writes an empty paragraph as self-closing `<w:p/>`; my regex treated it as an opening tag
   and swallowed the next paragraph. Fixed the reader, not the exporter.
2. **Real exporter bug**: an inserted line break created a new paragraph, but the break itself wasn't tracked, so "Reject all"
   in Word would leave an extra empty paragraph behind. The break that ends a paragraph is a *paragraph mark*; Word tracks it
   as a change on the paragraph. Fixed with `Paragraph({ run: { insertion | deletion } })` and taught the reader the merge rule.
Verified separately: the sample opens in python-docx (9 tracked insertions, 4 deletions, one author). Not verified: opening in
Microsoft Word itself (installed on the dev machine, but I can't drive it) — left as a manual check.

## 2026-10-15 — AI tab verified against a stub, not a model
Drove suggest -> stage -> validate -> apply in a browser against a throwaway server with a stub provider (labelled FIXTURE in the
UI), and against the real server with no key (the tab explains how to enable it). The live-model checks still need
`OPENROUTER_API_KEY=... pnpm suggest:smoke`. (Aside: port 3001 on the dev machine is taken by an unrelated app; the harness used 3399.)

## 2026-10-15 — first live run of the AI route (OpenRouter, anthropic/claude-sonnet-5.5)
`pnpm suggest:smoke`: 8/8 checks passed. Latency 2-4 s per call. Notable: for the poisoned contract ("IGNORE ALL PREVIOUS
INSTRUCTIONS... HACKED") the model fixed the typo and said in its rationale that it treated the line as document text, not
an instruction. One run, three scenarios: evidence, not proof. The route's safety does not depend on this: every proposal
still goes through the deterministic engine, a scope policy, and a version check, and nothing is applied without a human click.
The API key lives only in a git-ignored, owner-readable `.env.local`; it was pasted into a chat to hand it over, so it should be
rotated or given a spend limit after the demo.

## 2026-10-15 — benchmark statistics: my "reference value" was wrong, the code was right
The first Wilson-interval test asserted 81/100 -> upper bound 0.8777, a number I wrote from memory. It failed (code gave 0.8749).
Rather than "fix the code to match", I cross-checked against statsmodels' `proportion_confint(method="wilson")`: 0.874852. Code was
right to ~1e-5. The test now pins independently computed values. Lesson: a failing test can mean the *expectation* is wrong;
check against a second implementation before deciding which side moves.

## 2026-10-15 — Settings: what I refused to fake
The mockup had SSO, Slack/Drive/M365, billing and a model picker. None exist here, and the deploy is open to everyone, so a server-side "settings" table would let any visitor change the shared AI bill. Decision: preferences live in the browser; server facts are read-only; unbuilt features are visibly disabled and labelled. My first idea for "risk sensitivity" was a probability threshold in the ensemble, but the ensemble decides by label, not thresholds, so inventing one would have been a new, unmeasured policy. The shipped version only demotes a PASS (never promotes anything) and is table-tested. Layout bugs found in the browser, not by tests: the settings view fought the app's 3-column grid on phones, and an auto-width grid column overflowed at 375px.

## 2026-10-15 — production deploy (Vercel Services + Neon)
Verified on the public alias, not just the per-deployment URL: that one returns 302 (Deployment Protection) while the production alias returns 200. Seeded 5 documents once into Neon via CLAUSE_SEED=1, search works, `/settings/status` reports postgres, and a real strict-mode `/changes/check` ran the live model in about 3 s. Not verified here: write paths on production (I did not edit the seeded documents, to leave the demo in its clean v1 state) and the Jev arm.

## 2026-10-16 — the interface rebuild, and what the new backend caught
Rebuilt the UI as a routed app and then, at the owner's request, built the rest of the design for real (requests board, playbooks, global activity, templates) instead of drawing it. Findings worth keeping:
1. **A date check that accepted 31 February.** `Date.parse("2026-02-31")` succeeds in V8 (it rolls over to 3 March), so my first `dueDate` validation let it through. Found by a test that listed bad dates, not by thinking about it. The check now requires the parsed date to print back as the same day.
2. **I changed a test's meaning on purpose.** An old test asserted that an empty change list to `/changes/check` is a 400. I made that route accept an empty list ("audit the current text") so the Clause CI tab can run without a fake edit. The engine still refuses an empty batch (`EMPTY_BATCH`) and PATCH/preview still return 400; only the check route short-circuits, in one function (`previewOrCurrent`). The old assertion was updated with a comment rather than quietly deleted.
3. **Seeding must not depend on "are there documents?"** The live database already had documents, so seeding playbooks and requests behind that check would never have run. Each table seeds independently, atomically (a transaction on SQLite, an advisory lock on Postgres), and skips a sample request whose document does not exist.
4. **Deleting a document keeps its requests** (`ON DELETE SET NULL`), with the link cleared and the UI saying so; deleting work items because a document went away seemed the worse surprise.
5. **The audit never moves a request to Completed.** Only a person decides a piece of work is done; the only automatic move is open to Needs review when something fails. A card whose requirements all hold but whose requested outcome is not yet true shows "Outcome not met" rather than a green count, because "4/4 hold" next to an unmet goal read as success.
6. **Tooling note:** the browser pane's screenshots lag the DOM by a frame or two after navigation, so I confirmed state from the page text first and screenshotted after. Twice I nearly "fixed" a bug that was just a stale frame.

## 2026-10-16 — "this looks like AI slop": what I changed and what I deliberately did not install
The owner was right. My first redesign matched the mockups they gave me, and the mockups themselves sat in the AI default: warm cream ground, serif display headings, a dark sidebar, soft rounded cards. I moved to a neutral, border-led product register (see `DESIGN.md`), swapped the heading serif for the interface face, and kept the contract text serif because it is the document.
- **Font:** I said the UI used STK Miso before it did: the CSS pointed at it, but the file download had been blocked, so the browser was silently using a fallback. Now the file is bundled and I checked `document.fonts` reports it `loaded`. It is a commercial face from the owner's other repository; flagged in `DESIGN.md`.
- **Skills installed** (into `~/.claude/skills`, not into this repo): design-taste (24 skills), Better Design, Superdesign, and five of the owner's own animation/design skills. Superdesign's skill drives a cloud CLI that needs a login; I installed the instructions and ran nothing.
- **Libraries I used:** sonner, cmdk, dnd-kit, NumberFlow, auto-animate, motion (two Motion Primitives components, MIT, notices kept).
- **Libraries I cloned for reference but did not add to the product:** Canvas UI (licence is MIT *plus Commons Clause*, and its effects draw over the live page), Paper Shaders, UI Layouts, Hyperiux (Next.js effects, partly paid), Cursify (a docs starter, not a package) and Trickle (marketing-style text animation). They are good at what they do, and what they do (glow, shaders, cursor effects, scroll theatre) is what makes a legal workspace look like a landing page. Easy to add on request.

## 2026-10-16 — round two on the look, from the owner's own screenshot
The owner sent a screenshot of the app in their real Chrome and a Dribbble kanban as a reference. Their screenshot showed things my in-app browser never did:
- **A blank band under the sidebar.** The shell's grid had one implicit row, and the toast container, command palette and dialog were rendered *inside* the grid, which created a second row that took a share of the free height (rail 877px in a 1000px window). Fixed twice over: one explicit `grid-rows-[minmax(0,1fr)]`, and the overlays moved outside the grid. Found by measuring the rail against the viewport, not by looking.
- **Two "New request" buttons**, a loud focus ring on the active nav item, boxes inside boxes (a bordered, tinted lane around bordered cards), a centred-icon empty state, and subtitles that explained the product to someone already using it. All removed or quietened.
- **Icons:** replaced Lucide with Phosphor after comparing the 2026 field (sources in the commit message). One module, `ui/icons.tsx`, so another swap is one file.
- **Motion with a reason:** the request panel slides shut instead of vanishing, the rail highlight glides between items, the proposed-changes tray rises only when there is something in it, the sheet gets one ring after a save, struck-through text draws left to right in a redline, the CI bar fills in and its rows arrive in sequence.
- From the Dribbble reference I took the *frame* (greige shell, floating white panel, 24px lanes, icon-led tabs, white pill for the current nav item, priority and type pills) and left the colour: I built status-tinted washes on the cards, looked at them, and removed them. The owner said it did not need the orange, and a tint that decorates is what this system rules out. Avatars were never an option: there are no users.
- More animation skills installed (into `~/.claude/skills`): LottieFiles' motion-design, plus micro-interaction, accessible-animation, page-transition, 60fps and svg-animation from iart-ai. Their repos were checked for risky instructions first; glassmorphism, ASCII and GSAP skills were left out as irrelevant. `review-animations` is reserved for the owner to run (`/review-animations`), so I applied the rules myself instead of imitating it.

## 2026-10-16 — review of the owner's integrations work, and what I changed in it
I read the owner's connector code (OAuth service, routes, templates, auth wiring, mobile layout) and ran both suites on it before touching anything; it was sound (encrypted tokens, signed state, streamed download cap, idempotent imports). I fixed the gaps I found, and added tests for each:
- **OAuth state:** the HMAC key was the same bytes as the token-encryption key. It is now derived (HKDF) per purpose, and a test proves the raw key can no longer mint a valid state. The callback is a redirect from the provider, so it has no Bearer token to compare with the `sub` in the state; instead the connect call sets an HttpOnly, SameSite=Lax cookie holding a nonce, the state carries only its hash, and the callback refuses a mismatch before any token exchange. The state also names its provider, and PKCE (S256) is on, with the verifier stored encrypted inside the signed state so someone who sees the redirect URL cannot redeem the code. Callback failures now redirect back to Integrations with the message instead of showing raw JSON.
- **Refresh race:** concurrent requests share one in-flight refresh. Across serverless instances that cannot work in memory, so a rejected refresh re-reads the store and uses a token another instance has just rotated; only then does it ask the user to reconnect. Box refresh tokens are single-use, which is why this matters.
- **Timeouts:** every provider call has an abort signal (15 s, 30 s for downloads), and a timeout, a dead host or a stall mid-download now returns a clear 504 or 502.
- **Tests:** 20 new ones: encryption round-trip, tamper and wrong-key, state tamper and expiry, the full callback flow with the PKCE verifier checked at the token endpoint, cookie mismatch, cross-provider state, refresh sharing, cross-instance rotation, timeouts. I broke the binding check, the refresh sharing and the state key one at a time and each change failed exactly the test meant to catch it.
- **Web bundle:** 995 kB in one file became 304 kB of app code plus separate React and motion vendor chunks (659 kB, 198 kB gzipped, down from 293 kB), each screen a lazy chunk prefetched after first paint, and the 149 kB Neon Auth client loaded only after first paint when sign-in is configured. I checked a build with a dummy auth URL: the chunk loads, the app stays mounted, no render loop.
- **Identity chip:** the invented "Acme Inc. / Legal Team" card is gone; it shows "Open workspace" or the signed-in session's own name and role.
- **Not changed:** the Integrations page still runs on sample files and does not call the real connectors. Wiring it needs real OAuth credentials, which the live demo does not have, so I could not verify it end to end.

## 2026-10-16 — checking the work against the brief line by line
I put the brief next to the repo and ticked each requirement against code, not memory. Everything in the baseline was there, and so was every optional item, with these gaps, now closed:
- **Search indexing.** The optional item says "outline or implement an in-memory inverted index and discuss trade-offs". We have inverted indexes (FTS5, `tsvector`, `pg_trgm`), but the README never said so or compared them with an in-memory one. It now has a section built only from numbers we measured: term lookup was never the slow part, so a second in-memory copy would speed up the step that was already fast and add cold-start rebuilds, per-instance copies and invalidation.
- **INFRA.md** named neither caching, autoscaling nor alerts, which the brief lists. Added those, plus failover targets and batching, and tightened the rest (about 730 readable words became about 765 for five new topics). The failover and DR numbers are targets, and the doc says so.
- **A README claim with no test.** The API reference said 5xx bodies never contain a stack trace or document text and called the list "all tested". Nothing forced a 500. There is now a test that breaks the store on purpose and checks the exact body; making the handler leak `err.message` fails it.
- **Word export.** There is no Word or LibreOffice on this machine, so the claim stays "not opened in Word". What I could add is a second, independent reader: pandoc reads the tracked changes, and the tests check that reject gives the old text and accept the new, including the committed sample redline. If I break the writer so deletions are not tracked, that test fails. It skips where pandoc is missing.
- **Live write test.** One run against the production site (create, search, edit, stale write, ambiguous quote, stale `If-Match`, 404, `.docx` download, delete). It found a real papercut: `curl -X DELETE -H 'content-type: application/json'` with no body got `400 Body cannot be empty`, because Fastify refuses an empty body that claims to be JSON. Reviewers copy curl lines like that. The API now treats an empty body as no body (routes that need one still return 400; malformed and prototype-poisoning JSON are still refused), with tests, and I removed the parser change to check the test fails without it. My test script also hit that error and left its throwaway document behind for a minute; I deleted it by hand and confirmed the five sample contracts are unchanged at v1.
- **My own mistake:** I pushed the 500 test with a type error because I ran the tests but not `pnpm typecheck` (vitest doesn't type-check). CI went red on that commit; fixed in the next one. Typecheck now runs before every push.

## 2026-10-16 — raising the bar on how the code is checked, and what the new checks found
A coverage run showed the backend well tested and everything around it thin: the engine at 100% of lines, but the web screens at 0%, no browser tests, no linter, no coverage floor, no defence against a compromised dependency. I added each and kept a note of what each one found, because the findings are the evidence the checks are real.
- **Browser tests (Playwright + axe).** Three journeys on desktop and a 390px phone. Axe found one real defect on the first run: the document's scroll container could not be reached by keyboard (now a labelled, focusable region). It also reported a colour-contrast failure that turned out to be an entrance animation caught mid-fade, not a defect; the test now waits for animations to finish before measuring, and I say so here so nobody "fixes" the colour. Renaming the Apply button fails the journeys.
- **Coverage with floors.** Engine 100/98, connectors 66% to 96% after testing the routes and every provider adapter behind a real signed admin JWT, API routes 91% to 99%. The Postgres store is gated on the Postgres run, not the SQLite one, because each run can only reach its own store (a combined floor would have failed one or the other for the wrong reason). Three 5 ms sleeps in ordering tests became a fake clock.
- **Lint (Biome, type-aware).** Found 44 buttons without `type="button"`, loading placeholders and a badge whose `aria-label` sat on an element with no role (so screen readers ignored them), a promise used as a condition, and a few unused bits. The 25 `useExhaustiveDependencies` hits I read through by message and left off: the extra dependencies are deliberate refetch triggers (`reloadKey`, `rulesKey`, `doc.version`), the "missing" ones are run-on-open effects. That is reading messages, not proving each one safe. `CommandPalette.tsx` is excluded until the owner's redesign of it lands.
- **Supply chain.** pnpm refuses versions under 3 days old, actions are pinned to SHAs (and the Postgres image to a digest), `pnpm audit --prod --audit-level=high` runs in CI, Dependabot waits a week, zizmor lints the workflows (clean in pedantic mode; unpinning one action turns it red). One moderate advisory is accepted: `sprintf-js` via `mammoth > argparse`, reachable only through mammoth's command-line parser, which this service never calls; no patched version exists. The cooldown works: the first time I tried to add a dev dependency it refused a Vite internal published 47 hours earlier. SHA pinning is only as trustworthy as the review when the SHA was picked.
- **Stryker, again.** Stryker 10.0.0 (August 2026) still does not work here. I got it to start (it needs the plugin named explicitly under pnpm, and a nonexistent `tsconfigFile` because it calls a TypeScript JS API that TypeScript 7 does not have), and it ran 392 mutants, but scored 1.5% against my own harness's 92.9% on the same engine. Its Vitest plugin sets pool options Vitest 5 removed, so mutants are never switched on. A tool reporting a confident wrong number is worse than none, so it is removed and `pnpm mutate` stays.
- **Fuzzing found real contract bugs.** The fuzzer had not seen the newer routes. First run: 26 failures. An over-long path id got Fastify's own 414 whose `code` was a string, breaking the `{ error, code: number }` rule in the brief; the integration routes did not document their 400. Fixed; 5,744 cases, 0 failures. It now runs weekly in CI. The OAuth callback is excluded from the fuzz (the fuzzer follows its redirect to a page this API does not serve).
- **Load check, and a missed target.** `pnpm load`: edits on 1 MB documents have a p95 of 61 ms for one client but throughput plateaus near 19 per second, so eight concurrent writers see 879 ms and miss the 500 ms target in `INFRA.md`; exact search misses 300 ms at eight clients (435 ms). I wrote that into the README and INFRA instead of moving the target. The targets are for the Postgres design, which I have not load-tested.
- **Benchmark numbers pinned.** A test replays the committed benchmark record and fails if a number quoted in the README stops matching it (no network, no cost). The live run is still manual.
- **Mistake:** I pushed a test with a type error earlier today because I ran the tests but not typecheck; CI caught it, and typecheck now runs before every push and is a CI step.

## 2026-10-16 — a sandstone intro, and the packages I did not add
The owner asked for a Framer-style sandstone desert screen at the start. It is a full-screen intro, shown once on a first visit to the bare address (any deep link skips it; `#/welcome` replays it): a low sun over five layered dune ridges with strata lines and film grain, scrolled through in four beats (what it is, then the three things it refuses to do) that end on one button. It is the only screen in this palette; the product itself stays in the neutral register of DESIGN.md.
- **Packages:** none added. `motion`, already shipped, does the scroll-linked parallax and fades; the dunes are generated SVG (a few summed sines, so every load is identical) and the grain is an SVG turbulence filter. Considered and left out: Lenis (smooth scrolling; a new dependency, and the page works without it), Paper Shaders (a WebGL canvas for something an SVG does, and a heavier first load), GSAP ScrollTrigger (a second animation library next to the one already here). The intro is its own lazy chunk, so the main bundle does not grow.
- **Bug I shipped to myself:** the last beat's scroll window ran past 1, which the browser's scroll-timeline API rejects; it crashed the whole tree to a black screen. Caught in the browser, not by a test; a test for the intro now exists. The last beat also faded out at the very end of the scroll until I made it hold.
- **Accessibility:** the workspace stays mounted behind the intro for an instant entry but is `inert` meanwhile; Skip is the first focus target, Esc and Enter leave it, and with reduced motion the parallax is switched off. Axe finds nothing on the first or last screen on desktop or phone.


## 2026-10-16: assessment hardening

Word search previously ranked one database version and could read another version's content for its snippet. One paginated store operation now returns count, rank, content, version, and optional native snippet within a read snapshot on both adapters. The browser verifies the returned document version and exact passage before selecting offsets, protects staged drafts across document navigation, and ignores obsolete loads. Deterministic API and real browser tests reproduce these races.

AI requests now have a 25-second overall deadline, including concurrency queues. Cancellation removes queued work and reaches both providers. A provider that ignores cancellation retains its concurrency slot until it settles. Suggestions cap output and edit size, reject oversized replacements, and preserve a valid proposal when optional CI expires. Finished semantic checks remain available when other checks time out. Completed verdicts are cached globally; pending work is scoped to the caller's cancellation signal, so one caller cannot cancel another's result. Jev batches one call per document state and still cannot supply verified quotes itself.

The separate citation experiment froze public ContractNLI cases before inference. It rejected all ten fabricated quotes for both arms without paid calls. The baseline completed 60 calls, reporting $0.290032 in token-priced usage; total conservative reservations, including the failed Jev call, were $1.366824 of the authorized $5. Jev returned HTTP 403 and was stopped without retries or purchases. The baseline falsely supported 2/20 negative cases per split and retained 7/10 supported cases. This small contextual-support experiment supports no production promotion. Its raw results, hashes, intervals, and limitations are in `bench/citations/`.

The paired local SQLite 10 MiB rerun preserved the original benchmark and measured approximately 1 ms extra word-search latency for snapshot reads. Node 24 is pinned for production, Node 26 remains a compatibility check, and both TypeScript configurations use 5.9.3. Unused direct dependency declarations were removed without changing the remaining package versions. The shorter README links detailed results; the infrastructure summary has a visually checked one-page PDF and a detailed appendix. The confidential assessment attachment was not copied into the repository. Existing uncommitted UI edits were excluded by using an isolated worktree.

### Live follow-up: editing directly from a search hit

The live mobile check found a gap the initial browser journey missed. Search highlighted the correct passage, but the toolbar's child layout effect ran before its parent scroll-container ref attached on first mount. Moving that measurement to a passive effect shows the toolbar after the commit. The regression failed on desktop and mobile before the fix, then passed with a full search -> exact passage -> Replace -> Stage -> Apply journey. Production verification uses disposable documents and removes them even if the check fails.

## 2026-10-16 — the intro, rebuilt twice: why the first two looked like AI slop
The owner's verdict on the first two was "AI slop", and it was fair. Both were vector hills over a gradient sky, with sun rays and glass cards: the look every generated landing page has. Polishing them (more layers, haze, a heat filter, dust) made them busier, not better. The third version replaces the approach, not the polish:
- **It is a render, not an illustration.** A fragment shader ray-marches a dune field (`intro/shader.ts`): one height function drives the silhouette, the surface normal (with fine wind ripples), the sun's cast shadows and the haze, so light behaves like light. Wind ripples, grain glints and a warm rim where a slope turns from the eye come from the same terrain. Filmic tonemap, vignette and grain on top. No images, no new packages; it is its own chunk.
- **It moves like a camera.** The camera sits high over the field and glides forward as you scroll, rising a little; the day comes up from dawn to gold light over the first third; the sun climbs out of black in the opening seconds; the pointer nudges the view.
- **The type is a title card.** Lower third, one weight, tight tracking, over a scrim so it stays readable whatever the light does. The cards are gone: each beat shows a plain monospace example of what the service answers (the 409 with its candidates, the 409 version conflict, the Clause CI verdicts), labelled as an example response.
- **Performance is handled, not assumed.** Resolution adapts: it steps down if frames run long and back up if there is headroom; automated browsers get a tiny one; the loop pauses when the tab is hidden; if WebGL2 is missing or the context is lost, the same text sits on a still gradient; reduced motion freezes the camera, the light and the shimmer. I have only watched it on one machine; I have not measured it on a range of GPUs, which is the honest gap.
- **Mistakes on the way:** the first render put the camera so low that one dune wall filled the frame, and the sun behind the dunes lit nothing (flat brown); it then read as jagged mountains in grey-beige until I rounded the crests and warmed the sand and haze. A script of mine also emptied the shader file by opening it for writing before reading it; I rewrote it in full.
- **Type, in STK Miso throughout.** The face is a variable 100–900, and the first pass used it at one weight. It is now used for contrast: light and heavy lines in the headline, key phrases in each claim set bold, and the sentence writes itself in word by word with the scroll; a very light oversized numeral marks each beat; the example responses moved from a system monospace to a key/value table in the same face with tabular numerals (so figures align); a counter, an Esc hint on Skip, and a progress bar along the bottom edge replace the vertical line. The font was already loading (checked with `document.fonts`); the problem was how it was used, not whether.

