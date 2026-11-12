# tear: SES event processing

Lives in `api/tear/ses/`. The access checker owns `api/tear/`; inbox, dispatch and gateway have their own subdirectories. Every tear host shares one disposable-database rule, `api/tear/disposable.ts`, which this host imports.

A [tear](https://github.com/anomalyco/tear) model of SES feedback on Hosted Bane: delivery, bounce (hard, transient, validation-suppressed), complaint (abuse, not-spam), delivery delay, reject, rendering failure and open notifications over SNS. It covers signature, topic and account checks, duplicates, out-of-order arrival, unknown message ids, recovery jobs, suppression, outcome bits, campaign stats, sender-score inputs, hosted health and webhook fan-out. Each step runs on the real code over an isolated PostgreSQL. It is checked against an independent reference model, and failing traces are reduced to short, replayable witnesses.

- `src/model.rs` is the reference model: committed state, two job workers paused at the recovery handler's statement gates, and two consumer transactions that can be held open.
- `src/main.rs` holds the action list, the edge-case checklist and its coverage, the properties, the bug witnesses and the run modes.
- `host.ts` drives the real code with Bun: the SNS route (`POST /v1/events/ses`, signed with a pinned self-signed certificate, no queue binding), the feedback-queue consumer (`ingestFeedbackBatch`), the `operation.ses` recovery job handler and the dispatcher's result statement (`recordEmailEvent`). It reads stats through `GET /v1/campaigns/{id}/stats` and `GET /v1/sender-score`. The network is disabled.
- `old …` actions run the same code as a Worker deployed before migration 153: the host swaps in the old rank table while the statement is built, which is the only difference between the versions' status writes. `repair` runs migration 154's `repair_feedback_status` on the workspace.

## Properties

The model predicts every request result and the committed view: email status, provider id, outcome bits, error code and suppression reason; contacts; stored and published events; deliveries per endpoint; receipts; recovery jobs; campaign stats; sender-score ratios; hosted health totals. Independently of the model, the host checks the following recounts on every step:

- Outcome bits equal the published events.
- Each notification is stored once, and every published event has its stored event.
- Each endpoint gets one delivery per event, carrying that event's payload.
- Hosted health credits equal their projection, and the hourly totals equal the credits.
- Nothing is quarantined, and no suppression is lifted.

The contract the model encodes:

- Each notification is applied exactly once after its recovery job runs.
- Status only moves up a rank order, so arrival order does not matter. A validation-suppressed recipient ranks below any outcome SES reported for the recipients it did send to.
- Suppression merges keep the strongest reason: complaint, then hard bounce, then validation.

## Database

The host changes rows freely, so it runs only on a dedicated database. It follows the shared rule in `../disposable.ts`:

- `TEAR_DATABASE_URL` must be a plain loopback URL. Query parameters are refused, because node-postgres lets them redirect the host or port.
- The database must carry the disposable marker. tear never sets it.
- The database must hold no workspace other than `default` or `tear_*`, and no user other than `tear-user-*`.

Each host process creates its own `tear_ses_*` workspace per trace and deletes it at the next reset. It adds one global row of its own: the shared pool region `us-east-1` with a `tear-ses-feedback` topic. Create and migrate a database of its own, then mark it once as its owner. From `api/`, after `bun install --frozen-lockfile`:

```sh
createdb tear_ses
DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_ses BETTER_AUTH_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts
psql postgresql://…@127.0.0.1:5432/tear_ses -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
export TEAR_DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_ses
```

tear is pinned by git rev in `Cargo.toml`. Cargo fetches it with your git credentials, so you need read access to `anomalyco/tear`. tear is a dev tool only: nothing here ships with the API.

## Pull-request run (25–35 s after the build)

```sh
cd api/tear/ses && cargo run --release -- ci
```

`ci` does three things:

- It replays the bug witnesses and boundary traces.
- It covers every transition of the core alphabet to depth 3: 4,344 traces and 12,483 steps.
- It runs 240 random walks of 30 steps.

It runs four host processes (`-j 4`), prints a JSON report with checklist coverage, and exits 1 on any mismatch, error or disabled witness. Each mismatch is printed as a reduced trace.

## Deeper runs

| Command | Steps | Time (6 hosts, M-series Mac) |
|---|---:|---:|
| `cargo run --release -- edges 4 -j 6` | 106,487 (27,845 edges) | about 125 s |
| `cargo run --release -- random 3000 40 -j 6 --seed $(date +%s)` | 120,000 | about 2 min |
| `cargo run --release -- edges 5 -j 8` | 717,592 (150,066 edges) | about 12 min (estimated from the rate above, not yet run) |

- `space N` prints the core graph's size per depth without touching the database.
- `trace ACTION…` replays one trace, for example `trace "h b1" "accept e1" "J b1" "J go" "J crash" "q b1"`.

For a nightly run, rotate `--seed` by date. Host logs go to `target/host-N.log` (`TEAR_LOG` sets the prefix). Set `TEAR_HOST_LOG=1` for API logs and `TEAR_TRACE=1` for every action, gate and lock wait.

## Findings

| Bug | Shortest witness | Fix |
|---|---|---|
| A recovery job stored a bounce or complaint, then died before suppressing. The queue's redelivery marked the receipt processed without suppressing, and the job's retry returned, so the recipient was never suppressed. | 6 steps: `h b1`, `accept e1`, `J b1`, `J go`, `J crash`, `q b1` | `85f1765`: effects follow the receipt the consumer processes, not a newly inserted event |
| A validation-suppressed recipient tied with or outranked SES outcomes for the rest of the email. On a multi-recipient email, a delivered email became `suppressed`, and a hard bounce became `suppressed` or not depending on arrival order. The email then dropped out of accepted volume. | 3 steps: `accept e2`, `q v2`, `h d2` | `82fcc96`: `suppressed` ranks below `delivered` |
| During a deploy, a Worker still on the old rank table could permanently restore `suppressed` over a delivery or hard bounce the new version had committed, or skip a delivery after a validation suppression (review of #56). | 3 steps: `accept e2`, `q d2`, `old q v2`; `accept e2`, `q v2`, `old q d2` | Migration 153: a `BEFORE UPDATE` guard and a delivery trigger enforce the ranking and the validation error code for every version; migration 154 repairs older rows from stored events |

## Modelling notes

- SES Send is not subscribed by any Bane configuration set (`FEEDBACK_EVENTS`), so it is not modelled. Only the simulator emits it, and `sent` still ties with `delayed`.
- A consumer statement that waits on another consumer's row lock keeps its statement snapshot for non-locking reads (READ COMMITTED). So an open does not engage a contact that the first statement created in the meantime. That is the outcome of the serial order "open, then the contact is created", which the contract allows. The model encodes this, and the CI regressions pin it.
- While a consumer transaction is open, only statements that wait on its email row lock may run. Two waiters at once are disabled, because PostgreSQL does not order which one wins. Statements that would only contend on the shared hourly counters (hosted usage and health) are disabled for the same reason.
- Migration 153 makes the database authoritative for the feedback ranking and for `EMAIL_VALIDATION_SUPPRESSED` (kept only while the status is suppressed, never over an earlier error code), so no deploy fence is needed. Without its triggers, the `old …` witnesses mismatch in 3 steps (checked by dropping them on the tear database).
- Not modelled: an old consumer without `85f1765`. It can lose a suppression only if a recovery job crashes between its event write and its suppression inside the deploy window, which no database guard repairs.
