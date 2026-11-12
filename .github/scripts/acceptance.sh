#!/usr/bin/env bash
set -euo pipefail
umask 077
export HOME="$RUNNER_TEMP/fixture-home"
mkdir -p "$HOME"
export PGPORT=${PGPORT:-5432}
admin() { PGPASSWORD=fixture-admin psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 "$@"; }
admin <<'SQL'
-- Deadlock guard (docs/ci.md): find a lock cycle after 50 ms instead of 1 s, log every lock wait longer than that,
-- and end a statement that waits 15 s for a lock with an error instead of hanging the job.
ALTER SYSTEM SET deadlock_timeout = '50ms';
ALTER SYSTEM SET log_lock_waits = on;
SELECT pg_reload_conf();
CREATE ROLE fixture LOGIN NOSUPERUSER PASSWORD 'fixture';
CREATE DATABASE fixture OWNER fixture;
-- These are small OLTP fixtures: don't spend the job compiling one-off plans.
ALTER ROLE fixture SET jit = off;
ALTER ROLE fixture SET lock_timeout = '15s';
SQL
export DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:$PGPORT/fixture
export HOST=127.0.0.1
export AUTH_ALLOWED_EMAILS=operator@example.com AUTH_ALLOWED_DOMAINS=example.com GOOGLE_CLIENT_ID=fixture GOOGLE_CLIENT_SECRET=fixture
BETTER_AUTH_SECRET=$(openssl rand -hex 36); export BETTER_AUTH_SECRET
export ENABLE_LIVE_SES=false AWS_EC2_METADATA_DISABLED=true WEBHOOK_ALLOWED_HOSTS=example.com
export S3_ACCESS_KEY_ID=S3RVER S3_SECRET_ACCESS_KEY=S3RVER S3_BUCKET=fixture
export SIMULATED_SES_LATENCY_MS=0 SIMULATED_SES_DELIVERY_DELAY_MS=0
# Migrate once; isolate global auth fixtures, row locks, storage and prototype
# mocks between the two processes. Never parallelize tests inside one database.
node --import tsx src/migrate.ts
admin -c 'CREATE DATABASE fixture_sim OWNER fixture TEMPLATE fixture'
shard() (
  export HOME="$HOME/$1" PORT="$2" DATABASE_URL="$DATABASE_URL$3" S3_ENDPOINT="http://127.0.0.1:$4"
  export PUBLIC_URL="http://127.0.0.1:$PORT" API_BASE_URL="http://127.0.0.1:$PORT"
  mkdir -p "$HOME/objects"
  pids=()
  cleanup() {
    local rc=$?
    for p in "${pids[@]}"; do kill "$p" 2>/dev/null || :; done
    if (( rc != 0 )); then tail -n 100 "$HOME"/*.log; fi
  }
  trap cleanup EXIT
  # The emulator normalizes bucket paths differently from the AWS SDK; like the previous fixture,
  # it checks object operations here, not SigV4 calculations.
  # This release packages the CLI module but omits its bin entry point.
  node -e 'require("../.github/s3-fixture/node_modules/@20minutes/s3rver/lib/cli").parseAsync([process.argv[0], "s3rver", ...process.argv.slice(1)]).catch(error => { console.error(error.message); process.exitCode = 1; })' -- -a "$HOST" -p "$4" -d "$HOME/objects" --no-vhost-buckets --allow-mismatched-signatures --configure-bucket fixture > "$HOME/storage.log" 2>&1 & pids+=("$!")
  node --import tsx src/server.ts > "$HOME/server.log" 2>&1 & pids+=("$!")
  node --import tsx src/runner.ts > "$HOME/runner.log" 2>&1 & pids+=("$!")
  # Start as soon as all fixtures are alive and the HTTP server accepts requests.
  for ((i=0; i<100; i++)); do
    kill -0 "${pids[@]}"
    if curl -fs --max-time 1 "$PUBLIC_URL/health" >/dev/null; then break; fi
    sleep .1
  done
  curl -fsS --max-time 1 "$PUBLIC_URL/health" >/dev/null
  # /health only serves the base app. Wait for this shard's lazy auth router
  # before starting the tests: the first authenticated /v1/me in the shared
  # before hook otherwise spends its 5s request budget importing the router.
  # No cookie: the ready route must reject us, not redirect or return success.
  status=$(curl -sS --max-time 45 -o "$HOME/auth-readiness.json" -w '%{http_code}' "$PUBLIC_URL/v1/me")
  if [[ $status != 401 ]] || ! jq -e '.error.code == "AUTH_REQUIRED"' "$HOME/auth-readiness.json" >/dev/null; then
    echo "${1}: auth readiness expected 401 AUTH_REQUIRED, got HTTP $status" >&2
    exit 1
  fi
  reporters=(--test-reporter=spec --test-reporter-destination=stdout)
  if [[ -n ${ACCEPTANCE_JUNIT:-} ]]; then reporters+=(--test-reporter=junit "--test-reporter-destination=$ACCEPTANCE_JUNIT/$1.xml"); fi
  timeout 8m node --import tsx --test "${reporters[@]}" "${@:5}" api.acceptance.test.ts
)
# Complementary filters: new suites run in the HTTP shard by default.
pattern='^(SIMULATED SES:|Hosted account re-home:)'
# Flake quarantine (docs/ci.md): a test whose name carries [flaky #N], N its open issue, never blocks a merge.
# ACCEPTANCE_QUARANTINE: unset skips those tests (the required job), "only" runs just them (the non-blocking
# quarantine job), "all" runs everything (nightly).
flaky='\[flaky #[0-9]+\]'
case ${ACCEPTANCE_QUARANTINE:-} in
  only) integration_filter=(--test-skip-pattern="$pattern" --test-name-pattern="$flaky"); simulated_filter=(--test-name-pattern="$pattern.*$flaky") ;;
  all) integration_filter=(--test-skip-pattern="$pattern"); simulated_filter=(--test-name-pattern="$pattern") ;;
  '') integration_filter=(--test-skip-pattern="$pattern" --test-skip-pattern="$flaky"); simulated_filter=(--test-name-pattern="$pattern" --test-skip-pattern="$flaky") ;;
  *) echo "ACCEPTANCE_QUARANTINE must be unset, only or all" >&2; exit 2 ;;
esac
if [[ -n ${ACCEPTANCE_JUNIT:-} ]]; then mkdir -p "$ACCEPTANCE_JUNIT"; fi
shard integration 8787 '' 4569 "${integration_filter[@]}" & integration=$!
shard simulated 8788 _sim 4570 "${simulated_filter[@]}" & simulated=$!
rc=0
wait "$integration" || rc=$?
wait "$simulated" || rc=$?

# Deadlock guard: fail on any deadlock Postgres detected during the suite, including one a retry absorbed or a test
# never asserted on. A backend reports its counters when it exits, so wait for the shards' connections to close.
for ((i=0; i<50; i++)); do
  [[ $(admin -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname LIKE 'fixture%'") == 0 ]] && break
  sleep .1
done
sleep 1
deadlocks=$(admin -Atc "SELECT coalesce(sum(deadlocks), 0) FROM pg_stat_database WHERE datname LIKE 'fixture%'")
if (( deadlocks > 0 )); then
  echo "::error title=Deadlock guard::Postgres detected $deadlocks deadlock(s) (40P01) during the acceptance suite. Two code paths lock the same rows in opposite orders; see docs/ci.md."
  # The service container's log has each cycle: both statements, their locks and the processes that held them.
  if [[ -n ${PG_CONTAINER:-} ]]; then docker logs "$PG_CONTAINER" 2>&1 | grep -B2 -A12 'deadlock detected' | head -n 200 || :; fi
  rc=1
else
  echo 'Deadlock guard: Postgres detected no deadlocks.'
fi
exit "$rc"
