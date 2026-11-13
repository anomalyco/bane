#!/usr/bin/env bash
# Gate automatic promotion, not production's deployment watermark. Do not dispatch at all
# if this push touches dev infrastructure, even when the merge includes other changes.
set -euo pipefail
before=${1:?before} after=${2:?after}
[[ $before =~ ^[0-9a-f]{40}$ && $after =~ ^[0-9a-f]{40}$ ]]
if ! git cat-file -e "$before^{commit}" || ! git merge-base --is-ancestor "$before" "$after"; then
  echo changed=true
  exit 0
fi
if git diff --quiet "$before" "$after" -- infra/dev-cloud-switch.json infra/pulumi/Pulumi.dev.yaml api/wrangler.dev.jsonc support/wrangler.dev.jsonc; then
  echo changed=false
else
  # Also fail closed on a git error: no production workflow, no stack write.
  echo changed=true
fi
