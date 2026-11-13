# CI: what runs where, and how to fix it

Every change reaches production through `dev`: a PR merges into `dev`, the dev deploy migrates the dev database, deploys the Worker and runs the live E2E (`api/scripts/e2e.ts`) against `dev.bane.mx`. Production requires a green live E2E for the exact SHA and green CI for its code tree.

## Merging into `dev`: the merge queue

`gh pr merge <n>` enqueues a PR. The queue is enabled on the **classic `dev` branch protection**, not the disabled `dev merge queue` ruleset. It merges onto the latest `dev` and the entries ahead of it only after the required `merge_group` checks (`build`, `acceptance`) pass. Only accounts allowed to push `dev` can enqueue.

- **Why:** with "require branches to be up to date", parallel PRs went BEHIND after every merge and re-ran CI each time; without it, two PRs that pass alone could break `dev` together (a migration number both picked, a route one added and the other's check missed). The queue removes both.
- **Cost:** each PR's required checks run twice, once on the PR and once in the queue (about 3 minutes of latency between enqueue and merge). The queue builds up to five entries at once, so a burst of PRs doesn't wait in series.
- **Failures:** a PR that fails in the queue is removed from it with the failing check linked; the entries behind it are rebuilt without it. Fix and re-add.
- **Deploys:** the queue pushes `dev` as `github-merge-queue[bot]`. The dev deploy accepts that push when the PR merged at exactly that commit was merged (enqueued) by thdxr or R44VC0RP; anything else still fails "Only thdxr and R44VC0RP may deploy".
- **Breaking API changes:** the `api-breaking` label on the PR still allows them; in the queue, the compatibility check compares just that PR's step.

## What runs where

| When | Job | What it proves | Time |
| --- | --- | --- | --- |
| Every PR, `dev` push | `build` | Types, SDK and docs regenerate cleanly, both Workers bundle, the public API stays compatible, and the **pre-merge invariants** below | ~1–2 min |
| Every PR, `dev` push | `acceptance` | The API's acceptance suite on Node against an isolated Postgres and S3 fixture, in two shards, plus the **deadlock guard** | ~2–3 min |
| Every PR, `dev` push | `preview` | The real Worker under `wrangler dev` (workerd) with dev's wrangler config, on a database upgraded from `dev`'s schema; see **Preview stack** | ~2 min |
| Every PR, `dev` push | `audit`, `gateway`, `cls` | Dependency advisories, the Rust mail gateway, layout shift and text density on every dashboard page | ~3 min, in parallel |
| `dev` push, alongside CI | Deploy dev | Migrate, deploy, health, live dev E2E | ~2–3 min, plus ~1 min when Pulumi has work |
| Daily 07:17 UTC, or by hand | Nightly | The acceptance suite (quarantined tests included) and the CLS gate, ten runs each in parallel, reported in one issue | ~6 min |
| Push to `production` | Deploy production | Requires a passing live dev E2E and CI proof (see **Releasing to production**) | ~2 min, plus ~1 min when Pulumi has work |
| Daily 03:00 ET, on Ryan's Mac | Nightly report | The last 24 hours of production and dev logs against the previous week; files `nightly` issues and starts a self-improve session (below) | ~2 min, plus the session |

`build` and `acceptance` are required on `dev`.

## Releasing to production

1. **Dev.** Once the dev push deploy and live E2E pass, the dev run uses its ephemeral `GITHUB_TOKEN` to dispatch `deploy.yml` on `production` with the tested SHA and source run ID. No branch moves or push credential. No wait for support dev.
   `AUTO_SHIP` (repository variable, unset or `on` by default): set `off` to stop automatic promotion; use the normal `git push bane <sha>:production` for manual shipping. Install changed release controls on the protected production branch via that path.
2. **Production.** Under the production lock, Authorize authenticates the source dev push/job, requires the exact dev tip and a descendant of the last successful production Worker deployment, and checks the live E2E and CI (identical queue tree or exact dev push). Privileged jobs recheck the tips and freeze. Manual pushes must also move forward from the deployed Worker; an explicit authorized rollback dispatch is the exception.
   The branch holds the trusted release workflow; it need not equal the running application. Read the verified environment deployment with `GITHUB_REPOSITORY=anomalyco/bane bash .github/scripts/deployed-sha.sh production`. The job name records the actual Worker SHA, including for rollback and automatic dispatches.
3. **No approval.** The `production` environment has no required reviewers (removed on Nov 12; before that, every production run waited for thdxr or R44VC0RP to approve). The deploy proceeds as soon as Authorize has the proof. These guards remain: the `production` ruleset (fast-forward only, no deletion), its branch protection (only thdxr and R44VC0RP push), the environment's branch policy (`production` only), the actor check, the stage-tip check in every job, and `PROD_DEPLOY_ENABLED`. To put an approval back, add a required-reviewers rule to the environment (Settings → Environments → `production`, or `PUT repos/anomalyco/bane/environments/production` with `reviewers` and the existing `deployment_branch_policy`).

**Pulumi only runs when it has work.** `.github/scripts/pulumi-has-work.sh` compares the commit being deployed with the commit of the stage's newest successful Deploy job (read from the job's name, so a rollback counts as the commit it deployed). Pulumi runs when one of these changed in that range:

- `infra/pulumi/` or `infra/aws-shared/`, except Markdown;
- `api/src/mail-controls.ts` or `.github/scripts/receiving-rule-set.sh`;
- the `pulumi` job in `deploy.yml`, compared with `yq` after expanding anchors and dropping its `Require …` guard steps.

An edit elsewhere in `deploy.yml` (the Worker deploy or the E2E) no longer runs Pulumi; on Nov 12 that alone ran it four times. Pulumi also runs when no deployed commit is an ancestor, and on every `workflow_dispatch`.

## When the dev E2E fails

The deploy's `Report the dev E2E failure` job opens an issue labeled `dev-e2e` (or comments on the open one) with the failed steps, their errors and request IDs, and the bane-dev Worker's log lines for those requests. Those lines come from `wrangler tail`, which runs during the E2E; they are limited to the failed requests and to Nightmail's structured fields (level, code, route, status, SQLSTATE, a 300-character message; see **Request logs** below) because the issue is public. If the dev token cannot tail Workers, the issue says so and you search the request IDs in the Cloudflare dashboard instead.

Production stays blocked, as before: it deploys only a commit whose dev E2E passed. To unblock:

1. Read the issue: the failed step and request ID usually name the operation and the error code (a `40P01` is a deadlock: see the deadlock guard below). The Worker log section quotes the failed requests' lines, plus every server error and exception the tail saw during the run. A step's last request is often a successful status poll that the tail sampled away.
   A campaign held with `hosted_daily_quota` means the fixture's capacity, which the deploy sets before the E2E (`api/scripts/dev-e2e-fixture.ts`, see `api/README.md`).
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

### Identity

Identity is `(issuer, subject)`. An issuer can assert a verified address that the sign-in method never vouched for (a GitHub-made account that links a personal Google account signs in with `acr=google` and its GitHub-verified work address), so no code may admit, link or authorize a person by email. **Fails when** `api/src`, `api/scripts` or a migration from 270 on names one of the removed email paths (`claim_bane_legacy_user`, `bane_legacy_claims`, `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`, `allowedEmails`, `allowedDomains`, `signupApproved`, `google_hosted_domain`).

**Fix:** decide by subject: the sign-in's provider identity for hosted staff (`api/src/account-policy.ts`), an invitation link, `AUTH_ALLOWED_SUBJECTS` when self-hosted, or an operator binding a subject (`scripts/list-signin-attempts.ts`). A line that must name a removed setting, such as the startup refusal, carries `premerge-identity: allowed`.

## Copy and density lint (`build`, `cls`)

Both are ratchets: a baseline holds today's findings, only a new one fails, and a clean local run drops fixed ones from it (`--update-baseline` accepts a deliberate exception). A finding keeps its identity when its line moves or its text is edited in place, and the product's name counts as one neutral word, so a rename is never new.

- **Copy** (`app/scripts/copy-lint.mjs`, pre-merge invariant 7; locally `bun run copy-lint` in `app/`): every dashboard string against length per element type, sentence length, reading grade, filler, hedging, passive voice, the glossary, sentence case, numerals, restated labels and duplicates. Baseline `app/scripts/copy-baseline.json`.
- **Density** (`app/scripts/density.mjs`, read during the `cls` run; locally `bun run density`): per page and main dialog at 1440 × 900 and 390 × 844, words in total and above the fold, long blocks, paragraphs, controls, tooltips, the same value or explanation shown twice, and explanations with nothing to act on. Fails on a new finding or a score 5% (at least 3) over `app/scripts/density-baseline.json`; the artifact has annotated screenshots.
- **Fixing:** `app/scripts/copy-fix.md`.

## Deadlock guard (`acceptance`)

Dev's E2E runs its steps concurrently, and every 40P01 it has hit so far was two endpoints locking the same rows (the workspace's settings row, a domain claim, a receipt or its window) in opposite orders. Each request then failed with a 500 after `deadlock_timeout`. The acceptance job now:

- sets `deadlock_timeout = 50ms` and `log_lock_waits = on` on its Postgres (a cycle is found in 50 ms, and every longer wait is logged) and `lock_timeout = 15s` for the fixture role (a stuck lock fails one statement instead of the job);
- runs `lock order: concurrent domain re-adds, sends and mailbox replies on one domain never deadlock`, which fires the pairs behind every dev 40P01 so far (re-adding a domain while sends and mailbox replies from it are admitted) 600 times in one to two seconds. With either fix reverted (PR #63's send order or PR #100's mailbox-send order, today's `createDomain` 500) it hits 90 to 140 deadlocks on every run;
- fails if Postgres counted **any** deadlock during the whole suite (`pg_stat_database.deadlocks`), even one a retry absorbed or no test asserted on, and prints each cycle from the Postgres log.

**When it fails:** the log excerpt names both statements and the rows they waited for. Find the two code paths and make them take their locks in the same order: the workspace's `ses_installation_settings` row first, then domain claims, then receipts and their windows (`lockedSettings()` in `api/src/sending.ts` is the helper). Add a test that holds the first lock and proves the second path waits for it (see `regional sender: a send waits on the settings row…`), and add the pair to the `lock order:` stress test once it is fixed.

Locally: `PGPORT=<port> PG_CONTAINER=<container> RUNNER_TEMP=$(mktemp -d) bash ../.github/scripts/acceptance.sh` from `api/`, against a disposable Postgres (`docker run -d -e POSTGRES_PASSWORD=fixture-admin -p 127.0.0.1:<port>:5432 postgres:17.11-alpine`). The suite listens on ports 8787, 8788, 4569 and 4570; when another checkout's suite is running, pick others with `ACCEPTANCE_PORTS="18787 18788 14569 14570"`.

## Flakes: quarantine and the nightly runs

A flaky check costs every PR a re-run and teaches everyone to ignore red. The policy:

- **Fix it first.** Most flakes are a race with something else in the shared fixture, or a measurement that depends on timing. Two fixed this way: `database connection refusals…` claimed whichever job was due, so under the full suite it could take another test's job (it now shadows the queue with a transaction-scoped `CREATE TEMP TABLE jobs (LIKE public.jobs INCLUDING ALL) ON COMMIT DROP`, as the campaign-run tests do); and the CLS gate's `Settings · webhook` phone measurement (below).
- **Quarantine while you fix it.** Open an issue, then add `[flaky #<issue>]` to the test's name. The required `acceptance` job skips it; the nightly runs it. `check-premerge.ts` fails the build if the tag names no issue or a closed one. Remove the tag when the fix lands, or when the nightly report lists it as passing every run.
- **The nightly finds new ones.** `.github/workflows/nightly.yml` runs the acceptance suite (`ACCEPTANCE_QUARANTINE=all`, JUnit output) and the CLS gate ten times each, in parallel, on the dev tip, then keeps one issue labeled `nightly-flakes` current: each failing test or CLS measurement with its failure count and first error, run-level failures (a deadlock, a crashed shard), and quarantined tests that passed every run. A clean night closes the issue. Run it by hand from the Actions tab (5, 10 or 20 runs).

`acceptance.sh` modes: `ACCEPTANCE_QUARANTINE` unset skips quarantined tests, `only` runs just them, `all` runs everything; `ACCEPTANCE_JUNIT=<dir>` also writes `integration.xml` and `simulated.xml` there.

### CLS: web fonts load before any text, every run

The CLS gate's `Settings · webhook` phone measurement failed on dev twice on Nov 12 (CLS 0.0334; re-runs passed): the event-type checkboxes grew 7% and "Complaint" wrapped onto the next line when Inter arrived. Inter is 7.2% wider than Arial, and `Inter Fallback` (sized for Arial) named only `Arial` and `Helvetica`, which Linux doesn't have, so CI's first paint used unsized Liberation Sans. Whether text painted before Inter arrived depended on the runner's load.

- `cls.mjs` serves web fonts at once from `app/dist/fonts`, outside the throttled network, so they have loaded before the throttled script that renders any text runs. Font timing no longer varies between runs. `CLS_FONTS=late` delivers every font 1.8 s late instead, to look at the fallback-to-web-font swap itself (it also fails a page if a fallback face has no local font).
- `tokens.css`: the fallbacks also name their Linux metric twins (Liberation Sans for Arial, DejaVu Sans Mono for Menlo), so readers without Arial get sized fallbacks too.
- Docs' text measures were in `ch` (the width of the current font's `0`, which changes when the font swaps); they are in `em` now.

With late fonts the fallbacks keep most pages still, but no fallback wraps every string exactly like Inter at a 0.001 limit (on Linux, Onboarding's option cards at phone width wrap one line differently, 0.0071), so the gate measures layout with the real fonts and the late-font mode is for investigation.

**When CLS fails only sometimes**, look for something whose size depends on timing: a font swap (a `ch` width, text measured before the font loaded, a fallback without local metrics), an image without dimensions, or content that arrives after its placeholder with a different size. Make the gate reproduce it every run, then fix the page. Never raise the limit.

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

## tear (local nightly)

tear, the model checker behind `api/tear/*` (access, admission, delivery, dispatch, inbox, ses), is a private repository, so CI cannot fetch it. `api/tear/nightly.sh` runs every checker's `ci` (with a seed that rotates by date) against a disposable Postgres in Docker, on a machine that can fetch it, in about 20 minutes. Logs and a summary go to `~/.cache/bane-tear/<date>`. With `TEAR_REPORT_REPO=anomalyco/bane`, a failing night opens or comments on the `tear-nightly` issue with each failing checker's minimal witnesses.

Ryan's Mac runs it nightly with cronctl (`bane-tear-nightly`, 02:30) from a detached checkout of `dev` at `~/dev/bane-tear-nightly`. A witness after an API change is often model drift: for example, the first run found `rescheduleCampaign` and `unscheduleCampaign` missing from `api/tear/src/rest.rs`. Add new routes there when you add them to the API.

## Request logs

Every process logs one JSON object per line (`log` and `logError` in `api/src/core.ts`): the Worker to Workers Logs (`observability` in both wrangler configs, 100% head sampling), the Node API and runner to stdout (CloudWatch on Fargate), and the mail gateway to CloudWatch `/ecs/bane-mail-gateway`. Each line carries `service` (`worker`, `api`, `runner`, `gateway`) and `deploy`, the first 12 characters of the commit (`DEPLOY_SHA`, which `deploy-worker.sh` sets on the Worker; set it in the environment for Node).

- **One request line per request** (`event: "request"`, written by the first middleware in `app.ts`): `requestId`, `route` (the matched handler's template, such as `/v1/emails/:id` or `/mcp`, or `unmatched`; never the raw path), `method`, `status`, `code` and `field` for a failure, `databaseCode`, `durationMs`, `workspace` (the workspace ID only), `principal` (`apiKey`, `dashboard`, `mcp`, `agentToken`, `inboxKey`, `gateway`, `anonymous`) and per-step `timings`. Level: `info` below 400, `warn` for 4xx, `error` for 5xx. `field` names only the schema's own top-level fields: an unsupported key is whatever the caller sent, so it is never logged. MCP authenticates and answers inside its route, so `/mcp` records its principal and a failure code itself (`MCP_AUTH_REQUIRED`, `AUTH_UNAVAILABLE`, `ORIGIN_NOT_ALLOWED`, `MCP_HTTP_<status>`).
- **One error line per unexpected failure** (`logError`): the same `requestId` (or `jobId` for a job), `code` (an upper-case code string, else `UNKNOWN_ERROR`), `errorType` (a string `name` shaped like a class name, else `Error`), `databaseCode` (a five-character SQLSTATE string from the `cause` chain) and up to 12 stack frames from Nightmail's own code (the Worker bundle, `src/` or `dist/`), rebuilt as `function (file:line:column)`. Never a message, neither the error's nor an `ApiError`'s: a database error's message quotes its parameters, and an error's name is just a property, and either can span lines that look like frames. So `stackFrames` reads frames only after the exact `name: message` header text (matched by characters, not lines), and logs no frames when the stack does not start with it.
- **Sampling:** successful requests are logged 1 in 10 and routine job and queue successes 1 in 100. A kept line carries `sampleRate`, so a count is the number of lines divided by it. Failures, warnings and errors are always logged.
- **Never logged:** bodies, headers, query strings, messages, addresses, tokens, keys, or any object but a plain one. `log` rebuilds every value itself (arrays by index up to 50 elements, objects from their own data properties up to 50 keys) and never calls a method, getter or `toJSON` of what it logs; an error, class instance, accessor, proxy that throws or anything nested deeper than three levels becomes `"[object]"`. It reads every error property once, as a primitive, and never throws: a line it cannot build is written as `{"level":"error","code":"LOG_SERIALIZE_FAILED"}`. Callers log operations, IDs and codes; `log` also replaces anything shaped like an address or a long hex credential before writing. The acceptance test `request logs: one line per request…` sends addresses, bodies, forged tokens, unsupported keys and a NUL byte that PostgreSQL refuses (SQLSTATE 22021, its message quoting fake frames) and checks none of it reaches a line.
- **Workers Logs retention is short** (about three days on these accounts), which is why the nightly report keeps its own daily aggregates.

To find a request: Workers Logs for `bane-dev` or `bane-production`, filter `requestId`. Production volume is small (about 8,000 lines a day), well inside the Workers Paid allowance.

## Nightly report and self-improve loop

`api/scripts/nightly-report.ts` reads the last 24 hours of request and error lines from Workers Logs (the Observability telemetry API, both accounts) and the gateway's CloudWatch group, and writes `~/.config/opensend-mx/reports/nightly-<date>.md` and `.json` on Ryan's Mac. Per stage it lists:

- the top failing routes by count and by failure rate, with their error codes;
- error codes not logged in the previous seven days;
- p95 latency regressions of successful requests (25% or more in the table; an issue at 1.5× and 250 ms over at least 20 samples);
- 5xx by deploy SHA (older lines are matched to their Worker version and the deploy run that created it);
- dispatcher, runner and job failures, and webhook delivery failures;
- the gateway's auth failures (`GATEWAY_AUTH_FAILED`, and `GATEWAY_AUTH_UNAVAILABLE` when the API did not answer).

Each window's aggregate is cached under `reports/state/<stage>/`, and the seven-day baseline comes from those files, so the first week builds it. The events API samples long windows instead of paging, so the script checks every page against the exact count and splits the window, down to one second, until it comes back whole. The API also leaves out a few lines its count includes (33 of 6,539 on dev on Nov 12, even in one-second windows), so a window counts as complete at 99.5%. An incomplete window files no issues and is never cached or used as a baseline; the report says so.

**Issues.** With `NIGHTLY_FILE_ISSUES=1` it opens one issue labeled `nightly` per new problem, at most five a night: a route and error code that answered 5xx, a new error code at error level (a new client error only from 50 a day), a p95 regression, or a jump in gateway auth failures. The body starts with a `nightly-fingerprint` comment; a problem with an open issue is only linked from the report, and one whose issue was closed gets a new issue that names the old one. The repository is public, so an issue is built only from values that pass `publicText` in the script: route templates, error codes, SQLSTATEs, stage names and counts. Request IDs stay in the private report; stack frames and log messages are never read, because a multiline database error can put caller text where a frame is expected.

**Self-improve.** Ryan's Mac runs `~/.config/opensend-mx/nightly-report.sh` with cronctl (`bane-nightly-report`, 03:00 America/New_York, after tear's 02:30). It moves the detached checkout `~/dev/bane-nightly-report` to `bane/dev`, refreshes the `cf` work profile's token, runs the report, then starts one OpenCode child session (`anthropic/claude-opus-5-5`, high) under the Bane session that set it up. That session takes the top one to three issues filed that night, reproduces each on the isolated local harness (the acceptance suite or the preview stack against a disposable Postgres in Docker, never dev or production), opens a small fix PR to `dev` for each one it reproduces (never merged), comments on the ones it cannot, and appends what it did to the report's `## Self-improve` section.

Run the report by hand from `api/` (read-only unless `NIGHTLY_FILE_ISSUES=1`):

```sh
CLOUDFLARE_API_TOKEN=<Workers Observability read> NIGHTLY_AWS_PROFILE_DEV=bane-dev NIGHTLY_AWS_PROFILE_PRODUCTION=bane-production \
  node --import tsx scripts/nightly-report.ts
```

**Why Workers Logs and not something new:** it already holds every Worker line at no extra cost, it is queryable over the API, and the Node processes write the same shape to CloudWatch. Workers Analytics Engine would give exact per-route counters for longer, but it needs a new binding on the production Worker and cannot take the gateway's or runner's events; Logpush to R2 adds a job, a bucket and a query engine for volumes this small; and Postgres has 25 connections in production to spend on mail, not logs. If traffic grows past what sampled lines can estimate, add an Analytics Engine data point in `logRequest` next to the line.
