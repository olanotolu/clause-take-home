# Citation experiment

This benchmark is separate from production judging and the older whole-document benchmark. Jev remains opt-in. [RESULTS.md](RESULTS.md) is generated from [raw records](results/raw.jsonl), never from hand-entered scores.

## Reproduce without spending

```sh
pnpm bench:citations          # quote preflight and report; no inference
pnpm exec vitest run bench/citations/citations.test.ts
```

`cases.json` freezes 30 development and 30 held-out cases, ten per label per split, plus ten fabricated quotes. It retains document IDs, source and quote offsets, and SHA-256 source hashes. Sampling is deterministic from the official ContractNLI dev/test files. Download them with `node bench/ci/fetch-data.ts` before `pnpm bench:citations --freeze`. Re-freezing refuses changed inputs after a run exists. The public [ContractNLI dataset](https://stanfordnlp.github.io/contract-nli/), Koreeda & Manning (2021), is CC BY 4.0.

Quotes must first exist under the service's exact whitespace-normalized quote verifier. Missing quotes cost nothing. Context includes the containing paragraph and adjacent paragraphs, at most 8,000 characters. Oversized context requires review without inference. All gold evidence spans must fit the selected context. Labels remain document-level expert labels used as a contextual-support proxy; this is not a human-labeled test of whether the isolated quote suffices. Short NDAs can fit nearly entirely within a context. The selected cases are not a random representative sample of legal work.

## Optional paid run

```sh
pnpm bench:citations --live
```

Existing OpenRouter credentials run the baseline; existing AI Gateway credentials run pinned Jev 1.14.0. The runner sends calls serially, disables retries, and stops a provider on failure. It reserves a conservative maximum before each paid call in an atomically replaced ledger. A failed/pending call keeps its full reservation. The total cap is $5 across providers and resumes, not $5 per provider. Completed cases and failed arms are not retried. Raw records retain model/version hashes, dataset/prompt hashes, probabilities, decisions, timing, tokens, reported cost, and reservations. Dev and held-out figures remain separate.

Published pricing must be available from the [AI Gateway catalog](https://ai-gateway.vercel.sh/v1/models) or [OpenRouter catalog](https://openrouter.ai/api/v1/models). At the run, Jev input was $0.000000042/token with zero output price; baseline input/output were $0.000002/$0.00001 per token. Input reservations use UTF-8 bytes plus 4,096 framing tokens, and baseline output is capped at 200 tokens. The Jev runner refuses nonzero output pricing because the decision endpoint has no output-token cap. Usage cost is an estimate from reported tokens and published rates, not an invoice.

An exclusive `results/.run-lock` directory prevents concurrent paid runners. If the process is killed, first confirm no experiment process is running, then remove the **empty** lock with `rmdir bench/citations/results/.run-lock` and resume. Do not delete or trim the ledger: it preserves spending from interrupted calls. Invalid or truncated ledger data fails closed and requires reconciliation before any further calls. No automatic plan purchase, provider substitution, or production enablement occurs.
