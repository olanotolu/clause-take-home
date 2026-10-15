#!/usr/bin/env bash
# CLAUSE end-to-end walkthrough using only curl + jq.
#   pnpm dev        (in another terminal; default http://127.0.0.1:3000)
#   BASE=http://127.0.0.1:3000 ./http/demo.sh
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:3000}"
H='content-type: application/json'
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1. Create a contract where the same phrase appears three times"
TEXT=$'1. Receiving Party shall not disclose Confidential Information.\n2. Disclosing Party shall not disclose Trade Secrets.\n3. Neither party shall not disclose the Term.'
DOC=$(curl -s -X POST "$BASE/documents" -H "$H" -d "$(jq -n --arg t "$TEXT" '{title:"Demo NDA", content:$t}')")
ID=$(jq -r .id <<<"$DOC"); echo "id=$ID version=$(jq .version <<<"$DOC")"

say "2. Naive edit is AMBIGUOUS -> refused (409), nothing changes. Candidates tell you where."
curl -s -X PATCH "$BASE/documents/$ID" -H "$H" \
  -d '{"expectedVersion":1,"changes":[{"operation":"replace","target":{"quote":{"exact":"shall not disclose"}},"replacement":"may disclose"}]}' \
  | jq '{code,type,error,candidates:[.details.candidates[]|{start,end}]}'

say "3. Find the passage; every hit carries a selector that resolves to exactly that span"
HIT=$(curl -s "$BASE/documents/$ID/search?q=shall%20not%20disclose&mode=exact" | jq '.result.hits[1]')
echo "$HIT" | jq '{start,end,target}'
TARGET=$(jq -c .target <<<"$HIT")

say "4. Preview the edit (nothing is saved): receipt + unified diff"
BODY=$(jq -n --argjson t "$TARGET" '{expectedVersion:1, changes:[{operation:"replace", target:$t, replacement:"may disclose"}]}')
curl -s -X POST "$BASE/documents/$ID/changes/preview" -H "$H" -d "$BODY" | jq -r '.diff' | tail -n +5

say "5. Apply it: full updated text, new version, receipt with hashes"
curl -s -X PATCH "$BASE/documents/$ID" -H "$H" -d "$BODY" | jq '{version,previousVersion,changed,beforeHash:.beforeHash[0:12],afterHash:.afterHash[0:12],applied,content}'

say "6. Replay the SAME request against the old version -> 409 VERSION_CONFLICT (never auto-merged)"
curl -s -X PATCH "$BASE/documents/$ID" -H "$H" -d "$BODY" | jq '{code,type,error}'

say "7. If-Match works too: stale ETag -> 412"
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PATCH "$BASE/documents/$ID" -H "$H" -H 'If-Match: "v1-000000000000"' \
  -d '{"changes":[{"operation":"replace","target":{"quote":{"exact":"Trade Secrets"}},"replacement":"x"}]}'

say "8. Search reflects the committed revision"
printf 'exact "shall not disclose": %s occurrences\n' "$(curl -s "$BASE/documents/$ID/search?q=shall%20not%20disclose&mode=exact" | jq '.result.matchCount')"
printf 'exact "may disclose":       %s occurrence\n'  "$(curl -s "$BASE/documents/$ID/search?q=may%20disclose&mode=exact" | jq '.result.matchCount')"
curl -s "$BASE/documents/search?q=disclose&limit=3" | jq '{total, top:[.results[]|{title,relevance,snippet:(.hits[0].snippet|map(if .match then "["+.text+"]" else .text end)|join(""))}]}'

say "9. History keeps every revision"
curl -s "$BASE/documents/$ID/revisions" | jq '.items|map({version,contentHash:.contentHash[0:12]})'
