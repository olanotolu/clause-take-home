# Citation support experiment

ContractNLI, Koreeda & Manning (2021), CC BY 4.0. https://stanfordnlp.github.io/contract-nli/ Labels use expert document annotations; only cases with all annotated evidence inside the supplied context are retained. This small derived set is not a legal validation.

Jev 1.14 is experimental. Neither model can authorize an edit. Threshold: selected-option probability >= 0.7; fixed before test calls. No automatic production enablement.

| Model / split | Answered | False support among non-support cases | Supported cases retained | Review / unavailable | p50 / p95 ms | Input / output tokens | Actual USD |
|---|---:|---|---|---|---|---:|---:|
| typesafe-ai/jev-1.14.0 / dev | 0/30 | n/a | n/a | 100.0% [88.6%, 100.0%] (30/30) | n/a / n/a | 0 / n/a | 0.000000 |
| typesafe-ai/jev-1.14.0 / test | 0/30 | n/a | n/a | 100.0% [88.6%, 100.0%] (30/30) | n/a / n/a | 0 / n/a | 0.000000 |
| anthropic/claude-sonnet-5.5 / dev | 24/30 | 10.0% [2.8%, 30.1%] (2/20) | 70.0% [39.7%, 89.2%] (7/10) | 20.0% [9.5%, 37.3%] (6/30) | 1761 / 2554 | 83396 / 610 | 0.172892 |
| anthropic/claude-sonnet-5.5 / test | 28/30 | 10.0% [2.8%, 30.1%] (2/20) | 70.0% [39.7%, 89.2%] (7/10) | 6.7% [1.8%, 21.3%] (2/30) | 1668 / 1876 | 55510 / 612 | 0.117140 |

Recorded cases: 81. False-support and retained-support intervals use completed calls only; unattempted cases count as unavailable in review coverage. LLM probability is self-reported and is not calibrated to Jev probability. Provider failures: 1 (HTTP 403).
Conservative cumulative cost reservations: $1.3668 of $5. Reservations include failed calls; zero actual cost means unreported usage, not proof of a free call.

Quote preflight rejected all ten fabricated cases per arm without model calls. The cited quote anchors the paragraph context; labels come from document annotations with all gold evidence retained in that context. Contexts can span most of a short NDA. This measures contextual support using those annotations, not whether the isolated quote alone is sufficient. No manual legal relabeling was performed.

Measured recommendation: keep Jev opt-in. See the held-out figures above before adopting citation screening. The committed run returned HTTP 403 for Jev, so no Jev accuracy or comparative benefit was measured. Compare false-support rate and review coverage on the held-out split; a small sample cannot establish legal reliability. Missing provider access leaves that arm unevaluated. No results have been pooled with the earlier full-document entailment benchmark.

Dataset SHA-256: 418d32a739e39355ab737ed7be79b19807b2b1907f2fab196a3dac6d0a98a8c9. Prompt SHA-256: 1875476f9cd3a7e8540083d7059a53bf99113b3b6e19d2c2deb57aecb6b1e15d.
