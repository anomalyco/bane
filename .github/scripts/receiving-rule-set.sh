#!/usr/bin/env bash
# Run under the dedicated deployment role, never under a Worker or customer principal.
set -euo pipefail
account=${1:?expected dedicated account id}
[[ $account == 009882681002 || $account == 905840579680 ]]
profile=${2:?expected dedicated deployment profile}
[[ $(aws --profile "$profile" sts get-caller-identity --query Account --output text) == "$account" ]]
ses=(aws --profile "$profile" --region us-east-2 ses)
active=$("${ses[@]}" describe-active-receipt-rule-set --query Metadata.Name --output text)
[[ $active == bane-inbound ]] && exit 0
[[ $active == None ]] || { echo 'Another set is active; refusing to change receiving.' >&2; exit 1; }
if [[ $("${ses[@]}" list-receipt-rule-sets --query "length(RuleSets[?Name=='bane-inbound'])" --output text) == 0 ]]; then
  "${ses[@]}" create-receipt-rule-set --rule-set-name bane-inbound
fi
[[ $("${ses[@]}" describe-receipt-rule-set --rule-set-name bane-inbound --query 'length(Rules)' --output text) == 0 ]] || { echo 'Refusing to activate unreviewed rules.' >&2; exit 1; }
"${ses[@]}" set-active-receipt-rule-set --rule-set-name bane-inbound
