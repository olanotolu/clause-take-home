#!/usr/bin/env bash
# Bounded OpenAPI fuzz run against a DISPOSABLE database (it mutates documents). Requires: pip install schemathesis
#   ./scripts/fuzz/run.sh [max-examples]
set -euo pipefail
cd "$(dirname "$0")"
DB="$(mktemp -d)/fuzz.db"; PORT="${PORT:-3222}"
trap 'kill $SERVER 2>/dev/null || true' EXIT
CLAUSE_DB="$DB" node ../../apps/api/src/seed.ts >/dev/null
CLAUSE_DB="$DB" PORT="$PORT" node ../../apps/api/src/server.ts >/dev/null 2>&1 & SERVER=$!
sleep 1.5
# /suggest is excluded: without AI credentials it correctly answers 503, which the fuzzer reports as a "server error".
# DELETE is excluded: the fuzzer would delete every seeded document in its first requests, starving the other operations
# (covered by the integration tests instead).
# positive_data_acceptance is excluded: random-but-schema-valid edits are legitimately refused (stale version, unknown text...).
CLAUSE_BASE="http://127.0.0.1:$PORT" SCHEMATHESIS_HOOKS=hooks \
  schemathesis run "http://127.0.0.1:$PORT/openapi.json" --max-examples "${1:-80}" --seed 20261015 --workers 2 \
  --phases fuzzing --exclude-path-regex '/suggest$' --exclude-method DELETE --exclude-checks positive_data_acceptance
