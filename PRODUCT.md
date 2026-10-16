# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Legal and contracts professionals (and the engineers building for them) who revise contracts and need to know exactly what changed, whether an edit broke something that mattered, and what the AI did and did not decide. Confirmed through the repository and the owner's briefing: the immediate audience is the reviewers of a full-stack interview take-home (Sandstone, legal AI), who open one shared live URL and probe claims.

## Product Purpose
CLAUSE makes exact, verifiable edits to contract text and searches across documents. An edit is resolved before it is applied, so ambiguous, stale or overlapping edits are refused rather than guessed. CLAUSE CI adds per-document requirements (like tests) that every proposed edit is checked against, with exact checks and AI judges whose quoted evidence is verified word for word. Success: a reviewer can search, select, stage, validate, redline, check, apply, undo and export without reading documentation, and never mistakes an advisory AI opinion for a proven fact.

## Positioning
The mechanics of an edit are proven by a deterministic engine (receipts with hashes); the meaning of an edit is only ever advised by AI, with evidence that is verified against the text. No neighbouring "AI redlining" product states that boundary on every screen.

## Operating Context
One open, shared workspace on a public URL (no sign-in), SQLite locally and Postgres on Vercel. Documents are plain text. History is append-only; undo creates a new version. AI features need an OpenRouter key and are rate limited per IP.

## Capabilities and Constraints
Real: documents, versions and restore, word and exact search with verified offsets, redline preview, Word tracked-changes export, AI suggestions (proposal only), CLAUSE CI requirements and reports, requests (a board of legal work tracked per document, with a Clause CI audit), playbooks (reusable requirement sets), cross-document activity, templates, read-only server status, per-browser settings.
Not built, must not be depicted as working: assignees, teams and roles, comments, notifications, billing and storage plans, Jev results (the Jev judge exists but was never measured). Depicted only as labelled demos: the Integrations page (sample files; the real OAuth connectors exist but are unconfigured and admin-only), and the sidebar usage meter ("Sample"). The sidebar identity chip shows only what the session provides: "Open workspace" when nobody is signed in, the signed-in user's own name and role otherwise. Authentication exists only as an optional admin sign-in for the integrations routes.

## Brand Commitments
Name CLAUSE; the logo mark in the repository; "CLAUSE CI" for the checking feature. The owner supplied seven mockups (workspace, document editor with AI assistant, Clause CI results, activity, playbooks, templates, settings) as the binding visual brief.

## Evidence on Hand
Five fictional sample contracts in fixtures/; a ContractNLI benchmark with results in bench/ci/RESULTS.md (n=60 documents, 30 edit pairs; Claude Sonnet 5.5 80% three-way accuracy vs 40% keyword baseline); a sample Word redline in samples/. Absent and not to be fabricated: customers, usage counts, team members, model confidence beyond the measured benchmark, Jev numbers.

## Product Principles
1. Refuse rather than guess: every ambiguity is shown to the person, never silently resolved.
2. Proven versus advised is always visible: engine facts and AI opinions are never styled alike.
3. Evidence over assertion: an AI claim without a quote that exists in the document does not earn a pass.
4. Nothing is saved without a human action, and nothing is ever deleted from history.
5. If a feature is not built, the interface says so.

## Accessibility & Inclusion
Keyboard operable throughout, WCAG AA contrast in light and dark themes, reduced-motion respected, status never conveyed by colour alone (icon plus words).
