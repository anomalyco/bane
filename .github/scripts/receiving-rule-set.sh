#!/usr/bin/env bash
# Run under the dedicated deployment role, never under a Worker or customer principal.
set -euo pipefail
account=${1:?expected dedicated account id}
[[ $account == 009882681002 || $account == 905840579680 ]]
profile=${2:?expected dedicated deployment profile}
[[ $(aws --profile "$profile" sts get-caller-identity --query Account --output text) == "$account" ]]
ses=(aws --profile "$profile" --region us-east-2 ses)
active=$("${ses[@]}" describe-active-receipt-rule-set --query Metadata.Name --output text)
[[ $active == bane-inbound ]] || { echo 'Expected active Ohio set bane-inbound. Stop and follow the operator bootstrap runbook; CI never activates a set.' >&2; exit 1; }
