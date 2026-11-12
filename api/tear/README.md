# tear: idempotency and access control

A model checker for the API's idempotency reservations, grant revocation and ownership, and MCP listings versus REST authorization. It uses [tear](https://github.com/anomalyco/tear) (`statecheck`, pinned by git rev).

- `src/model.rs` has the edge-case checklist and an independent reference model written from the documented contract.
- `src/rest.rs` is REST's authorization for every MCP catalog operation, written from the handlers and route guards. Each actor's full listing must equal it, and `probe <actor> audit` checks it against real REST for every GET. A new route must be added there.
- `host.ts` drives the real API in-process (Bun) over an isolated PostgreSQL. It owns the frozen clock, the two request slots, crashes and lost commit acknowledgements.
- `src/main.rs` is the runner. It does random walks, breadth-first edge coverage, trace replay, witness reduction and checklist coverage.

## Run

Run from `api/` with `bun install` done and `DATABASE_URL` set to a dedicated, migrated, loopback database (never production). The host refuses any database that lacks this marker, and any database holding a workspace or user it did not create. It checks both at startup and before every fixture. Loopback alone is not proof, because a tunnel to a real database also listens there.

Whoever creates the disposable database marks it once. This needs the database owner, and tear never sets the marker itself:

```sh
psql "$DATABASE_URL" -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
```

```sh
cargo build --release --manifest-path tear/Cargo.toml
T=tear/target/release/bane-tear-access
$T ci                                   # CI size: about 47 s on 4 workers, exits 1 on any mismatch
$T trace "mint key" "lost list key k1 b1" "create list key k1 b1"   # replay one trace
```

`ci` replays the shortest witness of every bug found so far and covers every edge of the core graph (depth 3), the two-slot race (depth 7) and the in-flight revocation (depth 8). It then runs seeded random walks until `--budget` (45 s) runs out. Each mismatch is reduced to a minimal trace, and the JSON report lists checklist coverage.

## Deeper runs

| Run | Size | Time (10 workers, M-series Mac) |
|---|---|---|
| `$T edges 4 -j 10` | 5,547 states, 18,552 edges | about 75 s |
| `$T edges 9 --alphabet race -j 10` | 2,707 states, 10,255 edges | about 16 s |
| `$T edges 8 --alphabet revoke -j 10` | 73 states, 212 edges | about 3 s |
| `$T random 10000 30 -j 10 --seed S` | 300,000 steps | about 4–5 min |

For a nightly run, rotate `--seed` by date. Set `TEAR_HOST_LOG=1` for API logs, or `TEAR_HOST_SQL=1` for each statement with its checkpoint.
