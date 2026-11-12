#!/usr/bin/env bash
# Preview stack (docs/ci.md): what dev runs, before merge, without Cloudflare or AWS. From api/, with the dashboard built
# (app/dist) and Postgres on 127.0.0.1:$PGPORT (password fixture-admin).
#   1. Migrations: dev's migrations (from $BASE) then this change's, on one database; this change's alone on another.
#      Both must apply, and their schemas must be identical (a migration that sorts before one dev already applied runs
#      in a different order on a fresh database).
#   2. The real Worker under `wrangler dev` (workerd) with wrangler.dev.jsonc's assets, run_worker_first, Durable
#      Objects, queues and rate limits, Hyperdrive pointed at the upgraded database, and simulated SES.
#   3. Every API route asked of it anonymously must be answered by the Worker (scripts/preview-smoke.ts), and the
#      scheduled handler must run.
# PG_CONTAINER (the Postgres container) is used for pg_dump, so its version matches the server's.
set -euo pipefail
: "${BASE:?BASE must be the commit this change lands on}"
export PGPORT=${PGPORT:-5432} WRANGLER_SEND_METRICS=false
port=${PREVIEW_PORT:-8799} tmp=${RUNNER_TEMP:-$(mktemp -d)}/preview
mkdir -p "$tmp"
admin() { PGPASSWORD=fixture-admin psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
url() { echo "postgresql://postgres:fixture-admin@127.0.0.1:$PGPORT/$1"; }
secret=$(openssl rand -hex 36)
migrate() { DATABASE_URL=$(url "$2") BANE_ROOT_SECRET=$secret ACCOUNT_REQUIRED_ACR=urn:anomaly:acr:google PUBLIC_URL=http://127.0.0.1:$port MULTI_TENANT=true DEFAULT_SES_REGION=us-east-2 node --import tsx "$1/src/migrate.ts" > "$tmp/migrate-$2-$(basename "$1").log" 2>&1 || { tail -n 30 "$tmp/migrate-$2-$(basename "$1").log"; echo "::error title=Preview migrations::$3 failed (log above)."; exit 1; }; }
for db in preview_fresh preview_upgrade; do admin -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db"; done

# 1. Fresh, and upgraded from the base's schema. The base's migrate.ts runs with this checkout's dependencies.
started=$SECONDS
base_tree=$tmp/base
rm -rf "$base_tree"; mkdir -p "$base_tree/api"
git -C .. archive "$BASE" api/src api/migrations api/package.json | tar -x -C "$base_tree"
ln -s "$PWD/node_modules" "$base_tree/api/node_modules"
migrate "$base_tree/api" preview_upgrade "Migrating dev's schema ($BASE)"
migrate "$PWD" preview_upgrade 'Upgrading dev'"'"'s schema with this change'"'"'s migrations'
migrate "$PWD" preview_fresh 'Migrating a fresh database'
dump() {
  if [[ -n ${PG_CONTAINER:-} ]]; then docker exec "$PG_CONTAINER" pg_dump -U postgres --schema-only --no-owner --no-privileges "$1"
  else PGPASSWORD=fixture-admin pg_dump -h 127.0.0.1 -U postgres --schema-only --no-owner --no-privileges "$1"; fi | grep -vE '^(--|SET |SELECT pg_catalog|\\(un)?restrict )' | sed '/^$/d'
}
if ! diff -u <(dump preview_fresh) <(dump preview_upgrade) > "$tmp/schema.diff"; then
  head -n 80 "$tmp/schema.diff"
  echo "::error title=Preview migrations::A fresh database and dev's database upgraded with this change end with different schemas (diff above). Usually a migration sorts before one dev already applied: renumber it after dev's newest."
  exit 1
fi
added=$(git diff --name-only --diff-filter=A "$BASE" HEAD -- migrations | wc -l | tr -d ' ')
echo "Preview migrations: $added new on top of ${BASE:0:12}; fresh and upgraded schemas match ($((SECONDS - started)) s)."

# 2. The Worker, from wrangler.dev.jsonc: drop what only exists on Cloudflare (the custom domain, account, placement,
# Browser Rendering, observability), point Hyperdrive at Postgres, and turn live SES off. assets is copied verbatim.
node --input-type=module - "$(url preview_upgrade)" "$port" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const [database, port] = process.argv.slice(2);
const config = ts.parseConfigFileTextToJson('wrangler.dev.jsonc', readFileSync('wrangler.dev.jsonc', 'utf8')).config;
for (const key of ['routes', 'account_id', 'placement', 'browser', 'observability']) delete config[key];
config.name = 'bane-preview';
Object.assign(config.vars, { PUBLIC_URL: `http://127.0.0.1:${port}`, ENABLE_LIVE_SES: 'false', SIMULATED_SES_LATENCY_MS: '0', SIMULATED_SES_DELIVERY_DELAY_MS: '0' });
config.hyperdrive = config.hyperdrive.map(binding => ({ ...binding, localConnectionString: database }));
writeFileSync('wrangler.preview.jsonc', JSON.stringify(config, null, 2));
JS
started=$SECONDS
./node_modules/.bin/wrangler dev --config wrangler.preview.jsonc --local --ip 127.0.0.1 --port "$port" --test-scheduled \
  --var "BANE_ROOT_SECRET:$secret" --var ACCOUNT_CLIENT_ID:preview --var ACCOUNT_CLIENT_PRIVATE_KEY:unused-by-anonymous-preview --var TYPESAFE_API_KEY:preview \
  > "$tmp/wrangler.log" 2>&1 &
wrangler=$!
trap 'kill "$wrangler" 2>/dev/null || :' EXIT
for ((i=0; i<120; i++)); do
  kill -0 "$wrangler" 2>/dev/null || { tail -n 60 "$tmp/wrangler.log"; echo "::error title=Preview Worker::wrangler dev exited (log above)."; exit 1; }
  curl -fs --max-time 2 "http://127.0.0.1:$port/health" >/dev/null && break
  sleep .5
done
curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null
echo "Preview Worker: answering on :$port after $((SECONDS - started)) s."

# 3. Routing and runtime smoke, then one run of the scheduled handler (maintenance, wake-ups) against the database.
rc=0
node --import tsx scripts/preview-smoke.ts "http://127.0.0.1:$port" || rc=1
status=$(curl -sS --max-time 60 -o "$tmp/scheduled.txt" -w '%{http_code}' "http://127.0.0.1:$port/cdn-cgi/handler/scheduled?cron=*+*+*+*+*")
if [[ $status != 200 ]]; then echo "::error title=Preview Worker::The scheduled handler answered HTTP $status."; rc=1; fi
if grep -qE 'Uncaught|RUNTIME_UNAVAILABLE|ModuleLoadError' "$tmp/wrangler.log"; then
  grep -nE 'Uncaught|RUNTIME_UNAVAILABLE|ModuleLoadError' "$tmp/wrangler.log" | head -n 20
  echo "::error title=Preview Worker::The Worker logged an uncaught error or failed to load a module (above)."; rc=1
fi
if (( rc )); then tail -n 80 "$tmp/wrangler.log"; fi
exit "$rc"
