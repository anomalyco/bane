# shellcheck shell=bash
# Retry only Wrangler deployment and the signed token-issuer request. The caller's stdout may contain a secret:
# never log it or combine partial responses. All diagnostics and backoff messages go to stderr.
cloudflare_retry() (
  set +x
  umask 077
  issuer=false
  if [[ $1 == --issuer ]]; then issuer=true; shift; fi
  deadline=$((SECONDS + 120))
  # The subshell isolates these variables; keep tmp in scope for its EXIT trap on all Bash versions.
  tmp=$(mktemp -d "${RUNNER_TEMP:?}/cf-retry.XXXXXX") || exit 1
  trap 'rm -f -- "$tmp/out" "$tmp/err"; rmdir -- "$tmp"' EXIT
  for delay in 20 60 0; do
    if "$@" >"$tmp/out" 2>"$tmp/err"; then
      cat "$tmp/err" >&2; cat "$tmp/out"; exit 0
    else rc=$?; fi
    cat "$tmp/err" >&2
    ((delay > 0)) || exit "$rc"
    # A 4xx or auth/validation diagnostic always wins, even if Wrangler mentions a network failure too.
    local status='(HTTP(/[0-9.]+)?|status([[:space:]]+code)?|returned error:)[ :=]+'
    if [[ $issuer == true ]] && grep -qx 'issuer-status:429' "$tmp/err"; then
      retry=$(sed -n 's/^retry-after://p' "$tmp/err" | tr -d '\r')
      if [[ -n $retry ]]; then
        if [[ $retry =~ ^[0-9]+$ ]]; then
          ((${#retry} <= 6)) || exit "$rc"; retry=$((10#$retry))
        else
          until_epoch=$(LC_ALL=C date -u -d "$retry" +%s) || exit "$rc"
          retry=$((until_epoch - $(date +%s)))
        fi
        if ((retry > delay)); then delay=$retry; fi
      fi
    else
      if grep -Eiq "${status}4[0-9]{2}([^0-9]|$)|authentication error|authorization error|validation error|unauthorized|forbidden" "$tmp/err"; then exit "$rc"; fi
      if ! grep -Eiq "${status}5[0-9]{2}([^0-9]|$)|5[0-9]{2} (bad gateway|internal server error|service unavailable|gateway time.?out)|code: 10013([^0-9]|$)|curl: \((5|6|7|18|28|52|55|56|92)\)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|UND_ERR_(CONNECT_TIMEOUT|SOCKET)|socket hang up" "$tmp/err"; then exit "$rc"; fi
    fi
    # Never retry earlier than Retry-After; if it cannot fit the budget, return the original error.
    if [[ $issuer == true ]] && ((SECONDS + delay > deadline)); then exit "$rc"; fi
    echo "::warning::Transient Cloudflare request failure; retrying in ${delay}s." >&2
    sleep "$delay"
  done
)
