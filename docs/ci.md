# CI: what runs where, and how to fix it

Every change reaches production through `dev`: a PR merges into `dev`, the dev deploy migrates the dev database, deploys the Worker and runs the live E2E (`api/scripts/e2e.ts`) against `dev.bane.mx`, and production only deploys a commit whose dev E2E passed. A red dev E2E therefore blocks every release after it. The checks below exist so that what used to break dev after merge breaks the PR instead.

## Merging into `dev`: the merge queue

`dev` requires the merge queue. When a PR's own checks pass, add it to the queue (`gh pr merge <n>`, or "Merge when ready"). Only the accounts allowed to push `dev` can. The queue merges the PR onto the latest `dev` and every entry ahead of it, runs the required checks (`build`, `acceptance`) on exactly that commit (the `merge_group` event), and merges only if they pass. A PR no longer has to be up to date with `dev` first, so nobody re-runs CI because another PR landed.

- **Why:** with "require branches to be up to date", parallel PRs went BEHIND after every merge and re-ran CI each time; without it, two PRs that pass alone could break `dev` together (a migration number both picked, a route one added and the other's check missed). The queue removes both.
- **Cost:** each PR's required checks run twice, once on the PR and once in the queue (about 3 minutes of latency between "merge" and the merge). The queue builds up to five entries at once, so a burst of PRs doesn't wait in series.
- **Failures:** a PR that fails in the queue is removed from it with the failing check linked; the entries behind it are rebuilt without it. Fix and re-add.
- **Deploys:** the queue pushes `dev` as `github-merge-queue[bot]`. The dev deploy accepts that push when the PR merged at exactly that commit was merged (enqueued) by thdxr or R44VC0RP; anything else still fails "Only thdxr and R44VC0RP may deploy".
- **Breaking API changes:** the `api-breaking` label on the PR still allows them; in the queue, the compatibility check compares just that PR's step.

## What runs where

| When | Job | What it proves | Time |
| --- | --- | --- | --- |
| Every PR, `dev` push | `build` | Types, SDK and docs regenerate cleanly, both Workers bundle, the public API stays compatible, and the **pre-merge invariants** below | ~1–2 min |
| Every PR, `dev` push | `acceptance` | The API's acceptance suite on Node against an isolated Postgres and S3 fixture, in two shards, plus the **deadlock guard** | ~2–3 min |
| Every PR, `dev` push | `preview` | The real Worker under `wrangler dev` (workerd) with dev's wrangler config, on a database upgraded from `dev`'s schema; see **Preview stack** | ~2 min |
| Every PR, `dev` push | `audit`, `gateway`, `cls` | Dependency advisories, the Rust mail gateway, layout shift on every dashboard page | ~3 min, in parallel |
| `dev` push | Deploy dev | Migrate, deploy, health, live dev E2E | ~5 min |
| Push to `production` | Deploy production | Requires the passing dev E2E for the exact SHA | ~4 min |

`build` and `acceptance` are required on `dev`.

## When the dev E2E fails

The deploy's `Report the dev E2E failure` job opens an issue labeled `dev-e2e` (or comments on the open one) with the failed steps, their errors and request IDs, and the bane-dev Worker's log lines for those requests. Those lines come from `wrangler tail`, which runs during the E2E; they are limited to the failed requests and to Bane's structured fields (level, code, operation, status, SQLSTATE, a 300-character message) because the issue is public. If the dev token cannot tail Workers, the issue says so and you search the request IDs in the Cloudflare dashboard instead.

Production stays blocked, as before: it deploys only a commit whose dev E2E passed. To unblock:

1. Read the issue: the failed step and request ID usually name the operation and the error code (a `40P01` is a deadlock: see the deadlock guard below).
2. Fix forward in a PR. If the failure was flaky rather than a regression, say so in the issue and re-run the deploy for the same SHA.
3. Close the issue once a dev E2E passes.

## Pre-merge invariants (`build`)

`api/scripts/check-premerge.ts` runs in about five seconds. Run it locally from `api/` with `node --import tsx scripts/check-premerge.ts` (it compares against your merge-base with `dev`). Each failure is an annotation on the PR's Files tab.

### E2E coverage

**Fails when** an operation in `api/openapi.json` is neither called nor skipped in `api/scripts/e2e.ts`. The live dev E2E fails on exactly this after merge (it happened twice).

**Fix:** add a step that calls `api('yourOperation', …)` against dev. If it can't run there (it needs a dashboard session, would change the shared fixture, or needs AWS resources the run doesn't own), add it to `SKIP` with that reason. An operation called only in a loop of names (`for (const op of ['a','b'])`) counts, because the names are string literals.

### Worker routes

**Fails when** an API route (from `createOpenApiApp()`) is not matched by `assets.run_worker_first` in `api/wrangler.dev.jsonc` or `api/wrangler.prod.jsonc`, when the two configs' `assets` blocks differ, or when `src/worker.ts` hands a GET for an API path to the static assets binding.

Workers Assets answers any path outside `run_worker_first` itself: a 405 for a POST, the dashboard's `index.html` for a GET. The Node server and the acceptance suite never see this, so a new prefix (as `/internal/*` was) works in CI and breaks on Cloudflare.

**Fix:** add the prefix (`"/yourprefix", "/yourprefix/*"`) to `run_worker_first` in both wrangler configs, and to the API path pattern in the Worker's `fetch`.

### Migrations

`src/migrate.ts` applies each `NNN_name.sql` once, in file-name order, and refuses a migration whose contents changed. **Fails when:**

- a file in `api/migrations/` doesn't match `^\d+_[a-z_]+\.sql$` (migrate.ts would silently skip it: no digits or capitals after the number);
- a new migration's number is not greater than the newest one on `dev`, so a fresh database would apply it in a different order than dev did;
- two files share a number (the pairs from before this check are listed in the script and stay);
- an older open PR already adds a migration with the same number (the older PR keeps it; a newer one only gets a warning);
- a migration that is on `dev` was edited, renamed or deleted (every upgraded database would fail with `MIGRATION_CHANGED`).

**Fix:** rename your file to the number the message suggests. It is the next number after everything on `dev` and in open PRs.

### Card slots

Below 640 px every `DataTable` renders its rows as cards from each column's `card` slot (see `AGENTS.md`). **Fails when** a PR adds a table column (an object with `key`, `label` and `render`) without `card`. Columns that existed before the check are grandfathered by file and key.

**Fix:** set `card` to `'title'`, `'aside'`, `'line'`, `'inline'`, `'field'`, `'end'` or `'hide'` (see `Column` in `app/src/components/ui/primitives.tsx`).

## Deadlock guard (`acceptance`)

Dev's E2E runs its steps concurrently, and every 40P01 it has hit so far was two endpoints locking the same rows (the workspace's settings row, a domain claim, a receipt or its window) in opposite orders. Each request then failed with a 500 after `deadlock_timeout`. The acceptance job now:

- sets `deadlock_timeout = 50ms` and `log_lock_waits = on` on its Postgres (a cycle is found in 50 ms, and every longer wait is logged) and `lock_timeout = 15s` for the fixture role (a stuck lock fails one statement instead of the job);
- runs `lock order: concurrent domain re-adds, sends and mailbox replies on one domain never deadlock`, which fires the pairs behind every dev 40P01 so far (re-adding a domain while sends and mailbox replies from it are admitted) 600 times in one to two seconds. With either fix reverted (PR #63's send order or PR #100's mailbox-send order, today's `createDomain` 500) it hits 90 to 140 deadlocks on every run;
- fails if Postgres counted **any** deadlock during the whole suite (`pg_stat_database.deadlocks`), even one a retry absorbed or no test asserted on, and prints each cycle from the Postgres log.

**When it fails:** the log excerpt names both statements and the rows they waited for. Find the two code paths and make them take their locks in the same order: the workspace's `ses_installation_settings` row first, then domain claims, then receipts and their windows (`lockedSettings()` in `api/src/sending.ts` is the helper). Add a test that holds the first lock and proves the second path waits for it (see `regional sender: a send waits on the settings row…`), and add the pair to the `lock order:` stress test once it is fixed.

Locally: `PGPORT=<port> PG_CONTAINER=<container> RUNNER_TEMP=$(mktemp -d) bash ../.github/scripts/acceptance.sh` from `api/`, against a disposable Postgres (`docker run -d -e POSTGRES_PASSWORD=fixture-admin -p 127.0.0.1:<port>:5432 postgres:17.11-alpine`).

## Preview stack (`preview`)

`.github/scripts/preview.sh` runs what dev runs, before merge, with no Cloudflare or AWS account (about 15 s after installing and building the dashboard):

1. **Migrations, fresh and upgraded.** `dev`'s migrations (from the commit the PR lands on) then the PR's, on one database; the PR's alone on another. Both must apply, and `pg_dump --schema-only` of the two must be identical. A migration numbered before one `dev` already applied changes the column order between them, so this fails with "renumber".
2. **The real Worker.** `wrangler dev` (workerd) with `wrangler.dev.jsonc` as is: `assets` and `run_worker_first`, Durable Objects, queues, rate limits, crons. Only what exists solely on Cloudflare is dropped (custom domain, account, placement, Browser Rendering, observability). Hyperdrive points at the upgraded database, and SES is simulated.
3. **Every route reaches the Worker.** `api/scripts/preview-smoke.ts` asks each of the ~290 routes anonymously. Each must answer with an `x-request-id` and below 500, so Workers Assets never answers (405 or the dashboard HTML) and no module fails to load in workerd. The dashboard's own paths must still serve its HTML, and the scheduled handler runs once.

**When it fails:** the annotation names the route or the schema difference. For a route, add its prefix to `run_worker_first` in both wrangler configs (the `build` check usually catches it first). For a schema difference, renumber the migration after `dev`'s newest. For a 5xx, find the request ID in the job's wrangler log. Locally, from `api/` with the dashboard built and a disposable Postgres: `BASE=$(git merge-base HEAD origin/dev) PGPORT=<port> PG_CONTAINER=<container> bash ../.github/scripts/preview.sh`.

### Next: the E2E flow itself in preview

`api/scripts/e2e.ts` does not run here yet. It needs a hosted workspace in simulated mode: a seeded workspace, key, ready shared connection and verified domain. It also needs a `preview` profile that expects simulated receipts, and skips by operation ID the steps that need AWS (domain verification, the MX check, the inbound self-loop through SES receiving, Browser Rendering). That would run the E2E's concurrent steps, the source of the dev 40P01s, under workerd before merge. Estimated one to two days, including making it reliable enough to require.

### Why not a Cloudflare preview deployment per PR

A Workers preview version per PR (`wrangler versions upload --preview-alias pr-<n>`) runs on real Cloudflare, but:

- Preview versions don't consume queues or run crons, and they share dev's queues, R2 buckets and Durable Objects. Isolating data needs a database branch per PR (PlanetScale bills branch hours) and a Hyperdrive config per branch.
- PR workflows would need the Cloudflare token and the AWS role: credentials next to unreviewed PR code.
- It is real infrastructure to provision, clean up and pay for, and it still wouldn't cover live SES or inbound mail.

The local workerd stack catches the classes that hit dev (routing, module loading, migrations) for free and without credentials. Recommendation: keep it. If live-provider coverage before merge is ever worth paying for, use one shared staging fixture, not one per PR.
