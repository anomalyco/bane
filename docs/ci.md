# CI: what runs where, and how to fix it

Every change reaches production through `dev`: a PR merges into `dev`, the dev deploy migrates the dev database, deploys the Worker and runs the live E2E (`api/scripts/e2e.ts`) against `dev.bane.mx`, and production only deploys a commit whose dev E2E passed. A red dev E2E therefore blocks every release after it. The checks below exist so that what used to break dev after merge breaks the PR instead.

## What runs where

| When | Job | What it proves | Time |
| --- | --- | --- | --- |
| Every PR, `dev` push | `build` | Types, SDK and docs regenerate cleanly, both Workers bundle, the public API stays compatible, and the **pre-merge invariants** below | ~1–2 min |
| Every PR, `dev` push | `acceptance` | The API's acceptance suite on Node against an isolated Postgres and S3 fixture, in two shards, plus the **deadlock guard** | ~2–3 min |
| Every PR, `dev` push | `audit`, `gateway`, `cls` | Dependency advisories, the Rust mail gateway, layout shift on every dashboard page | ~3 min, in parallel |
| `dev` push | Deploy dev | Migrate, deploy, health, live dev E2E | ~5 min |
| Daily 07:17 UTC, or by hand | Nightly | The acceptance suite (quarantined tests included) and the CLS gate, ten runs each in parallel, reported in one issue | ~6 min |
| Push to `production` | Deploy production | Requires the passing dev E2E for the exact SHA | ~4 min |

`build` and `acceptance` are required on `dev`.

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

## Flakes: quarantine and the nightly runs

A flaky check costs every PR a re-run and teaches everyone to ignore red. The policy:

- **Fix it first.** Most flakes are a race with something else in the shared fixture, or a measurement that depends on timing. Two fixed this way: `database connection refusals…` claimed whichever job was due, so under the full suite it could take another test's job (it now shadows the queue with a transaction-scoped `CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING ALL) ON COMMIT DROP`, as the campaign-run tests do); and the CLS gate's `Settings · webhook` phone measurement (below).
- **Quarantine while you fix it.** Open an issue, then add `[flaky #<issue>]` to the test's name. The required `acceptance` job skips it; the nightly runs it. `check-premerge.ts` fails the build if the tag names no issue or a closed one. Remove the tag when the fix lands, or when the nightly report lists it as passing every run.
- **The nightly finds new ones.** `.github/workflows/nightly.yml` runs the acceptance suite (`ACCEPTANCE_QUARANTINE=all`, JUnit output) and the CLS gate ten times each, in parallel, on the dev tip, then keeps one issue labeled `nightly-flakes` current: each failing test or CLS measurement with its failure count and first error, run-level failures (a deadlock, a crashed shard), and quarantined tests that passed every run. A clean night closes the issue. Run it by hand from the Actions tab (5, 10 or 20 runs).

`acceptance.sh` modes: `ACCEPTANCE_QUARANTINE` unset skips quarantined tests, `only` runs just them, `all` runs everything; `ACCEPTANCE_JUNIT=<dir>` also writes `integration.xml` and `simulated.xml` there.

### CLS: fonts arrive late on every run

The CLS gate's `Settings · webhook` phone measurement failed on dev twice on Nov 12 (CLS 0.0334, and a re-run passed): the event-type checkboxes grew 7% and "Complaint" wrapped onto the next line. Inter is 7.2% wider than Arial, and `Inter Fallback` (sized for Arial) named only `Arial` and `Helvetica`, which Linux doesn't have, so CI drew the first paint in unsized Liberation Sans. Whether that paint happened before Inter arrived depended on the runner's load.

- `tokens.css` now also names the metric twins Linux has: Liberation Sans (Arial's metrics) and DejaVu Sans Mono (Menlo's).
- `cls.mjs` delays every web font until after the slowest API response, so text always paints first in its fallback and the swap is measured on every run, not by luck. It also fails a page if a fallback face has no local font.
- With fonts always late, Docs showed the same class of shift (0.0023): its text measures were in `ch`, the width of the current font's `0`, which changes with the swap. They are in `em` now.

**When CLS fails only sometimes**, look for something whose size depends on timing: a font swap (a `ch` width, text measured before the font loaded, a fallback without local metrics), an image without dimensions, or content that arrives after its placeholder with a different size. Make the gate reproduce it every run, then fix the page. Never raise the limit.
