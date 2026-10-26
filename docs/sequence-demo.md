# Clause — Insurance Review: three-minute walkthrough

This is an independent proposal inspired by [Sequence's public operating thesis](https://seqholdings.com/blog/sequence-built-to-refound/). It is not an official Sequence or Atlas product, and does not describe Baldwin's internal systems. Every organization, document, rule and outcome is synthetic. The scenario date is October 26, 2026. Use fictional data only: the public demo has no production tenancy or sign-in.

Start the web app with `pnpm install --frozen-lockfile` and `pnpm dev:web`; open `http://localhost:5173/#/insurance`. The case is initialized in the browser without an API key or database. Reset demo clears this case's session state. Reload also resets it.

**0:00–0:20 — Case.** “Harborlight Hospitality is reviewing the annual insurance evidence for Northline Facilities. The agreement is an editable draft, and the approved playbook independently requires $2 million per occurrence. The documents and date are synthetic.”

**0:20–0:55 — Review.** Select **Review evidence**. “The schedule states $1 million per occurrence and $2 million in the aggregate. The aggregate does not satisfy the per-occurrence requirement. The entity, coverage type and dates match the supplied records. This reports a discrepancy, not a coverage or legal determination.”

**0:55–1:20 — Evidence and action.** Open the per-occurrence schedule passage and the agreement requirement. “Each reference identifies the source version and the exact passage. The vendor email is an unverified assertion.” Select **Prepare clarification** and **Record task**. “The request is a draft; nothing is sent.”

**1:20–2:00 — Proposed edit.** Select **Stage suggestion**. “The existing edit engine resolves an exact replacement and the document pane shows a redline. The proposed $1 million agreement limit falls below the independently stored approved requirement. The original remains unchanged.” Select **Discard proposal**. “Text validity, playbook conformance and human authorization are separate. Clause CI is advisory.”

**2:00–2:30 — New evidence.** Select **Introduce revised schedule**. “This synthetic fixture represents a newly received issuer record, not an edit to issued coverage. The old report is stale.” Select **Review evidence**. “The new schedule's stated per-occurrence limit matches the playbook; a professional still needs to review the evidence.”

**2:30–3:00 — Replay and reuse.** Open **Replay scenarios**. “These are three examples using the same deterministic evaluator, not an accuracy study. Versioned evidence, typed comparisons, precise edits and review history are candidate reusable components for another operating company.”

## Current boundaries

The new case uses static structured fixture facts; it does not extract arbitrary documents or call an AI provider. Quote matching establishes location only. The case, tasks and history live in the current browser session and are not stored through the application's store abstraction. Schedule v1 is retained as a selectable fixture. The proposed change can be previewed and discarded but cannot be applied from this case; the existing editor and API retain their own version checks. This case does not yet demonstrate a stale edit rejection. The replay does not measure runtime or exercise provider failures. It is not a production workflow or a hosted readiness claim.
