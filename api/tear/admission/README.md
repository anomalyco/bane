# tear: admission and rate limits

Lives in `api/tear/admission/`. The access checker owns `api/tear/`; dispatch, inbox and gateway have their own subdirectories. Every tear host shares one disposable-database rule, `api/tear/disposable.ts`, which this host imports.

A [tear](https://github.com/anomalyco/tear) model of admission. Each step runs on the real API code over an isolated PostgreSQL. It is checked against an independent reference model, and failing traces are reduced to short, replayable witnesses. It has three profiles:

- **`recv`: the receive-side hourly window.**
  - Covers SNS notifications (the real `acceptInboundNotification` and its `mail_receive_admit` trigger), the message limit, the ingest backlog and the 100-recipient budget.
  - Covers budget holds released by `release_receive_budget_holds`, and their 72-hour expiry.
- **`send`: hosted send admission.**
  - Covers `POST /v1/emails/send` and `/batch` with a bearer key, through the one-statement atomic admission.
  - Covers the rolling 24-hour recipient cap shared by a quota sponsor's workspaces, the marketing reserve and the pending cap.
  - Covers the operator scripts `set-hosted-limits` (send and pending cap overrides) and `set-workspace-exemption`, plus hosted pause and resume.
  - Covers probation, second-week and mature tiers from clean history and connection age, Idempotency-Key replays, and the per-key minute budget.
  - Covers refunds by the `hosted_adjust` trigger.
- **`upload`: stored-attachment quota reservations.**
  - Covers reserve, R2 put, finish and refund in `POST /v1/attachments`.
  - Covers the hourly sweeper (the real `cleanup`) and the deletion jobs (the real job runner).

Files:

- `src/model.rs` is the reference model: committed state plus one open transaction per connection, with the lock order the contract documents.
- `src/main.rs` holds the edge-case checklist and its coverage, the properties, the bug witnesses and boundary traces, and the run modes.
- `host.ts` drives the real code with Bun.
  - Connections `W` and `V` each hold their statement's transaction open until a separate `commit` or `abort` step. A statement waiting on another backend's lock is reported as `blocked`.
  - Upload slots `U1` to `U3` each stop at their R2 put until `ok` or `fail`.
  - Time moves only by shifting stored timestamps, between transactions.

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
DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_admission BETTER_AUTH_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts
psql postgresql://…@127.0.0.1:5432/tear_admission -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
export TEAR_DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_admission
```

## Pull-request run (about 20–35 s after the build)

```sh
cd api/tear/admission && cargo run --release -- ci
```

`ci` runs the following, prints a JSON report with checklist coverage (`checklist.missing` should be empty), and exits 1 on any mismatch or error:

1. The six bug witnesses and 19 boundary traces.
2. Every transition of the core alphabet: `recv` to depth 2, `send` to depth 1, `upload` to depth 3.
3. 540 seeded random walks over the full alphabet and every configuration (about 12,000 steps).

Pass `--seed N` to rotate the walks.

## Deeper runs

| Command | Size | Time (M-series Mac) |
|---|---:|---:|
| `cargo run --release -- edges 3 --profile recv` | 3,364 edges, 9,662 steps | about 26 s |
| `cargo run --release -- edges 4 --profile recv` | 20,992 edges, 80,174 steps | about 2 min |
| `cargo run --release -- edges 2 --profile send` | 2,399 edges, 4,738 steps | about 30 s |
| `cargo run --release -- edges 3 --profile send --budget 600` | 46,794 edges, 137,923 steps | about 10 min (8 min covers 84%) |
| `cargo run --release -- edges 5 --profile upload` | 1,221 edges, 5,434 steps | about 10 s |
| `cargo run --release -- random 2000 30 --profile P --seed $(date +%s)` | 60,000 steps | 1–2 min |

- `space N --profile P` prints the core graph's size per depth without touching the database.
- `boundaries` replays only the bug witnesses and boundary traces.
- `trace --profile P [--cfg I] ACTION…` replays one trace, for example `trace --profile recv "W accept m1 a" "V accept m1 a" "W commit" "V commit"`. Set `TEAR_STEPS=1` to print every step.

Host logs go to `target/host.log` (set `TEAR_LOG`). Set `TEAR_TRACE=1` to log every action and lock wait.
