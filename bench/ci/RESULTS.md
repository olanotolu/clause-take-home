# CLAUSE CI benchmark results

Generated 2026-10-19 by `pnpm bench:ci:report` from the raw answers in `bench/ci/results/`. Nothing below is typed by hand.

## What was measured

Can a judge tell whether a contract **satisfies a requirement**, and does it notice when an edit **stops** satisfying it? Data: [ContractNLI](https://stanfordnlp.github.io/contract-nli/) (Koreeda & Manning, *Findings of EMNLP 2021*; CC BY 4.0): real NDAs with expert labels and evidence spans. The requirement text is ContractNLI's own hypothesis wording.

- **Static task** (n=60, 20 per label from the test split): classify each document as *Entailment*, *Contradiction* or *NotMentioned* for one hypothesis.
- **Regression task** (n=30 pairs): for a hypothesis the experts marked *Entailment*, (a) **delete the expert-marked evidence sentences** (should stop being satisfied) and (b) as a control **delete 3 unrelated sentences** (should stay satisfied). Edits are applied with CLAUSE's own edit engine.
- **CUAD task** (n=72 fixed cases, contracts ≤20,000 characters): test contract clauses across 41 expert-annotated categories. Each category contributes a deterministic positive and negative example when available; cases use the official CUAD test split.
- Cases, seed (20261015) and thresholds were **committed before any judge ran** on them (commit `cafc0d5`). The keyword baseline's one threshold was tuned on the dev split only (dev macro-F1 0.4537).

## Judges

- **keyword-baseline**: no model; best-matching sentence by distinctive-word overlap (τ=0.2), negation mismatch ⇒ contradicted. Its quotes are real sentences, so they verify.
- **anthropic/claude-sonnet-5.5**
- **jev-1.14.0: not run in this benchmark invocation.** Set a replacement `TYPESAFE_API_KEY` to produce measured results. No performance or accuracy claim is made without those results.

## Static task: three-way classification

| Judge | Answered / frozen | Accuracy [95% CI] | Macro-F1 | Entailment recall | Contradiction recall | NotMentioned recall | Abstained/errored | Brier |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| keyword-baseline | 60/60 | 40.0% [28.6%, 52.6%] (24/60) | 0.373 | 70.0% | 30.0% | 20.0% | 0 | 0.238 |
| anthropic/claude-sonnet-5.5 | 60/60 | 80.0% [68.2%, 88.2%] (48/60) | 0.823 | 95.0% | 80.0% | 65.0% | 4 | 0.069 |

Chance for three balanced classes is 33.3% accuracy. *Brier* scores the judge's own P(entailed) against the truth (lower is better; 0.25 = coin flip); the keyword baseline has no probability.

## Choice confidence and calibration

| Judge | Mean selected-label confidence | Selected-label Brier | 10-bin ECE | n |
|---|---:|---:|---:|---:|
| keyword-baseline | n/a | n/a | n/a | 0 |
| anthropic/claude-sonnet-5.5 | n/a | n/a | n/a | 0 |

Selected-label probability calibration uses the probability Jev assigned to its chosen class. The separately returned Jev `confidence` field is only a distribution-shape measure; its mean is shown for context and is not treated as probability of correctness.

## Regression task: does a judge notice that an edit broke a requirement?

Counted only on pairs where the judge saw the requirement as satisfied **before** the edit (otherwise there is nothing to regress).

| Judge | Answered texts / 90 | Usable pairs | Edit that removes the evidence is flagged | Harmless edit wrongly flagged | Tells the two apart | Flagged, counting unusable pairs as misses |
|---|---:|---:|---|---|---|---|
| keyword-baseline | 90/90 | 17/30 | 23.5% [9.6%, 47.3%] (4/17) | 0.0% [0.0%, 18.4%] (0/17) | 23.5% [9.6%, 47.3%] (4/17) | 13.3% [5.3%, 29.7%] (4/30) |
| anthropic/claude-sonnet-5.5 | 90/90 | 28/30 | 78.6% [60.5%, 89.8%] (22/28) | 0.0% [0.0%, 12.1%] (0/28) | 78.6% [60.5%, 89.8%] (22/28) | 73.3% [55.6%, 85.8%] (22/30) |

*Tells the two apart* = flagged the evidence-deleting edit **and** did not flag the harmless one, in the same pair (the strictest, paired measure).

## What a user would actually see (CLAUSE CI's policy applied to each judge alone)

A PASS needs a quote that is verified verbatim in the text, so a judge that cites nothing can never PASS.

| Judge | Usable pairs (PASS before) | Evidence-deleting edit: FAIL / NEEDS_REVIEW | Harmless edit: FAIL / NEEDS_REVIEW |
|---|---|---|---|
| keyword-baseline | 17/30 | 4 / 0 (of 17) | 0 / 0 (of 17) |
| anthropic/claude-sonnet-5.5 | 28/30 | 15 / 7 (of 28) | 0 / 0 (of 28) |

## CUAD: clause detection

A raw `entailed` model label is counted as clause detection so Jev can be compared despite not generating a quote. Product PASS still requires verified evidence from the existing judge. False PASS rate is measured on agreements annotated as lacking the category. Provider failures count as no detection; answered and attempted coverage are shown.

| Judge | Answered / attempted / frozen | Accuracy [95% CI] | False PASS rate [95% CI] |
|---|---:|---|---|
| keyword-baseline | 72/72/72 | 58.3% [46.8%, 69.0%] (42/72) | 43.6% [29.3%, 59.0%] (17/39) |
| anthropic/claude-sonnet-5.5 | 3/72/72 | 54.2% [42.7%, 65.2%] (39/72) | 0.0% [0.0%, 9.0%] (0/39) |

### keyword-baseline by CUAD category

| Category | Cases | Accuracy [95% CI] | False PASS [95% CI] |
|---|---:|---|---|
| Affiliate License-Licensee | 2/2 | 0.0% [0.0%, 65.8%] (0/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Affiliate License-Licensor | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Agreement Date | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Anti-Assignment | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Audit Rights | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Cap On Liability | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Change Of Control | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Competitive Restriction Exception | 1/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Covenant Not To Sue | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Document Name | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | n/a |
| Effective Date | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Exclusivity | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Expiration Date | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Governing Law | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Insurance | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Ip Ownership Assignment | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Irrevocable Or Perpetual License | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Joint Ip Ownership | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | 100.0% [20.7%, 100.0%] (1/1) |
| License Grant | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Liquidated Damages | 2/2 | 0.0% [0.0%, 65.8%] (0/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Minimum Commitment | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Most Favored Nation | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | 100.0% [20.7%, 100.0%] (1/1) |
| No-Solicit Of Customers | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| No-Solicit Of Employees | 1/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Non-Compete | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Non-Disparagement | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | 100.0% [20.7%, 100.0%] (1/1) |
| Non-Transferable License | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Notice Period To Terminate Renewal | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Parties | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | n/a |
| Post-Termination Services | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Price Restrictions | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | 100.0% [20.7%, 100.0%] (1/1) |
| Renewal Term | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Revenue/Profit Sharing | 2/2 | 0.0% [0.0%, 65.8%] (0/2) | 100.0% [20.7%, 100.0%] (1/1) |
| Rofr/Rofo/Rofn | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Source Code Escrow | 1/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Termination For Convenience | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Third Party Beneficiary | 1/1 | 0.0% [0.0%, 79.3%] (0/1) | 100.0% [20.7%, 100.0%] (1/1) |
| Uncapped Liability | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Unlimited/All-You-Can-Eat-License | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Volume Restriction | 2/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Warranty Duration | 2/2 | 100.0% [34.2%, 100.0%] (2/2) | 0.0% [0.0%, 79.3%] (0/1) |

### anthropic/claude-sonnet-5.5 by CUAD category

| Category | Cases | Accuracy [95% CI] | False PASS [95% CI] |
|---|---:|---|---|
| Affiliate License-Licensee | 1/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Affiliate License-Licensor | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Agreement Date | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Anti-Assignment | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Audit Rights | 1/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Cap On Liability | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Change Of Control | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Competitive Restriction Exception | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Covenant Not To Sue | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Document Name | 0/1 | 0.0% [0.0%, 79.3%] (0/1) | n/a |
| Effective Date | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Exclusivity | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Expiration Date | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Governing Law | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Insurance | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Ip Ownership Assignment | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Irrevocable Or Perpetual License | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Joint Ip Ownership | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| License Grant | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Liquidated Damages | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Minimum Commitment | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Most Favored Nation | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| No-Solicit Of Customers | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| No-Solicit Of Employees | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Non-Compete | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Non-Disparagement | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Non-Transferable License | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Notice Period To Terminate Renewal | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Parties | 0/1 | 0.0% [0.0%, 79.3%] (0/1) | n/a |
| Post-Termination Services | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Price Restrictions | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Renewal Term | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Revenue/Profit Sharing | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Rofr/Rofo/Rofn | 1/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Source Code Escrow | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Termination For Convenience | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Third Party Beneficiary | 0/1 | 100.0% [20.7%, 100.0%] (1/1) | 0.0% [0.0%, 79.3%] (0/1) |
| Uncapped Liability | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Unlimited/All-You-Can-Eat-License | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Volume Restriction | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
| Warranty Duration | 0/2 | 50.0% [9.5%, 90.5%] (1/2) | 0.0% [0.0%, 79.3%] (0/1) |
## Evidence integrity, latency, cost

| Judge | Calls / errors | Quotes found verbatim in the text | Latency p50 / p90 / p95 / p99 per answered call | Tokens (in / out) | Estimated cost from reported tokens |
|---|---:|---|---|---|---|
| keyword-baseline | 222 / 0 | 100.0% [97.9%, 100.0%] (179/179) | 1 ms / 3 ms / 3 ms / 5 ms | n/a | n/a |
| anthropic/claude-sonnet-5.5 | 226 / 73 | 100.0% [98.0%, 100.0%] (191/191) | 2.4 s / 3.4 s / 5.0 s / 5.7 s | 606,111 / 32,412 | $1.54 |

## How to read this, and its limits

- **Small samples.** n=60 static items and 30 pairs give wide intervals (a 95% interval on 30 trials is roughly ±17 points). Differences between rows that fall inside each other's intervals are **not evidence that one judge is better**.
- **Automatic labels have noise.** The regression 'truth' assumes the experts marked *all* supporting sentences; if one was missed, deleting the marked ones may not remove entailment, which would show up as a missed flag that is the label's fault, not the judge's.
- ContractNLI covers English NDAs up to 20,000 characters; CUAD covers commercial contracts across 41 categories, sampled from contracts up to 20,000 characters.
- One run per judge at temperature 0; models can change behind an alias, so the exact model ids above are part of the result.
- This measures whether a judge's answer matches the experts' labels. It does not measure legal correctness, and CLAUSE CI's reports remain advisory.

Datasets: ContractNLI, Koreeda & Manning (2021), CC BY 4.0, https://stanfordnlp.github.io/contract-nli/; CUAD, The Atticus Project (2021), CC BY 4.0, https://www.atticusprojectai.org/cuad/.
