#!/usr/bin/env bash
# Nightly tear run on a machine that can fetch the private anomalyco/tear repository (CI cannot; docs/ci.md).
# Starts a disposable Postgres in Docker, creates, migrates and marks one database per checker, and runs each
# checker's `ci` with a seed that rotates by date. Logs and a summary go to $TEAR_OUT (default
# ~/.cache/bane-tear/<date>). Exits 1 if any checker reports a mismatch or fails to run. With TEAR_REPORT_REPO
# (owner/name), a failing night also opens or comments on that repository's `tear-nightly` issue with each failing
# checker's minimal witness signatures.
#   api/tear/nightly.sh [checker ...]     checkers: access admission delivery dispatch inbox ses (default: all)
set -euo pipefail
cd "$(dirname "$0")/.."
port=${TEAR_PG_PORT:-55433} container=bane-tear-nightly-$$ seed=${TEAR_SEED:-$(date +%Y%m%d)}
out=${TEAR_OUT:-$HOME/.cache/bane-tear/$(date +%F)}
checkers=("$@"); (( ${#checkers[@]} )) || checkers=(access admission delivery dispatch inbox ses)
mkdir -p "$out"
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=tear -p "127.0.0.1:$port:5432" postgres:17.11-alpine >/dev/null
trap 'docker rm -f "$container" >/dev/null 2>&1 || :' EXIT
admin() { PGPASSWORD=tear psql -h 127.0.0.1 -p "$port" -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
for ((i=0; i<100; i++)); do admin -c 'SELECT 1' >/dev/null 2>&1 && break; sleep .2; done
secret=$(openssl rand -hex 36) failed=()
for checker in "${checkers[@]}"; do
  case $checker in access) manifest=tear/Cargo.toml ;; admission|delivery|dispatch|inbox|ses) manifest=tear/$checker/Cargo.toml ;; *) echo "unknown checker $checker" >&2; exit 2 ;; esac
  db=tear_$checker url=postgresql://postgres:tear@127.0.0.1:$port/tear_$checker
  admin -c "CREATE DATABASE $db"
  DATABASE_URL=$url BANE_ROOT_SECRET=$secret PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts > "$out/$checker.migrate.log" 2>&1
  admin -d "$db" -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
  started=$SECONDS
  if DATABASE_URL=$url TEAR_DATABASE_URL=$url BANE_ROOT_SECRET=$secret cargo run --release --locked --quiet --manifest-path "$manifest" -- ci --seed "$seed" > "$out/$checker.log" 2>&1; then
    echo "pass  $checker ($((SECONDS - started)) s)" | tee -a "$out/summary.txt"
  else
    echo "FAIL  $checker ($((SECONDS - started)) s): $out/$checker.log" | tee -a "$out/summary.txt"; failed+=("$checker")
  fi
done
echo "seed $seed; logs in $out" | tee -a "$out/summary.txt"
if (( ${#failed[@]} )) && [[ -n ${TEAR_REPORT_REPO:-} ]]; then
  body=$out/issue.md
  {
    echo "tear's nightly run on \`$(git rev-parse --short HEAD)\` (seed $seed) failed: ${failed[*]}. Each line is a minimal witness: replay it with the checker's \`trace\` command (api/tear/<checker>/README.md). A witness after an API change is often model drift (the model or rest.rs needs the new behavior); otherwise it is a bug."
    echo
    cat "$out/summary.txt"
    for checker in "${failed[@]}"; do
      echo; echo "**$checker**"; echo
      sed -n '/^{/,$p' "$out/$checker.log" | jq -r '[.. | objects | select(has("signature") and has("actions")) | "- `\(.signature)`: \(.actions | join(" → "))"] | unique | .[0:15][]' 2>/dev/null || echo '- (no JSON report: see the log)'
    done
  } > "$body"
  gh label create tear-nightly -R "$TEAR_REPORT_REPO" --color 5319E7 --description 'Failures from the local nightly tear run' --force >/dev/null
  open=$(gh issue list -R "$TEAR_REPORT_REPO" --label tear-nightly --state open --json number --jq '.[0].number // empty')
  if [[ -n $open ]]; then gh issue comment "$open" -R "$TEAR_REPORT_REPO" --body-file "$body" >/dev/null
  else gh issue create -R "$TEAR_REPORT_REPO" --label tear-nightly --title "tear nightly: ${failed[*]} failed" --body-file "$body" >/dev/null; fi
fi
(( ${#failed[@]} == 0 ))
