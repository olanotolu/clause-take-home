# Search snapshot regression check

## Original measurement, retained

The previous README recorded a deterministic 10 MiB synthetic contract on local SQLite, Apple M4 / 32 GiB, Node 26.7, with load average around 8. Rare-word search took 16 ms, common-phrase search 20 ms, exact unique/common search 14/51 ms. A single full-stack edit took 713 ms, a 100-edit batch 900 ms, and preview 155 ms. These historical numbers remain historical; they are not a controlled comparison with Node 24.

## Paired rerun, October 16, 2026

The unchanged `bench/run.ts` generated the same 10,485,779-byte / 10,306,991-character contract, with five repeats per search. Both runs used local SQLite 3.53.0, Node 24.15.0, Apple M4 / 32 GiB, and the same machine session. The baseline was API commit `6cdb601`; the next run included snapshot reads. Each run used its own temporary database. Raw logs retain environment and every operation.

| Operation | Before | Snapshot reads | Change |
|---|---:|---:|---:|
| Words, rare token | 19.8 ms | 20.6 ms | +0.8 ms |
| Words, common phrase | 23.8 ms | 24.5 ms | +0.7 ms |
| Exact, unique | 15.8 ms | 15.8 ms | 0 |
| Exact, many hits | 51.8 ms | 52.2 ms | +0.4 ms |
| Full-stack single edit | 818.8 ms | 788.8 ms | -30.0 ms |
| Full-stack 100 edits | 852.5 ms | 772.6 ms | -79.9 ms |
| Preview | 122.4 ms | 122.6 ms | +0.2 ms |

[Before raw output](before-snapshot-node24.txt) · [After raw output](after-snapshot-node24.txt)

Search snapshot reads add about 1 ms in this run. The common-word path stays bounded; the previous multi-second native-snippet failure did not return. This is one paired run under background load, not a statistical performance guarantee. Unrelated edit timing varies and does not establish an improvement. No thresholds were tuned from these measurements. Hosted Postgres was not benchmarked at 10 MiB and still has a 500,000-character cap.

## Concurrency, SQLite and Postgres (October 17, 2026)

`pnpm load [workers] [seconds]` starts a throwaway server and drives read, search and edit scenarios at fixed concurrency. Two options matter for honest numbers:

- `--warmup=N` (default 3) runs each scenario for N seconds first and discards it. A freshly loaded Postgres database was far slower for its first seconds (words search p95 4,393 ms cold against 129–158 ms warmed); SQLite showed no difference. `--warmup=0` turns it off to see the effect.
- `--storage=postgres` uses documents sized to the hosted 500,000-character cap and needs `CLAUSE_LOAD_DATABASE_URL`, a disposable database (the documents it creates are deleted at the end).

Warmed, 8 clients, Node 24.15, over HTTP, on an Apple M4 that was busy with other work (load average 15–45), two runs each:

| p95 | SQLite, 1 MB docs | Postgres, 0.47 MB docs |
|---|---|---|
| read | 27–49 ms | 19–21 ms |
| words search | 522–543 ms | 129–158 ms |
| exact search | 1,096–1,159 ms | 240–246 ms |
| edit | 1,944–2,387 ms | 437–443 ms (27 edits/s) |

The SQLite figures are about twice the ones in `INFRA.md`, which were taken on a quiet machine; the load average, not the code, explains the gap, and that is why the tables in `INFRA.md` and the README call laptop numbers ranges. The Postgres figures meet the targets in `INFRA.md`, with little headroom on edits.
