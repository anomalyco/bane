#!/usr/bin/env bash
# Opens an issue for a failed live dev E2E, or comments on the open one (docs/ci.md). Reads the run's artifact:
# e2e-report.json (steps, request IDs) and e2e-worker-logs.json (Worker lines for those requests, when available).
#   e2e-issue.sh <artifact dir>      env: GH_TOKEN, GITHUB_REPOSITORY, SHA, RUN_URL
set -euo pipefail
dir=$1 label=dev-e2e
report=$dir/e2e-report.json logs=$dir/e2e-worker-logs.json
[[ -f $report ]] || { echo "::error::No e2e-report.json in the artifact"; exit 1; }
failed=$(jq -r '[.steps[] | select(.status == "fail")] | length' "$report")
first=$(jq -r '[.steps[] | select(.status == "fail") | .name][0] // "OpenAPI coverage"' "$report")
body=$(mktemp)
{
  echo "The live dev E2E failed for \`$SHA\`: $failed failed step(s). Production stays blocked until a dev E2E passes for a newer commit. [Deploy run]($RUN_URL)"
  echo
  jq -r '"**" + .status + "** — " + (.coverage.passed | length | tostring) + "/" + (.coverage.total | tostring) + " operations in passing steps, " + (.ms / 1000 | floor | tostring) + " s"' "$report"
  echo
  echo '| Step | Error | Request ID |'
  echo '| --- | --- | --- |'
  jq -r '.steps[] | select(.status == "fail") | "| \(.name | gsub("\\|"; "\\|")) | \((.error // "") | gsub("\\|"; "\\|") | gsub("[\r\n]+"; " ") | .[0:300]) | `\(.requestId // "unavailable")` |"' "$report"
  if jq -e '.coverage.notReached | length > 0' "$report" >/dev/null; then
    echo
    echo "Not reached: $(jq -r '.coverage.notReached | join(", ")' "$report")"
  fi
  echo
  if [[ -f $logs ]] && jq -e '.available' "$logs" >/dev/null; then
    echo "<details><summary>Worker logs from $(jq '.events // "?"' "$logs") tailed events: $(jq '.lines | length' "$logs") line(s) for these requests, $(jq '.errors // [] | length' "$logs") server error(s), $(jq '.exceptions // [] | length' "$logs") exception(s)</summary>"
    echo
    echo '```json'
    jq -c '(.lines[]), ((.errors // [])[] | {serverError: .}), ((.exceptions // [])[] | {exception: .})' "$logs"
    echo '```'
    echo
    echo '</details>'
  else
    echo "Worker log lines: unavailable ($(jq -r '.reason // "no tail artifact"' "$logs" 2>/dev/null || echo 'no tail artifact')). Search the request IDs in the bane-dev Worker's logs in the Cloudflare dashboard."
  fi
  echo
  echo 'What to do: docs/ci.md, "When the dev E2E fails".'
} > "$body"
gh label create "$label" -R "$GITHUB_REPOSITORY" --color B60205 --description 'Live dev E2E failures' --force >/dev/null
open=$(gh issue list -R "$GITHUB_REPOSITORY" --label "$label" --state open --json number --jq '.[0].number // empty')
if [[ -n $open ]]; then
  gh issue comment "$open" -R "$GITHUB_REPOSITORY" --body-file "$body"
else
  gh issue create -R "$GITHUB_REPOSITORY" --label "$label" --title "Dev E2E failed: $first (${SHA:0:7})" --body-file "$body"
fi
cat "$body" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
