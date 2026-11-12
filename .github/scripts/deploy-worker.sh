#!/usr/bin/env bash
set -euo pipefail
# Plain GitHub variables are non-confidential. An empty variable means do not
# override a same-named Worker secret (or: no allowed values if none exists).
# Never print argv or Wrangler's informational bindings table.
args=(deploy --config "$1")
# The Secrets Manager action masks these stage-specific values. Keep them out
# of argv and sync them in the same Worker version as the application code.
set +x
umask 077
secrets_file=$(mktemp "${RUNNER_TEMP:?}/bane-app-secrets.XXXXXX.json")
trap 'rm -f -- "$secrets_file"' EXIT
for name in BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET TYPESAFE_API_KEY; do
  [[ -n ${!name:-} ]] || { echo "::error::Missing required app secret: $name"; exit 1; }
done
# Optional until the stage's mail gateway is turned on (gateway/PHASE2.md). Unset sends
# no override: the Worker keeps its current token, and with none /internal/v1/mail stays
# 403 PROTOCOL_DENIED. A short token would fail the Worker's config, so refuse it here.
if [[ -n ${MAILGW_API_TOKEN:-} && ${#MAILGW_API_TOKEN} -lt 32 ]]; then
  echo "::error::MAILGW_API_TOKEN must be at least 32 characters"; exit 1
fi
jq -n '$ENV | {BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TYPESAFE_API_KEY}
  + if (.MAILGW_API_TOKEN // "") != "" then {MAILGW_API_TOKEN} else {} end' > "$secrets_file"
args+=(--secrets-file "$secrets_file")
if [[ -n ${AUTH_ALLOWED_EMAILS:-} ]]; then args+=(--var "AUTH_ALLOWED_EMAILS:$AUTH_ALLOWED_EMAILS"); fi
if [[ -n ${AUTH_ALLOWED_DOMAINS:-} ]]; then args+=(--var "AUTH_ALLOWED_DOMAINS:$AUTH_ALLOWED_DOMAINS"); fi
WRANGLER_LOG=error ./node_modules/.bin/wrangler "${args[@]}"
