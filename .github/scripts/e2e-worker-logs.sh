#!/usr/bin/env bash
# The Worker's log lines behind a failed live E2E (docs/ci.md), from `wrangler tail --format json` output: lines that
# carry a failed step's request ID, and every server-side error during the run (a numeric 5xx status, or an error line
# without one, such as a failed job) with exceptions. A failed step's last request is often a successful poll that the
# tail sampled away; the errors are what explain it. The result becomes part of a public issue, so it keeps only
# Bane's structured fields: never headers, URLs, IPs or bodies, and no message text for lines of other requests.
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
# Each tail event has logs[].message[] (Bane logs one JSON object per line, as a string or an object) and
# exceptions[].
jq -sc --argjson ids "$ids" '
  def fields: {timestamp, level, requestId, operation, method, status, code, databaseCode, jobId, message: ((.message // "") | tostring | .[0:300])} | with_entries(select(.value != null and .value != ""));
  def brief: {timestamp, level, requestId, operation, method, status, code, databaseCode, jobId} | with_entries(select(.value != null and .value != ""));
  def mentions: tostring as $text | any($ids[]; . as $id | $text | contains($id));
  [ .[] | objects ] as $events
  | [ $events[] | (.logs // [])[] | .message[]? | (if type == "string" then (try fromjson catch null) else . end) | objects ] as $lines
  | {requestIds: $ids, available: true, events: ($events | length),
     lines: [ $lines[] | select(mentions) | fields ][0:200],
     errors: [ $lines[] | select((mentions | not) and (((.status | type) == "number" and .status >= 500) or (.level == "error" and ((.status | type) != "number")))) | brief ][0:50],
     exceptions: [ $events[] | (.exceptions // [])[] | {name, message: ((.message // "") | tostring | .[0:300])} ][0:20]}
' "$tail"
