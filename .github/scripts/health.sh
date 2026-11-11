#!/usr/bin/env bash
set -euo pipefail
for origin in "$@"; do
  curl --fail --silent --show-error --max-time 10 --retry 36 --retry-delay 10 --retry-connrefused "$origin/health" |
    jq -e '.status == "ok" and (.service == "bane" or .service == "opensend") and .multiTenant == true' || { echo "Invalid or unavailable $origin/health" >&2; exit 1; }
done
