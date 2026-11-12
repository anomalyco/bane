# Inbox phase 2 state model (tear)

A [tear](https://github.com/anomalyco/tear) model of inbox folders, per-folder UIDs, UIDVALIDITY, MODSEQ, flags, move/copy/expunge, tombstones, counters and change sync under concurrent ingest. Each step runs on the real API routes and SQL routines over an isolated PostgreSQL. It is checked against an independent reference model, and failing traces are reduced to short, replayable witnesses.

- `src/model.rs` is the reference model: committed state, head state and one transaction per connection, with the documented lock order (ingest lane, receipt row, inbox rows by id).
- `src/main.rs` holds the edge-case checklist and its coverage, the properties, and the run modes.
- `host.ts` drives the real code with Bun. Ingest workers `I` and `J` and API handlers `W` and `V` each hold a statement open on their own connection until a separate `commit` or `abort` step. A statement waiting on another backend's row lock is reported as `blocked`.

tear is pinned by git rev in `Cargo.toml`. Cargo fetches it with your git credentials (`.cargo/config.toml`), so you need read access to `anomalyco/tear`. tear is a dev tool only: nothing here ships with the API.

## Run

You need Rust 1.88+, Bun and `bun install` in `api/`. You also need an isolated local PostgreSQL with migrations applied. Never point this at production: every run writes synthetic workspaces.

```sh
cd api
DATABASE_URL=postgresql://…@127.0.0.1:…/tear bun run migrate
cd tear
DATABASE_URL=postgresql://…@127.0.0.1:…/tear cargo run --release -- ci
```

`ci` is the PR-sized run: the bug witnesses and boundary traces, 300 random walks of 30 steps, and every transition of the core alphabet to depth 3 (about 18,000 steps). It takes about 30 s on an idle laptop. It exits non-zero on any mismatch and prints each one as a reduced trace.

Deeper runs:

| Command | Steps | Time (idle laptop) |
|---|---:|---:|
| `cargo run --release -- edges 4` | 64,000 (16,625 edges) | about 4 min |
| `cargo run --release -- edges 5` | about 0.9 M (181,599 edges) | about 20 min |
| `cargo run --release -- random 5000 40 --seed $(date +%s)` | 200,000 | about 4 min |
| `… random 1500 40 --quota 1` or `--quota none` | 60,000 | about 1.5 min |

- `space N` prints the core graph's size per depth without touching the database.
- `trace ACTION…` replays one trace, for example `trace "accept m1 a" "store m1" "W delete A" "V seen A m1" "W commit"`.

Run parallel campaigns only against separate databases. The tombstone prune and the inbox sweep act on the whole database, not one workspace. Host logs go to `target/host.log` (set `TEAR_LOG`). Set `TEAR_TRACE=1` to log every action and lock wait.
