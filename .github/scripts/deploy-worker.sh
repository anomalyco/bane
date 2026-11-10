#!/usr/bin/env bash
set -euo pipefail
# Plain GitHub variables are non-confidential. An empty variable means do not
# override a same-named Worker secret (or: no allowed values if none exists).
# Never print argv or Wrangler's informational bindings table.
args=(deploy --config "$1")
if [[ -n ${AUTH_ALLOWED_EMAILS:-} ]]; then args+=(--var "AUTH_ALLOWED_EMAILS:$AUTH_ALLOWED_EMAILS"); fi
if [[ -n ${AUTH_ALLOWED_DOMAINS:-} ]]; then args+=(--var "AUTH_ALLOWED_DOMAINS:$AUTH_ALLOWED_DOMAINS"); fi
WRANGLER_LOG=error ./node_modules/.bin/wrangler "${args[@]}"
