#!/usr/bin/env bash
# Usage: pulumi-has-work.sh <stage> <sha>. Writes pulumi=true|false to $GITHUB_OUTPUT (stdout when unset) and the
# reason to the step summary (stderr when unset). Runs from a full-history checkout of the stage branch.
#
# The base is the commit of this stage's newest successful Deploy job, read from the job's own name (a rollback's job
# names the commit it deployed, not the branch tip in the run's title). Deploy runs only after Pulumi succeeded or
# was skipped because nothing it reads had changed since such a commit, so the stack matches the base. Not the
# previous tip or first parent (N12): a superseded run stops at its tip check and never counts, so the next run still
# sees the infrastructure change it carried.
set -euo pipefail
stage=$1 sha=$2
out=${GITHUB_OUTPUT:-/dev/stdout} summary=${GITHUB_STEP_SUMMARY:-/dev/stderr}
decide() { echo "pulumi=$1" >> "$out"; echo "tenant_status=${tenant_status:-true}" >> "$out"; echo "$2" >> "$summary"; exit 0; }
[[ $stage =~ ^(dev|production)$ && $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <dev|production> <sha>" >&2; exit 2; }

repo="repos/$GITHUB_REPOSITORY" base=
ids=$(gh api "$repo/actions/workflows/deploy.yml/runs?branch=$stage&status=success&per_page=30" |
  jq -r --arg repo "$GITHUB_REPOSITORY" '.workflow_runs[] | select(.head_repository.full_name == $repo) | .id')
for id in $ids; do
  base=$(gh api "$repo/actions/runs/$id/jobs?filter=latest&per_page=100" |
    jq -r --arg re "^Deploy $stage [0-9a-f]{40}$" '[.jobs[] | select(.conclusion == "success" and (.name | test($re))) | .name | split(" ")[2]][0] // empty')
  [[ -n $base ]] && break
done
if [[ -z $base ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null || ! git merge-base --is-ancestor "$base" "$sha"; then
  decide true "No deployed $stage commit is an ancestor of $sha; running Pulumi."
fi

changed=$(git diff --name-only "$base" "$sha")
tenant_status=false
if grep -Eq "^(infra/pulumi/(tenant-status/|Pulumi\.$stage\.yaml$|package\.json$|bun\.lock$)|\.github/scripts/(tenant-status-deploy|pulumi-has-work)\.sh$)" <<< "$changed"; then
  tenant_status=true
fi
# What the Pulumi program reads: infra/pulumi and infra/aws-shared (not their docs), the shared mail-control
# documents, and the receiving-set check its job runs.
inputs=$(grep -E '^(infra/(pulumi|aws-shared)/|api/src/mail-controls\.ts$|\.github/scripts/receiving-rule-set\.sh$)' <<< "$changed" | grep -v '\.md$' || true)

# The Pulumi job itself, aliases expanded and Require guards removed: a guard only stops a run, never changes what
# Pulumi applies. A change anywhere else in deploy.yml (the Worker deploy, the E2E) is not Pulumi's.
if grep -qx '.github/workflows/deploy.yml' <<< "$changed"; then
  job() { git show "$1:.github/workflows/deploy.yml" | yq -o=json 'explode(.) | .jobs.pulumi | del(.steps[] | select((.name // "") | test("^Require ")))' -; }
  if ! before=$(job "$base") || ! after=$(job "$sha") || [[ $before != "$after" ]]; then
    tenant_status=true
    decide true "The Pulumi job in deploy.yml changed since $base."
  fi
fi
[[ -z $inputs && $tenant_status == false ]] || decide true "Pulumi inputs changed since $base."
decide false "No Pulumi input changed since the deployed commit $base; skipping Pulumi."
