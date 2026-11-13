#!/usr/bin/env bash
# Read GitHub's environment deployment for the Worker job, not its Pulumi/support jobs. Works across dev and manual
# production runs, including dispatches: the triggering SHA of a rollback isn't the SHA that its named job checked out.
set -euo pipefail
stage=${1:?stage} repo="repos/${GITHUB_REPOSITORY:?}"
[[ $stage == dev || $stage == production ]]
for ((page=1; ; page++)); do
  rows=$(gh api "$repo/deployments?environment=$stage&task=deploy&per_page=50&page=$page")
  [[ $(jq 'length' <<< "$rows") != 0 ]] || break
  ids=$(jq -r '.[] | select(.creator.login == "github-merge-queue[bot]" or .creator.login == "github-actions[bot]" or .creator.login == "R44VC0RP" or .creator.login == "thdxr") | .id' <<< "$rows")
  for id in $ids; do
    url=$(gh api "$repo/deployments/$id/statuses?per_page=100" --jq '([.[] | select(.state == "success")] | first | .log_url) // empty')
    # Deployment statuses retain their original URL across a repository rename.
    # Job and run metadata are still fetched from the current repository below.
    if [[ $GITHUB_REPOSITORY == anomalyco/nightmail && $url == https://github.com/anomalyco/bane/actions/runs/* ]]; then
      url="https://github.com/$GITHUB_REPOSITORY/actions/runs/${url#https://github.com/anomalyco/bane/actions/runs/}"
    fi
    [[ $url == "https://github.com/$GITHUB_REPOSITORY/actions/runs/"* ]] || continue
    [[ $url =~ /job/([0-9]+)$ ]] || continue
    job=$(gh api "$repo/actions/jobs/${BASH_REMATCH[1]}")
    name=$(jq -r '.name | split(" / ") | last' <<< "$job")
    [[ $name =~ ^Deploy\ $stage\ ([0-9a-f]{40})$ ]] || continue
    sha=${BASH_REMATCH[1]}
    jq -e '.conclusion == "success" and any(.steps[]; .name == "Health check" and .conclusion == "success")' <<< "$job" >/dev/null || continue
    run=$(gh api "$repo/actions/runs/$(jq -r .run_id <<< "$job")")
    jq -e --arg repo "$GITHUB_REPOSITORY" --arg stage "$stage" '.path == ".github/workflows/deploy.yml" and .head_repository.full_name == $repo and .head_branch == $stage' <<< "$run" >/dev/null || continue
    # The environment and deployment ref must also agree with the genuine job. A linked status alone is not proof.
    ref=$(jq -r .head_branch <<< "$run"); head=$(jq -r .head_sha <<< "$run")
    jq -e --argjson id "$id" --arg ref "$ref" --arg head "$head" 'any(.[]; .id == $id and .ref == $ref and .sha == $head)' <<< "$rows" >/dev/null || continue
    echo "$sha"; exit 0
  done
done
echo "No proven $stage Worker deployment found" >&2; exit 1
