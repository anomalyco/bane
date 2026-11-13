#!/usr/bin/env bash
# Usage: dev-proof.sh <sha>. Production deploys only a commit dev has proven: a live dev E2E that passed and a dev
# push CI that passed, both for exactly this SHA. The dev deploy runs alongside dev CI, so CI may still be running
# when production asks: wait for it (CI_WAIT_SECONDS, default 25 minutes), and fail as soon as it fails.
set -euo pipefail
sha=$1 repo="repos/$GITHUB_REPOSITORY" wait=${CI_WAIT_SECONDS:-1500} poll=${CI_POLL_SECONDS:-20}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <sha>" >&2; exit 2; }

# The dev deploy job's name comes from the same pinned output as its checkout, so its E2E step proves this commit.
e2e=
for ((page=1; ; page++)); do
  runs=$(gh api "$repo/actions/workflows/deploy.yml/runs?status=success&branch=dev&per_page=100&page=$page")
  [[ $(jq '.workflow_runs | length' <<< "$runs") != 0 ]] || break
  ids=$(jq -r --arg title "Deploy dev $sha" --arg repo "$GITHUB_REPOSITORY" '.workflow_runs[] | select(.display_title == $title and .conclusion == "success" and .head_branch == "dev" and .head_repository.full_name == $repo and (.event == "push" or .event == "workflow_run" or .event == "workflow_dispatch")) | .id' <<< "$runs")
  for id in $ids; do
    if gh api "$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
      jq -e --arg job "Deploy dev $sha" 'any(.jobs[]; .name == $job and .conclusion == "success" and any(.steps[]; .name == "Live dev E2E" and .conclusion == "success"))' >/dev/null; then
      e2e=$id; break 2
    fi
  done
done
[[ -n $e2e ]] || { echo "::error::No successful deploy.yml dev job with a passing live E2E for exactly $sha"; exit 1; }
echo "Live dev E2E passed for $sha in run $e2e."

deadline=$((SECONDS + wait))
while :; do
  runs=$(gh api "$repo/actions/workflows/ci.yml/runs?event=push&branch=dev&head_sha=$sha&per_page=100" |
    jq -c --arg sha "$sha" --arg repo "$GITHUB_REPOSITORY" '[.workflow_runs[] | select(.head_sha == $sha and .head_repository.full_name == $repo and .event == "push" and .head_branch == "dev") | {id, status, conclusion}]')
  ci=$(jq -r '[.[] | select(.conclusion == "success") | .id][0] // empty' <<< "$runs")
  if [[ -n $ci ]]; then echo "Dev push CI passed for $sha in run $ci."; exit 0; fi
  if ! jq -e 'any(.[]; .status != "completed")' <<< "$runs" >/dev/null; then
    echo "::error::No passing dev push CI for $sha ($(jq -r 'if length == 0 then "no run" else map("run \(.id): \(.conclusion)") | join(", ") end' <<< "$runs"))."
    exit 1
  fi
  if (( SECONDS >= deadline )); then echo "::error::Dev push CI for $sha was still running after $((wait / 60)) minutes."; exit 1; fi
  echo "Dev push CI for $sha is still running; checking again in ${poll}s."
  sleep "$poll"
done
