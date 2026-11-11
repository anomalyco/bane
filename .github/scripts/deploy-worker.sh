#!/usr/bin/env bash
set -euo pipefail
# Plain GitHub variables are non-confidential. An empty variable means do not
# override a same-named Worker secret (or: no allowed values if none exists).
# Never print argv or Wrangler's informational bindings table.
args=(deploy --config "$1")
if [[ $1 == wrangler.dev.jsonc ]]; then
  set +x
  umask 077
  secrets_file=$(mktemp "${RUNNER_TEMP:?}/bane-dev-secrets.XXXXXX.json")
  trap 'rm -f -- "$secrets_file" "$secrets_file.entries"' EXIT
  # These values are write-only in the Workers API. Keep the original auth
  # secret: it also derives the encryption key for stored webhook credentials.
  for name in BETTER_AUTH_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET TYPESAFE_API_KEY; do
    aws secretsmanager get-secret-value --region us-east-1 --secret-id "bane/dev/$name" --output json |
      jq -ec --arg name "$name" '{($name): (.SecretString | strings | select(length > 0))}'
  done > "$secrets_file.entries"
  jq -es 'add | select(length == 4)' "$secrets_file.entries" > "$secrets_file"
  rm -f -- "$secrets_file.entries"
  args+=(--secrets-file "$secrets_file")
fi
if [[ -n ${AUTH_ALLOWED_EMAILS:-} ]]; then args+=(--var "AUTH_ALLOWED_EMAILS:$AUTH_ALLOWED_EMAILS"); fi
if [[ -n ${AUTH_ALLOWED_DOMAINS:-} ]]; then args+=(--var "AUTH_ALLOWED_DOMAINS:$AUTH_ALLOWED_DOMAINS"); fi
WRANGLER_LOG=error ./node_modules/.bin/wrangler "${args[@]}"
