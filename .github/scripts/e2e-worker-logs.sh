#!/usr/bin/env bash
# The Worker's log lines for the requests of a failed live E2E's failed steps (docs/ci.md), from `wrangler tail
# --format json` output. The result becomes part of a public issue, so it keeps only lines that carry one of those
# request IDs and only Bane's structured fields: never headers, URLs, IPs or bodies.
#   e2e-worker-logs.sh <e2e-report.json> <tail.jsonl> <tail.err>  > e2e-worker-logs.json
set -euo pipefail
report=$1 tail=$2 err=$3
ids=$(jq -c '[.steps[] | select(.status == "fail") | .requestId // empty] | unique' "$report")
if [[ ! -s $tail ]]; then
  reason='no tail output'
  if grep -qiE 'authentication|permission|forbidden|10000|unauthorized' "$err" 2>/dev/null; then reason='the dev token cannot tail Workers (add Workers Tail Read in anomalyco/secrets)'; fi
  jq -n --argjson ids "$ids" --arg reason "$reason" '{requestIds: $ids, available: false, reason: $reason, lines: []}'
  exit 0
fi
# Each tail event has logs[].message[] (Bane logs one JSON object per line) and exceptions[].
jq -sc --argjson ids "$ids" '
  def fields: {timestamp, level, requestId, operation, method, status, code, databaseCode, jobId, message: ((.message // "") | tostring | .[0:300])} | with_entries(select(.value != null and .value != ""));
  [ .[] | (.logs // [])[] | .message[]? | (try fromjson catch null) | objects | select(.requestId as $id | $ids | index($id)) | fields ]
  | {requestIds: $ids, available: true, lines: .[0:200]}
' "$tail"
