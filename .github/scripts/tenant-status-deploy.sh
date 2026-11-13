#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $STAGE == dev || $STAGE == production ]]
stack="organization/bane-tenant-status/$STAGE"
# List first: an authentication, backend or KMS failure must never look like a missing stack.
stacks=$(pulumi stack ls --all --json --non-interactive)
if ! jq -e --arg s "$stack" 'any(.[];.name==$s)' <<<"$stacks" >/dev/null; then
  pulumi stack init "$stack" --secrets-provider "awskms://alias/pulumi/bane-$STAGE?region=us-east-1" --non-interactive
fi
# Recover this project's own encrypted data key on subsequent fresh runners. Do not copy a sibling's key.
if [[ ! -f Pulumi.$STAGE.yaml ]]; then
  pulumi stack export --stack "$stack" | jq -e --arg url "awskms://alias/pulumi/bane-$STAGE?region=us-east-1" '
    .deployment.secrets_providers | select(.type=="cloud" and .state.url==$url and (.state.encryptedkey|type=="string" and length>0)) |
    {secretsprovider:.state.url,encryptedkey:.state.encryptedkey}' > "Pulumi.$STAGE.yaml"
fi
plan=$(mktemp); trap 'rm -f "$plan"' EXIT
pulumi preview --stack "$stack" --refresh --diff --save-plan "$plan" --non-interactive
if [[ $PREVIEW_ONLY != true ]]; then
  pulumi up --stack "$stack" --plan "$plan" --yes --non-interactive
fi
