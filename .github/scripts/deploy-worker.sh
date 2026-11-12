#!/usr/bin/env bash
set -euo pipefail
# Plain GitHub variables are non-confidential. An empty variable means do not
# override a same-named Worker secret (or: no allowed values if none exists).
# Never print argv or Wrangler's informational bindings table.
config=$1
wrangler=./node_modules/.bin/wrangler
args=(deploy --config "$config")
# The Secrets Manager action masks these stage-specific values. Keep them out
# of argv and sync them in the same Worker version as the application code.
set +x
umask 077
secrets_file=$(mktemp "${RUNNER_TEMP:?}/bane-app-secrets.XXXXXX.json")
trap 'rm -f -- "$secrets_file"' EXIT
for name in BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET TYPESAFE_API_KEY; do
  [[ -n ${!name:-} ]] || { echo "::error::Missing required app secret: $name"; exit 1; }
done
# shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
app_secrets='$ENV | {BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TYPESAFE_API_KEY}'

# The IMAP/SMTP gateway's shared key (gateway/PHASE2.md). The stage's committed
# bane:mailGatewayEnabled is the only switch, so neither state can fail open:
# enabled requires bane/<stage>/MAILGW_API_TOKEN, and disabled removes the Worker's
# binding, which a deploy would otherwise inherit. The key is fetched here, the
# only step that needs it, and leaves this process only through the secrets file.
unset MAILGW_API_TOKEN
case ${STAGE:-} in dev|production) ;; *) echo "::error::STAGE must be dev or production"; exit 1 ;; esac
stack="$(dirname "$0")/../../infra/pulumi/Pulumi.$STAGE.yaml"
[[ -f $stack ]] || { echo "::error::Missing $stack"; exit 1; }
flags=$(grep -cE '^[[:space:]]*bane:mailGatewayEnabled[[:space:]]*:' "$stack" || true)
flag_re='^  bane:mailGatewayEnabled: ("?)(true|false)("?)[[:space:]]*$'
case $flags in
  0) gateway=false ;;
  1) line=$(grep -E '^[[:space:]]*bane:mailGatewayEnabled[[:space:]]*:' "$stack")
     if [[ $line =~ $flag_re && ${BASH_REMATCH[1]} == "${BASH_REMATCH[3]}" ]]; then gateway=${BASH_REMATCH[2]}
     else echo "::error::bane:mailGatewayEnabled in Pulumi.$STAGE.yaml must be true or false"; exit 1; fi ;;
  *) echo "::error::bane:mailGatewayEnabled is set more than once in Pulumi.$STAGE.yaml"; exit 1 ;;
esac
bound() { # Whether the deployed Worker has the binding. Any failure stops the deploy.
  local listed
  listed=$("$wrangler" secret list --config "$config") || { echo "::error::Could not list the Worker's secrets"; exit 1; }
  jq -e 'type == "array" and all(.[]; type == "object" and (.name | type) == "string")' <<< "$listed" >/dev/null ||
    { echo "::error::Unexpected output from wrangler secret list"; exit 1; }
  jq -e 'any(.[]; .name == "MAILGW_API_TOKEN")' <<< "$listed" >/dev/null
}
if [[ $gateway == true ]]; then
  # Missing, pending deletion, unreadable and malformed all stop here.
  token=$(aws secretsmanager get-secret-value --secret-id "bane/$STAGE/MAILGW_API_TOKEN" --query SecretString --output text) ||
    { echo "::error::bane:mailGatewayEnabled is true, but bane/$STAGE/MAILGW_API_TOKEN could not be read"; exit 1; }
  # Check before masking: a workflow command masks one line and unescapes %XX.
  if [[ ! $token =~ ^[A-Za-z0-9._~+/=-]{32,}$ ]]; then
    echo "::error::bane/$STAGE/MAILGW_API_TOKEN must be at least 32 characters from [A-Za-z0-9._~+/=-]"; exit 1
  fi
  echo "::add-mask::$token"
  MAILGW_API_TOKEN=$token jq -n "$app_secrets + {MAILGW_API_TOKEN}" > "$secrets_file"
  unset token
else
  jq -n "$app_secrets" > "$secrets_file"
  # Before the deploy, so a failed deploy still leaves the route closed.
  if bound; then
    echo "bane:mailGatewayEnabled is off; removing MAILGW_API_TOKEN from the Worker."
    WRANGLER_LOG=error "$wrangler" secret delete MAILGW_API_TOKEN --config "$config" >/dev/null
    if bound; then echo "::error::MAILGW_API_TOKEN is still bound to the Worker"; exit 1; fi
  fi
fi
args+=(--secrets-file "$secrets_file")
# Every log line names the commit it runs (core.ts setLogContext), for the nightly report's 5xx-by-deploy table.
if [[ ${DEPLOY_SHA:-} =~ ^[0-9a-f]{40}$ ]]; then args+=(--var "DEPLOY_SHA:$DEPLOY_SHA"); fi
if [[ -n ${AUTH_ALLOWED_EMAILS:-} ]]; then args+=(--var "AUTH_ALLOWED_EMAILS:$AUTH_ALLOWED_EMAILS"); fi
if [[ -n ${AUTH_ALLOWED_DOMAINS:-} ]]; then args+=(--var "AUTH_ALLOWED_DOMAINS:$AUTH_ALLOWED_DOMAINS"); fi
WRANGLER_LOG=error "$wrangler" "${args[@]}"
if bound; then state=true; else state=false; fi
[[ $state == "$gateway" ]] || { echo "::error::Worker MAILGW_API_TOKEN bound=$state, but bane:mailGatewayEnabled=$gateway"; exit 1; }
echo "Mail gateway: bane:mailGatewayEnabled=$gateway; Worker MAILGW_API_TOKEN bound=$state."
