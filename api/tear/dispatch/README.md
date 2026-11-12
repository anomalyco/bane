# tear: send path

Lives in `api/tear/dispatch/`. The access checker owns `api/tear/`. The disposable-database rule is one shared module, `api/tear/disposable.ts`: this host imports it, and the access host can import it in place of its identical inline check.

A [tear](https://github.com/anomalyco/tear) model check of admission, campaigns and the dispatcher. `src/model.rs` is an independent reference model, with the edge-case checklist at the top. `host.ts` runs the real API code over an isolated PostgreSQL database. `src/main.rs` drives both through tear's `runTrace` and reduces each mismatch with `minimizeTrace`.

## Database

The host rewrites column defaults (to a virtual clock that shadows `now()`, `clock_timestamp()` and `statement_timestamp()`) and changes rows freely, so it runs only on a dedicated database. `../disposable.ts` holds the rule tear hosts share:

- `TEAR_DATABASE_URL` must be a plain loopback URL. Query parameters are refused, because node-postgres lets them redirect the host or port.
- The database must carry the marker below.
- The database must hold no workspace or user that tear did not create.

The host checks the marker and data before its first write and again before every trace. The fake SES and storage keep the host away from AWS. They do not make a database safe to use.

Create and migrate a database of its own, then mark it once as its owner. tear never sets the marker. From `api/`:

```sh
createdb tear && DATABASE_URL=postgresql://…@127.0.0.1/tear BETTER_AUTH_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts
psql postgresql://…@127.0.0.1/tear -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
export TEAR_DATABASE_URL=postgresql://…@127.0.0.1:5432/tear
```

Turn off `fsync` and `synchronous_commit` on that cluster. Commit stalls otherwise push an action past its one-second budget.

## Pull-request run (about 30 s after the build)

```sh
cd api/tear/dispatch && cargo run --release -- ci
```

The run covers the 25 scenarios, 100 random walks of 24 steps over the exact configurations, 30 quota-profile walks, and every edge of the dispatch profile's model graph to depth 3. It also covers 30 two-owner walks. It prints a JSON report on stdout and exits 1 when any trace mismatches or errors; the reasons go to stderr. Each distinct mismatch appears under `witnesses` with its reduced trace, and `coverage` counts every edge case reached. `cargo test` checks that exit rule.

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
