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
for name in BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ACCOUNT_CLIENT_PRIVATE_KEY TYPESAFE_API_KEY; do
  [[ -n ${!name:-} ]] || { echo "::error::Missing required app secret: $name"; exit 1; }
done
jq -n '$ENV | {BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ACCOUNT_CLIENT_PRIVATE_KEY, TYPESAFE_API_KEY}' > "$secrets_file"
args+=(--secrets-file "$secrets_file")
if [[ -n ${AUTH_ALLOWED_EMAILS:-} ]]; then args+=(--var "AUTH_ALLOWED_EMAILS:$AUTH_ALLOWED_EMAILS"); fi
if [[ -n ${AUTH_ALLOWED_DOMAINS:-} ]]; then args+=(--var "AUTH_ALLOWED_DOMAINS:$AUTH_ALLOWED_DOMAINS"); fi
WRANGLER_LOG=error ./node_modules/.bin/wrangler "${args[@]}"
