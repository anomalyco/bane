# tear: admission and rate limits

Lives in `api/tear/admission/`. The access checker owns `api/tear/`; dispatch, inbox and gateway have their own subdirectories. Every tear host shares one disposable-database rule, `api/tear/disposable.ts`, which this host imports.

A [tear](https://github.com/anomalyco/tear) model of admission. Each step runs on the real API code over an isolated PostgreSQL. It is checked against an independent reference model, and failing traces are reduced to short, replayable witnesses. It has three profiles:

- **`recv`: the receive-side hourly window and ingest backlog.**
  - Uses two hosted workspaces, A < B, through the shared pool, so one SNS message can create receipts in both.
  - Covers notifications through the real `acceptInboundNotification` and its triggers: the message limit, the window-then-receipt lock order, reopen coalescing, and the 100- and 200-recipient bounds.
  - Every ingest job passes the one check at the job insert (`mail_ingest_admit`): one active job per receipt and the backlog, whoever inserts it. A job end drains the backlog holds.
  - `legacy-accept` runs the previous Worker's route statement against the same database, which covers old/new Worker overlap.
  - Covers the real global `release_receive_budget_holds(NULL)` (it must never wait, and moves a busy hold back) and the 72-hour hold expiry.
  - `recover` runs the real lost-receipt recovery; `stash` and `replay` drive the real held-envelope replay.
  - Ingest `claim`, `done`, `fail` and `lose` are fixture steps with the handler's settle fences.
  - `legacy-fail` runs the previous Worker's terminal failure write, unfenced, at any time: an old invocation keeps running after its lease is retired. The settle fence (164) must drop it.
- **`send`: hosted send admission.**
  - Covers `POST /v1/emails/send` and `/batch` with a bearer key, through the one-statement atomic admission.
  - Covers the rolling 24-hour recipient cap shared by a quota sponsor's workspaces, the marketing reserve and the pending cap.
  - Covers the operator scripts `set-hosted-limits` (send and pending cap overrides) and `set-workspace-exemption`, plus hosted pause and resume.
  - Covers probation, second-week and mature tiers from clean history and connection age, Idempotency-Key replays, and the per-key minute budget.
  - Covers refunds by the `hosted_adjust` trigger.
- **`upload`: stored-attachment quota reservations.**
  - Covers reserve, R2 put, finish and refund in `POST /v1/attachments`.
  - Covers the hourly sweeper and upload tombstones (the real `cleanup`), storage reconciliation (the real `reconcileUploads` over a listing of the stored objects, which `day` ages) and the deletion jobs (the real job runner).
  - `foreign` stores objects of other key families in the same bucket (a workspace named `attachments`'s kept mail, a mail attachment, a template asset). Nothing may delete them.
  - `Ux crash` stands for a Worker that dies after a late put, which also covers an older Worker's refund.

Files:

- `src/model.rs` is the reference model: committed state plus one open transaction per connection, with the lock order the contract documents.
- `src/main.rs` holds the edge-case checklist and its coverage, the properties, the bug witnesses and boundary traces, and the run modes.
- `host.ts` drives the real code with Bun.
  - Connections `W` and `V` (and `X` on the receive side) each hold their statement's transaction open until a separate `commit` or `abort` step. A statement waiting on another backend's lock is reported as `blocked`.
  - Upload slots `U1` to `U3` each stop at their R2 put until `ok` or `fail`.
  - Time moves only by shifting stored timestamps, between transactions.

- The host refuses network egress: `fetch` throws, and object storage points at a closed loopback port.

tear is pinned by git rev in `Cargo.toml` (the same rev as the other checkers). Cargo fetches it with your git credentials (`.cargo/config.toml`), so you need read access to `anomalyco/tear`. tear is a dev tool only: nothing here ships with the API.

## Database

The host changes rows freely, and briefly disables a trigger inside its own time-shift transactions. So it runs only on a dedicated database, under the shared rule in `../disposable.ts`:

- `TEAR_DATABASE_URL` must be a plain loopback URL, with no query parameters.
- The database must carry the disposable marker. tear never sets it.
- The database must hold no workspace other than `default` or `tear_*`, and no user other than `tear-user-*`.

Its workspaces are named `tear_adm_*`. The `upload` profile's sweep and purge act on the whole database, so give this checker a database of its own.

From `api/`, after `bun install`:

```sh
createdb tear_admission
DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_admission BANE_ROOT_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts
psql postgresql://…@127.0.0.1:5432/tear_admission -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
export TEAR_DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_admission
```

## Pull-request run (about 30–40 s after the build)

```sh
cd api/tear/admission && cargo run --release -- ci
```

`ci` runs the following, prints a JSON report with checklist coverage (`checklist.missing` should be empty), and exits 1 on any mismatch or error:

1. The 18 bug witnesses (the four from the #57 review, the five from its first recheck and the two from its second) and 24 boundary traces.
2. Every transition of the core alphabet: `recv` to depth 2, `send` to depth 1, `upload` to depth 3.
3. 540 seeded random walks over the full alphabet and every configuration (about 12,000 steps).

It covers about 16,800 steps in 2,640 traces.

Pass `--seed N` to rotate the walks.

## Deeper runs

| Command | Size | Time (M-series Mac) |
|---|---:|---:|
| `cargo run --release -- edges 3 --profile recv` | 37,758 edges, 111,531 steps | about 5 min |
| `cargo run --release -- edges 2 --profile send` | 2,399 edges, 4,738 steps | about 20 s |
| `cargo run --release -- edges 3 --profile send --budget 600` | 46,794 edges, 137,923 steps | about 10 min (8 min covers 84%) |
| `cargo run --release -- edges 5 --profile upload` | 4,619 edges, 21,394 steps | about 40 s |
| `cargo run --release -- random 2000 30 --profile P --seed $(date +%s)` | 60,000 steps | about 1.5 min |

- `space N --profile P` prints the core graph's size per depth without touching the database.
- `boundaries` replays only the bug witnesses and boundary traces.
- `trace --profile P [--cfg I] ACTION…` replays one trace, for example `trace --profile recv "W accept m1 a" "V accept m1 a" "W commit" "V commit"`. Set `TEAR_STEPS=1` to print every step.

Host logs go to `target/host.log` (set `TEAR_LOG`). Set `TEAR_TRACE=1` to log every action and lock wait.
