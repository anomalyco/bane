# tear: send path

A [tear](https://github.com/anomalyco/tear) model check of admission, campaigns and the dispatcher. `src/model.rs` is an independent reference model, with the edge-case checklist at the top. `host.ts` runs the real API code over an isolated PostgreSQL database. `src/main.rs` drives both through tear's `runTrace` and reduces each mismatch with `minimizeTrace`.

## Database

Use a throwaway local database, never a shared or production one. The host shadows `now()`, `clock_timestamp()` and `statement_timestamp()` with a virtual clock and rewrites column defaults to use it.

```sh
createdb tear && DATABASE_URL=postgresql://…/tear BETTER_AUTH_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts   # from api/
export TEAR_DATABASE_URL=postgresql://…/tear
```

Turn off `fsync` and `synchronous_commit` on that cluster: commit stalls otherwise push an action past its one-second budget.

## Pull-request run (about 30 s after the build)

```sh
cd api/tear && cargo run --release -- ci
```

The run covers the 22 scenarios, 100 random walks of 24 steps over the exact configurations, 30 quota-profile walks, and every edge of the dispatch profile's model graph to depth 3. It prints a JSON report. Each distinct mismatch appears under `witnesses` with its reduced trace, and `coverage` counts every edge case reached.

## Deeper runs

```sh
cargo run --release -- random 2000 40 --seed 1000          # all profiles, about 13 min
cargo run --release -- random 1000 40 --profile campaign   # about 2 min
cargo run --release -- random 500 30 --profile quota        # SES quota and two shards, about 2 min
cargo run --release -- edges 5 --profile dispatch           # every edge to depth 5
cargo run --release -- edges 4 --profile campaign
cargo run --release -- trace --cfg 2 "launch" "jobs" "D1 step" …   # replay one witness
```

Use a different `--seed` for each nightly run. `--budget SECS` stops a run after that long.
