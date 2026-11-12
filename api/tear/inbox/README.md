# tear: inbox phase 2

Lives in `api/tear/inbox/`. The access checker owns `api/tear/` and the send-path checker lives in `api/tear/dispatch/`. Every tear host shares one disposable-database rule, `api/tear/disposable.ts`, which this host imports.

A [tear](https://github.com/anomalyco/tear) model of inbox folders, per-folder UIDs, UIDVALIDITY, MODSEQ, flags, move/copy/expunge, tombstones, counters and change sync under concurrent ingest. Each step runs on the real API routes and SQL routines over an isolated PostgreSQL. It is checked against an independent reference model, and failing traces are reduced to short, replayable witnesses.

- `src/model.rs` is the reference model: committed state, head state and one transaction per connection, with the documented lock order (ingest lane, receipt row, inbox rows by id).
- `src/main.rs` holds the edge-case checklist and its coverage, the properties, and the run modes.
- `host.ts` drives the real code with Bun. Ingest workers `I` and `J` and API handlers `W` and `V` each hold a statement open on their own connection until a separate `commit` or `abort` step. A statement waiting on another backend's row lock is reported as `blocked`.

tear is pinned by git rev in `Cargo.toml`. Cargo fetches it with your git credentials (`.cargo/config.toml`), so you need read access to `anomalyco/tear`. tear is a dev tool only: nothing here ships with the API.

## Database

The host changes rows freely, so it runs only on a dedicated database. It follows the shared rule in `../disposable.ts`:

- `TEAR_DATABASE_URL` must be a plain loopback URL. Query parameters are refused, because node-postgres lets them redirect the host or port.
- The database must carry the disposable marker. tear never sets it.
- The database must hold no workspace other than `default` or `tear_*`, and no user other than `tear-user-*`.

The host checks the URL before it connects. It checks the marker and data before its first write and again before every trace, and exits 1 with the reason if a check fails. Its workspaces are named `tear_inbox_*`.

Create and migrate a database of its own, then mark it once as its owner. From `api/`, after `bun install`:

```sh
createdb tear_inbox
DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_inbox BETTER_AUTH_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts
psql postgresql://…@127.0.0.1:5432/tear_inbox -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
export TEAR_DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_inbox
```

Use a separate database for this checker and for each parallel campaign. The tombstone prune and the inbox sweep act on the whole database, not one workspace.

## Pull-request run (about 30 s after the build)

```sh
cd api/tear/inbox && cargo run --release -- ci
```

`ci` replays the bug witnesses and boundary traces, runs 300 random walks of 30 steps, and covers every transition of the core alphabet to depth 3 (about 15,000 steps). It prints a JSON report and exits 1 on any mismatch, printing each one as a reduced trace.

## Deeper runs

| Command | Steps | Time (idle laptop) |
|---|---:|---:|
| `cargo run --release -- edges 4` | 64,000 (16,625 edges) | about 2–4 min |
| `cargo run --release -- edges 5` | about 0.9 M (181,599 edges) | about 20 min |
| `cargo run --release -- random 5000 40 --seed $(date +%s)` | 200,000 | about 4 min |
| `… random 1500 40 --quota 1` or `--quota none` | 60,000 | about 1.5 min |

- `space N` prints the core graph's size per depth without touching the database.
- `trace ACTION…` replays one trace, for example `trace "accept m1 a" "store m1" "W delete A" "V seen A m1" "W commit"`.

Host logs go to `target/host.log` (set `TEAR_LOG`). Set `TEAR_TRACE=1` to log every action and lock wait.
