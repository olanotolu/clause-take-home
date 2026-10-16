# CLAUSE CI benchmark results

Generated 2026-10-16 by `pnpm bench:ci:report` from the raw answers in `bench/ci/results/`. Nothing below is typed by hand.

## What was measured

Can a judge tell whether a contract **satisfies a requirement**, and does it notice when an edit **stops** satisfying it? Data: [ContractNLI](https://stanfordnlp.github.io/contract-nli/) (Koreeda & Manning, *Findings of EMNLP 2021*; CC BY 4.0): real NDAs with expert labels and evidence spans. The requirement text is ContractNLI's own hypothesis wording.

- **Static task** (n=60, 20 per label from the test split): classify each document as *Entailment*, *Contradiction* or *NotMentioned* for one hypothesis.
- **Regression task** (n=30 pairs): for a hypothesis the experts marked *Entailment*, (a) **delete the expert-marked evidence sentences** (should stop being satisfied) and (b) as a control **delete 3 unrelated sentences** (should stay satisfied). Edits are applied with CLAUSE's own edit engine.
- Cases, seed (20261015) and thresholds were **committed before any judge ran** on them (commit `cafc0d5`). The keyword baseline's one threshold was tuned on the dev split only (dev macro-F1 0.4537).

## Judges

- **keyword-baseline**: no model; best-matching sentence by distinctive-word overlap (τ=0.2), negation mismatch ⇒ contradicted. Its quotes are real sentences, so they verify.
- **anthropic/claude-sonnet-5.5**
- **typesafe-ai/jev-1.14.0: not run.** Vercel AI Gateway serves it only to teams with paid credits (the call returned HTTP 403, "Free tier users do not have access to this model"). The Jev judge is implemented and unit-tested; it has **no measured results here**, so no claim is made about it.

## Static task: three-way classification

| Judge | Accuracy [95% CI] | Macro-F1 | Entailment recall | Contradiction recall | NotMentioned recall | Abstained/errored | Brier |
|---|---|---|---|---|---|---|---|
| keyword-baseline | 40.0% [28.6%, 52.6%] (24/60) | 0.373 | 70.0% | 30.0% | 20.0% | 0 | 0.238 |
| anthropic/claude-sonnet-5.5 | 80.0% [68.2%, 88.2%] (48/60) | 0.823 | 95.0% | 80.0% | 65.0% | 4 | 0.069 |

Chance for three balanced classes is 33.3% accuracy. *Brier* scores the judge's own P(entailed) against the truth (lower is better; 0.25 = coin flip); the keyword baseline has no probability.

## Regression task: does a judge notice that an edit broke a requirement?

Counted only on pairs where the judge saw the requirement as satisfied **before** the edit (otherwise there is nothing to regress).

| Judge | Usable pairs | Edit that removes the evidence is flagged | Harmless edit wrongly flagged | Tells the two apart | Flagged, counting unusable pairs as misses |
|---|---|---|---|---|---|
| keyword-baseline | 17/30 | 23.5% [9.6%, 47.3%] (4/17) | 0.0% [0.0%, 18.4%] (0/17) | 23.5% [9.6%, 47.3%] (4/17) | 13.3% [5.3%, 29.7%] (4/30) |
| anthropic/claude-sonnet-5.5 | 28/30 | 78.6% [60.5%, 89.8%] (22/28) | 0.0% [0.0%, 12.1%] (0/28) | 78.6% [60.5%, 89.8%] (22/28) | 73.3% [55.6%, 85.8%] (22/30) |

*Tells the two apart* = flagged the evidence-deleting edit **and** did not flag the harmless one, in the same pair (the strictest, paired measure).

## What a user would actually see (CLAUSE CI's policy applied to each judge alone)

A PASS needs a quote that is verified verbatim in the text, so a judge that cites nothing can never PASS.

| Judge | Usable pairs (PASS before) | Evidence-deleting edit: FAIL / NEEDS_REVIEW | Harmless edit: FAIL / NEEDS_REVIEW |
|---|---|---|---|
| keyword-baseline | 17/30 | 4 / 0 (of 17) | 0 / 0 (of 17) |
| anthropic/claude-sonnet-5.5 | 28/30 | 15 / 7 (of 28) | 0 / 0 (of 28) |

## Evidence integrity, latency, cost

| Judge | Quotes found verbatim in the text | Latency p50 / p95 per call | Tokens (in / out) | Cost for this run |
|---|---|---|---|---|
| keyword-baseline | 100.0% [97.1%, 100.0%] (129/129) | 1 ms / 2 ms | n/a | n/a |
| anthropic/claude-sonnet-5.5 | 100.0% [98.0%, 100.0%] (191/191) | 2.4 s / 5.0 s | 600,726 / 32,145 | $1.52 (150 calls) |

## How to read this, and its limits

- **Small samples.** n=60 static items and 30 pairs give wide intervals (a 95% interval on 30 trials is roughly ±17 points). Differences between rows that fall inside each other's intervals are **not evidence that one judge is better**.
- **Automatic labels have noise.** The regression 'truth' assumes the experts marked *all* supporting sentences; if one was missed, deleting the marked ones may not remove entailment, which would show up as a missed flag that is the label's fault, not the judge's.
- **NDAs only**, English, documents ≤ 20,000 characters. Nothing here says how any judge behaves on other contract types.
- One run per judge at temperature 0; models can change behind an alias, so the exact model ids above are part of the result.
- This measures whether a judge's answer matches the experts' labels. It does not measure legal correctness, and CLAUSE CI's reports remain advisory.

Dataset: ContractNLI, Koreeda & Manning (2021), CC BY 4.0, https://stanfordnlp.github.io/contract-nli/
