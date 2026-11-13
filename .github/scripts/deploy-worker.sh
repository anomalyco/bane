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
# Hosted sign-in and MCP are Google-only: config.ts refuses to start without it, so
# fail here, before secrets sync or migrations, instead of deploying a 503.
acr=$(node -e "const ts=require('typescript');const c=ts.parseConfigFileTextToJson('w',require('fs').readFileSync(process.argv[1],'utf8')).config;process.stdout.write(String(c?.vars?.MULTI_TENANT)+' '+String(c?.vars?.ACCOUNT_REQUIRED_ACR))" "$config")
[[ $acr == 'true urn:anomaly:acr:google' ]] || { echo "::error::$config must set MULTI_TENANT=true and ACCOUNT_REQUIRED_ACR=urn:anomaly:acr:google"; exit 1; }
for name in BANE_ROOT_SECRET ACCOUNT_CLIENT_PRIVATE_KEY TYPESAFE_API_KEY; do
  [[ -n ${!name:-} ]] || { echo "::error::Missing required app secret: $name"; exit 1; }
done
# shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
app_secrets='$ENV | {BANE_ROOT_SECRET, ACCOUNT_CLIENT_PRIVATE_KEY, TYPESAFE_API_KEY}'

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
# Hosted billing's Stripe keys (api/README.md, Stripe setup), from bane/<stage>/STRIPE_*. The Worker takes payments
# only with both. A key for the other Stripe mode always stops here: dev takes test keys, production live ones.
# Without usable keys the deploy continues while the stage's billing is off or in shadow (payments answer
# 503 BILLING_NOT_CONFIGURED), and stops when billing_config.mode is enforce. Values never reach argv or the log.
stripe_mode='test'; [[ $STAGE == production ]] && stripe_mode='live'
if [[ ${STRIPE_SECRET_KEY:-} =~ ^(sk|rk)_(test|live)_ && ${BASH_REMATCH[2]} != "$stripe_mode" ]]; then
  echo "::error::bane/$STAGE/STRIPE_SECRET_KEY is a ${BASH_REMATCH[2]}-mode key, but $STAGE takes $stripe_mode-mode keys"; exit 1
fi
if [[ ${STRIPE_SECRET_KEY:-} =~ ^(sk|rk)_${stripe_mode}_[A-Za-z0-9_]+$ && ${STRIPE_WEBHOOK_SECRET:-} =~ ^whsec_[A-Za-z0-9_]+$ ]]; then
  # shellcheck disable=SC2016 # A jq program: $ENV is jq's, not the shell's.
  with_stripe=$(jq '. + ($ENV | {STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET})' "$secrets_file") && printf '%s\n' "$with_stripe" > "$secrets_file"
  unset with_stripe
  echo "Billing: binding the $stripe_mode-mode Stripe keys."
else
  # The migrations above just ran against this database. Without billing_config yet, billing is off.
  billing=$(node --import tsx -e "const {Client}=require('pg');import('./src/adapters/node.ts').then(async ({postgresConnection})=>{const c=new Client(postgresConnection(process.env.DATABASE_URL));await c.connect();try{const r=await c.query(\"SELECT CASE WHEN to_regclass('billing_config') IS NULL THEN 'off' ELSE (SELECT mode FROM billing_config WHERE singleton) END AS mode\");process.stdout.write(r.rows[0]?.mode??'off')}finally{await c.end()}})") ||
    { echo "::error::Could not read billing_config.mode for $STAGE"; exit 1; }
  if [[ $billing == enforce ]]; then
    echo "::error::Billing is enforced on $STAGE, but bane/$STAGE/STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are not both $stripe_mode-mode Stripe values. Set them, or switch billing back to shadow (scripts/set-billing-enforcement.ts) first."; exit 1
  fi
  echo "::warning::Billing is ${billing:-off} on $STAGE and its Stripe keys are not set: payments answer 503 BILLING_NOT_CONFIGURED."
fi
args+=(--secrets-file "$secrets_file")
# Every log line names the commit it runs (core.ts setLogContext), for the nightly report's 5xx-by-deploy table.
if [[ ${DEPLOY_SHA:-} =~ ^[0-9a-f]{40}$ ]]; then args+=(--var "DEPLOY_SHA:$DEPLOY_SHA"); fi
# shellcheck source=/dev/null
source "$(dirname "$0")/cloudflare-retry.sh"
WRANGLER_LOG=error cloudflare_retry "$wrangler" "${args[@]}"
if bound; then state=true; else state=false; fi
[[ $state == "$gateway" ]] || { echo "::error::Worker MAILGW_API_TOKEN bound=$state, but bane:mailGatewayEnabled=$gateway"; exit 1; }
echo "Mail gateway: bane:mailGatewayEnabled=$gateway; Worker MAILGW_API_TOKEN bound=$state."
