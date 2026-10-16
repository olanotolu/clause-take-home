# CLAUSE production design

## Scope and starting point

The deployed assessment is an open, shared demo with fictional data. It is unsuitable for confidential contracts. SQLite is the local default; hosted Vercel functions use Neon Postgres. The 10 MiB performance benchmark applies only to local SQLite. Hosted Postgres currently rejects documents above 500,000 characters. This proposal assumes typical contracts around 1 MiB, a 25 MiB tail, hundreds of workspaces, and up to 50 simultaneous editors per workspace. The proposed 99.9% availability target is unproven.

```text
Browser / API client → CDN + WAF → Stateless API → Postgres
                                    │               │
                                    ├→ Object store │
                                    └→ Durable queue → Workers → AI gateway
```

## Correctness and storage

Keep the pure edit engine and version compare-and-swap. Resolve a whole batch against one document snapshot; reject ambiguity, overlap, and stale preconditions. Store metadata, current versions, requirements, and search chunks in Postgres. Save large immutable snapshots in object storage keyed by content hash, with periodic full snapshots and bounded delta chains. Add idempotency keys for retried writes. Return receipts and content URLs for large responses to avoid function payload limits. These changes need migrations and compatibility tests before increasing the hosted size limit.

## Search and throughput

Index paragraph chunks using Postgres full-text and trigram GIN indexes, retaining source offsets and document versions. Rank and paginate before generating snippets. Small edits update indexes transactionally; large ingestion jobs use an outbox and durable workers. Responses expose indexed versions, and the UI explains lag and verifies passage offsets before selection. Begin with database indexes and two API replicas. Add replicas or a dedicated search service only after measurements identify the bottleneck. SQLite's measured eight-writer p95 of 879 ms motivates testing Postgres throughput; it does not predict production capacity.

## Access and data handling

Require workspace authentication and authorization on every route before accepting customer data. Use OIDC, workspace roles, tenant IDs, and tested Postgres row-level policies. Scope connector credentials, caches, object keys, and jobs to a workspace. Encrypt transport and storage, keep secrets in managed storage, and define retention and deletion across revisions, exports, backups, and AI providers. Append actor IDs, version hashes, and actions to a tamper-evident audit stream without logging contract text. Regional cells provide residency with one writer per document. SOC 2 and GDPR require operating evidence and legal review.

## Operations and delivery

Use pooled database connections, durable tenant rate limits and AI budgets. Bound request deadlines, queue depth, file sizes, and batch sizes. AI proposals remain advisory, pinned to a document version, and validated again on acceptance. Jev stays opt-in pending representative evidence. Monitor latency by size, conflict rate, index lag, queue age, errors, and provider spending. Initial targets are edit p95 below 500 ms and search below 300 ms for 1 MiB documents. Alert on sustained error-budget burn. Use multi-zone database failover, PITR, restore drills, idempotent workers, and a dead-letter queue. CI gates typecheck, coverage, both adapters, browser journeys, and migration compatibility. Roll out through previews with reversible schema changes and a documented rollback. Track cost per thousand edits and revision GB-month. Detailed assumptions and alternatives remain in the [appendix](docs/INFRA_APPENDIX.md).
