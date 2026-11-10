#!/usr/bin/env bash
set -euo pipefail
umask 077
export HOME="$RUNNER_TEMP/fixture-home"
mkdir -p "$HOME" "$HOME/objects"
PGPASSWORD=fixture-admin psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE fixture LOGIN NOSUPERUSER PASSWORD 'fixture';
CREATE DATABASE fixture OWNER fixture;
SQL
export DATABASE_URL=postgresql://fixture:fixture@127.0.0.1:5432/fixture
export HOST=127.0.0.1 PORT=8787 PUBLIC_URL=http://127.0.0.1:8787 API_BASE_URL=http://127.0.0.1:8787
export AUTH_ALLOWED_EMAILS=operator@example.com AUTH_ALLOWED_DOMAINS=example.com GOOGLE_CLIENT_ID=fixture GOOGLE_CLIENT_SECRET=fixture
BETTER_AUTH_SECRET=$(openssl rand -hex 36); export BETTER_AUTH_SECRET
export ENABLE_LIVE_SES=false AWS_EC2_METADATA_DISABLED=true WEBHOOK_ALLOWED_HOSTS=example.com
export S3_ENDPOINT=http://127.0.0.1:4569 S3_ACCESS_KEY_ID=S3RVER S3_SECRET_ACCESS_KEY=S3RVER S3_BUCKET=fixture
pids=()
cleanup() {
  local rc=$?
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || :; done
  if (( rc != 0 )); then
    for log in "$HOME/server.log" "$HOME/runner.log" "$HOME/fixture.log"; do
      if [[ -f $log ]]; then echo "::group::$(basename "$log") (last 100 lines)"; tail -n 100 "$log"; echo '::endgroup::'; fi
    done
  fi
  exit "$rc"
}
trap cleanup EXIT
../.github/s3-fixture/node_modules/.bin/s3rver -a 127.0.0.1 -p 4569 -d "$HOME/objects" --no-vhost-buckets --configure-bucket fixture > "$HOME/fixture.log" 2>&1 & pids+=("$!")
node --import tsx src/migrate.ts
node --import tsx src/server.ts > "$HOME/server.log" 2>&1 & pids+=("$!")
node --import tsx src/runner.ts > "$HOME/runner.log" 2>&1 & pids+=("$!")
curl -fsS --retry 20 --retry-connrefused --retry-delay 1 --max-time 2 "$PUBLIC_URL/health" >/dev/null
for p in "${pids[@]}"; do kill -0 "$p"; done
timeout 5m node --import tsx --test --test-reporter=spec api.acceptance.test.ts
