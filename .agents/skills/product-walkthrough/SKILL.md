---
name: product-walkthrough
description: Create or revise narrated product walkthrough videos grounded in this repository, with real browser footage, captions, editable video sources, and a verification report.
---

# Product walkthrough

Create the requested video for the stated audience and duration. For unspecified short feature demos, use 90 seconds, 1920×1080, and 30 fps. Preserve an explicitly requested longer engineering walkthrough. Use `/product-walkthrough` in Claude Code or `$product-walkthrough` in Codex.

## Establish what viewers can truthfully see

Read the relevant routes, API handlers, core logic, project instructions, and Git state. Record the source commit and distinguish implemented behavior, sample data, measured results, and proposed infrastructure. The user's assessment or customer materials may be confidential: keep their text out of footage and repository documentation.

Rehearse the full demonstrated flow on disposable local data. Reuse suitable successful footage when revising an existing video. Use an isolated checkout if the working tree contains unrelated changes. Do not use production writes to prepare footage. An AI demo uses only an authorized live-call budget; repeated rendering is not a reason to repeat paid calls.

## Tools and versions

Prefer the requested production tools when available:

- Agent Browser for real browser capture. Inspect `--version` and `record --help` before using documentation. Recording behavior differs by version: older releases create a new context and lose React state; current releases record the active page in place. Confirm a short capture before recording a staged workflow.
- Remotion for the editable composition, framing, callouts, captions, and final render. Read the installed official Remotion skills for the operations needed. Keep every independently editable scene as its own JSX node. Drive motion from frame numbers, not CSS animation timers.
- Configured narration, or local Samantha when appropriate on macOS. Identify synthetic narration. Require an established budget before introducing a paid speech provider.

For ElevenLabs, verify the supplied voice and included balance before generation. Keep API keys in ephemeral memory, never in source files or logs. Generate with timestamps, retain paragraph boundaries, and record the model and credit usage. Retiming a revision must keep the old footage offsets separate from the new narration offsets. Do not regenerate paid audio merely to fix video framing.

Keep video packages in a separate source project, not in the product's application dependencies. Pin versions. Official documentation: [Agent Browser recording](https://agent-browser.dev/recording), [Remotion skills](https://www.remotion.dev/docs/ai/skills), [Remotion licensing](https://www.remotion.dev/license). Installing a tool does not establish license eligibility or authorize a purchase.

## Direct and capture

For this project, start with real app footage from frame zero. Use a brief personal greeting when requested, then demonstrate an action immediately. Avoid opening title cards, assessment summaries, and a spoken production disclaimer. Keep synthetic-voice disclosure in delivery metadata or end credits. Do not confuse slow speech with natural speech: use contractions, first-person observations, and an expressive voice model when available.

Write a storyboard and conversational narration around the user's outcome. Give each scene a specific claim, evidence, action, and final state. Validate required selectors and success states before a long take. Use explicit accessible names and wait for real outcomes instead of assuming that a click succeeded.

Record short reusable clips. Hydrate and prepare the page before capture. Use the recorder's visible cursor and click effects when supported. Keep errors that the story intentionally demonstrates; disclose failures rather than presenting fake success. Preserve request/result evidence without credentials. Never reconstruct an app UI and present it as captured functionality.

Keep the app's live state on its own tab. Put explanation graphics in the editor, not into the running app page. This avoids destroying unsaved proposals when switching to a title card.

## Compose

Open Studio as soon as a runnable project exists. Use the product's actual visual identity. Enlarge the passage, result, or control being explained, and leave enough context to identify its document and version. Use restrained camera moves and brief callouts. Avoid idle full-screen footage where its text is too small to read.

A mobile scene must retain the phone viewport throughout its capture. Frame it as a phone recording rather than stretching a desktop scene. Recompose vertical outputs around readable content; do not center-crop an entire desktop interface blindly.

Derive timing from measured audio durations. Import captions into Remotion's `Caption` format. Keep the authoritative SRT and narration text with the project. Reuse existing audio if the narration is unchanged. Review representative frames in Studio before rendering the full video.

## Verify and deliver

Run `scripts/verify_media.py <video> --min-seconds 480 --max-seconds 600` for a requested eight-to-ten-minute walkthrough, or use the requested duration bounds. The script checks media integrity, not factual accuracy or visual quality.

Inspect the complete timeline for omissions, clipped text, blurred or tiny passages, distracting camera moves, caption synchronization, and clean audio. Check sensitive content and all spoken claims against the recorded commit. Report which checks were performed. Never describe a sampled frame review as watching every frame or listening to the full track.

Deliver the requested MP4, captions, transcript, chapters, and `verification.md`. Preserve the editable source, locked dependencies, raw clips, source timings, and narration audio in `source/`. Keep the previous final video when making a revision. Do not delete reusable footage after rendering. Publish or share externally only when requested.
