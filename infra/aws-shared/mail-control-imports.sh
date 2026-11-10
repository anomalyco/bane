#!/usr/bin/env bash
# Read-only, one-time adoption inventory. Output is JSON suitable for bane:mailControlImports.
set -euo pipefail
case "${1:-}" in
  dev) account=905840579680; origin=https://dev.bane.mx;;
  production) account=009882681002; origin=https://bane.mx;;
  *) echo 'Usage: bash mail-control-imports.sh dev|production' >&2; exit 2;;
esac
stage=$1; region=us-east-2; export AWS_PAGER=''
read_aws() { aws --profile "bane-$stage" --region "$region" --output json "$@"; }
test "$(read_aws sts get-caller-identity | jq -er .Account)" = "$account"
bucket=bane-$account-mail-us-east-2
ids='[]'; add() { ids=$(jq -c --arg id "$1" '.+[$id]' <<<"$ids"); }
owned() { jq -e --arg p "$1" 'map({key:.Key,value:.Value})|from_entries|.["bane:installation-id"]=="bane:pool" and .["bane:purpose"]==$p' >/dev/null; }
# Check the result of each AWS read; AccessDenied is never evidence of absence.
buckets=$(read_aws s3api list-buckets)
if jq -e --arg b "$bucket" 'any(.Buckets[]?; .Name==$b)' <<<"$buckets" >/dev/null; then
  read_aws s3api get-bucket-tagging --expected-bucket-owner "$account" --bucket "$bucket" | jq '.TagSet' | owned mailbox-inbound
  add "$bucket"
fi
rules=$(read_aws ses describe-active-receipt-rule-set)
jq -e '.Metadata.Name=="bane-inbound" and all(.Rules[]?;.Name=="bane-inbound-all")' <<<"$rules" >/dev/null || { echo 'Stop: missing or foreign Ohio active set/rules.' >&2; exit 1; }
if jq -e '.Rules|length==1' <<<"$rules" >/dev/null; then add 'bane-inbound:bane-inbound-all'; fi
for name in bane-inbound bane-feedback bane-trusted-feedback; do
  purpose=ses-feedback; if [[ $name == bane-inbound ]]; then purpose=mailbox-inbound; fi
  if [[ $name == bane-trusted-feedback ]]; then region=us-east-1; fi
  arn=arn:aws:sns:$region:$account:$name; topics=$(read_aws sns list-topics)
  if ! jq -e --arg t "$arn" 'any(.Topics[]?;.TopicArn==$t)' <<<"$topics" >/dev/null; then continue; fi
  read_aws sns list-tags-for-resource --resource-arn "$arn" | jq '.Tags' | owned "$purpose"
  add "$arn"
  # Inbound and both feedback topics: adopt the one confirmed HTTPS subscription (redrive is Pulumi's).
  subs=$(read_aws sns list-subscriptions-by-topic --topic-arn "$arn")
  if ! jq -e '.Subscriptions|length==0' <<<"$subs" >/dev/null; then
    sub=$(jq -er --arg t "$arn" --arg u "$origin/v1/events/ses" --arg a "$account" '.Subscriptions|select(length==1)|.[0]|select(.Owner==$a and .TopicArn==$t and .Endpoint==$u and .Protocol=="https")|.SubscriptionArn|select(startswith($t+":"))' <<<"$subs") || { echo "Stop: unexpected or pending $name subscription; inspect before adoption." >&2; exit 1; }
    add "$sub"
  fi
done
# Pool event destinations (N7): adopt only Bane's exact destination on a set that already exists.
for spec in us-east-2:bane us-east-1:bane-trusted; do
  region=${spec%%:*}; prefix=${spec#*:}
  sets=$(read_aws sesv2 list-configuration-sets)
  for stream in transactional marketing; do
    set=$prefix-$stream
    jq -e --arg s "$set" 'any(.ConfigurationSets[]?;.==$s)' <<<"$sets" >/dev/null || continue
    dests=$(read_aws sesv2 get-configuration-set-event-destinations --configuration-set-name "$set")
    if jq -e --arg d "$prefix-events" 'any(.EventDestinations[]?;.Name==$d)' <<<"$dests" >/dev/null; then add "$set|$prefix-events"; fi
  done
done
jq -c . <<<"$ids"
