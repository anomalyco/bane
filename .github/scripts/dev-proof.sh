#!/usr/bin/env bash
# Usage: dev-proof.sh <sha>. Require this SHA's live dev E2E plus CI on its queue tree or its exact dev push.
set -euo pipefail
sha=$1 repo="repos/$GITHUB_REPOSITORY" wait=${CI_WAIT_SECONDS:-1500} poll=${CI_POLL_SECONDS:-20}
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <sha>" >&2; exit 2; }

# The dev deploy job's name comes from the same pinned output as its checkout, so its E2E step proves this commit.
# Only that job and its E2E count, not the run's conclusion: a later job in the run (the support Worker's deploy) can
# fail without saying anything about Bane, and must not hold back a Bane release.
e2e=
for ((page=1; ; page++)); do
  # Support and the promotion job itself may still be running. Only the completed Bane job is proof.
  runs=$(gh api "$repo/actions/workflows/deploy.yml/runs?branch=dev&per_page=100&page=$page")
  [[ $(jq '.workflow_runs | length' <<< "$runs") != 0 ]] || break
  ids=$(jq -r --arg title "Deploy dev $sha" --arg repo "$GITHUB_REPOSITORY" '.workflow_runs[] | select(.display_title == $title and .head_branch == "dev" and .head_repository.full_name == $repo and (.event == "push" or .event == "workflow_run" or .event == "workflow_dispatch")) | .id' <<< "$runs")
  for id in $ids; do
    if gh api "$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
      jq -e --arg job "Deploy dev $sha" 'any(.jobs[]; .name == $job and .conclusion == "success" and any(.steps[]; .name == "Live dev E2E" and .conclusion == "success"))' >/dev/null; then
      e2e=$id; break 2
    fi
  done
done
[[ -n $e2e ]] || { echo "::error::No successful deploy.yml dev job with a passing live E2E for exactly $sha"; exit 1; }
echo "Live dev E2E passed for $sha in run $e2e."

tree=$(git rev-parse --verify "$sha^{tree}")
deadline=$((SECONDS + wait))
while :; do
  runs=$(gh api "$repo/actions/workflows/ci.yml/runs?event=push&branch=dev&head_sha=$sha&per_page=100" |
    jq -c --arg sha "$sha" --arg repo "$GITHUB_REPOSITORY" '[.workflow_runs[] | select(.head_sha == $sha and .head_repository.full_name == $repo and .event == "push" and .head_branch == "dev") | {id, status, conclusion}]')
  ci=$(jq -r '[.[] | select(.conclusion == "success") | .id][0] // empty' <<< "$runs")
  if [[ -n $ci ]]; then echo "Dev push CI passed for $sha in run $ci."; exit 0; fi

  # An identical tree can have a different commit ID. Trust only ci.yml runs from GitHub's dev queue in this repo.
  # The required jobs can merge a group before optional CI jobs finish: only a successful whole run counts.
  pending=false
  for ((page=1; ; page++)); do
    groups=$(gh api "$repo/actions/workflows/ci.yml/runs?event=merge_group&exclude_pull_requests=true&per_page=100&page=$page")
    matches=$(jq -c --arg repo "$GITHUB_REPOSITORY" --arg tree "$tree" '[.workflow_runs[] | select(.head_repository.full_name == $repo and .event == "merge_group" and (.head_branch | startswith("gh-readonly-queue/dev/")) and .head_commit.id == .head_sha and .head_commit.tree_id == $tree)]' <<< "$groups")
    ci=$(jq -r '[.[] | select(.conclusion == "success") | .id][0] // empty' <<< "$matches")
    if [[ -n $ci ]]; then echo "Merge queue CI passed for tree $tree in run $ci."; exit 0; fi
    if jq -e 'any(.[]; .status != "completed")' <<< "$matches" >/dev/null; then pending=true; break; fi
    if [[ $(jq '.workflow_runs | length' <<< "$groups") -lt 100 ]] || ((page == 10)); then break; fi
  done
  if [[ $pending == false ]] && ! jq -e 'any(.[]; .status != "completed")' <<< "$runs" >/dev/null; then
    echo "::error::No passing dev push CI for $sha or dev merge queue CI for tree $tree."
    exit 1
  fi
  if (( SECONDS >= deadline )); then echo "::error::CI for $sha was still running after $((wait / 60)) minutes."; exit 1; fi
  echo "CI for $sha is still running; checking again in ${poll}s."
  sleep "$poll"
done
