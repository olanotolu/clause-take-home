#!/usr/bin/env bash
# Bounded OpenAPI fuzz run against a DISPOSABLE database (it mutates documents). Requires: pip install schemathesis
#   ./scripts/fuzz/run.sh [max-examples]
set -euo pipefail
cd "$(dirname "$0")"
DB="$(mktemp -d)/fuzz.db"; PORT="${PORT:-3222}"
trap 'kill $SERVER 2>/dev/null || true' EXIT
CLAUSE_STORAGE=sqlite CLAUSE_DB="$DB" node ../../apps/api/src/seed.ts >/dev/null
CLAUSE_STORAGE=sqlite CLAUSE_DB="$DB" CLAUSE_CREATE_PER_HOUR=100000 PORT="$PORT" node ../../apps/api/src/server.ts >/dev/null 2>&1 & SERVER=$!
sleep 1.5
# /suggest is excluded: without AI credentials it correctly answers 503, which the fuzzer reports as a "server error".
# The OAuth /callback is excluded: it answers with a browser redirect to the web app's page, which this API-only server
# does not serve, so the fuzzer follows it to a 404 (the callback is covered by the integration tests instead).
# DELETE is included: the five sample contracts are read-only (403), so the fuzzer cannot wipe them, and every other
# document it deletes is disposable.
# positive_data_acceptance is excluded: random-but-schema-valid edits are legitimately refused (stale version, unknown text...).
CLAUSE_BASE="http://127.0.0.1:$PORT" SCHEMATHESIS_HOOKS=hooks \
  schemathesis run "http://127.0.0.1:$PORT/openapi.json" --max-examples "${1:-80}" --seed 20261015 --workers 2 \
  --phases fuzzing --exclude-path-regex '/(suggest|callback)$' --exclude-checks positive_data_acceptance
