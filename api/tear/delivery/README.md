# tear: received-mail delivery

Lives in `api/tear/delivery/`. The access checker owns `api/tear/`; dispatch, inbox and gateway have their own subdirectories. Every tear host shares one disposable-database rule, `api/tear/disposable.ts`, which this host imports.

A [tear](https://github.com/anomalyco/tear) model of what happens to received mail after it is stored: the routing plan (exact routes, local-part patterns, the `*@` catch-all, drop, disabled routes), rituals (endpoint calls, the three-calls-per-endpoint cap, the 32-intent budget and fail-to-junk), and endpoints (webhook, replay-safe webhook, Slack, forward) through the one delivery path, `ritualDelivery`: retries, backoff, Retry-After, per-endpoint rate limits, Idempotency-Keys, the attempt fence, pause, delete, forward decline and loop suppression.

- `src/model.rs` is the reference model, written from the documented contract.
- `src/main.rs` holds the edge-case checklist and its coverage, the properties, the bug witnesses and the run modes.
- `host.ts` drives the real code with Bun: SNS acceptance, the ingest job, the fan-out job, and two job runners (`K`, `L`) running the real `processJobs` on their own connection pools. Each webhook POST parks until the model answers it (`reply K 503`, `reply K 429 120`, `reply K timeout`), so pauses, deletes, lease expiry and a second runner can interleave with a request in flight. `claim K d` parks a runner between its claim and its handler. `crash K` kills a runner after its request left (`drop K`: before), and its connections are terminated.

The host owns time: every pending job is parked, `run K d` makes only `d` due, `expire d` ends its lease, `tick` starts a new rate-limit minute, and backoff jitter is pinned (`Math.random` is 0.5) so every delay is exact.

## Properties

- Conformance: each step's result, the requests the endpoints received, and the committed view (every delivery's status, attempt count, error, fence state, job status and attempts, scheduled delay; endpoint state; box labels; forwards) equal the model's.
- tear's temporal monitor, on the observations alone: `delivery.once` (no repeat after a success, an unknown outcome or an overlapping request, except to a replay-safe endpoint with the delivery's own Idempotency-Key), `delivery.attempts` (at most 1 + retryAttempts requests), `endpoint.held` (no request starts to an endpoint paused or deleted before the step) and `delivery.settles` (on drained walks, everything queued is delivered, dead-lettered, parked or deleted).

tear is pinned by git rev in `Cargo.toml`. Cargo fetches it with your git credentials (`.cargo/config.toml`), so you need read access to `anomalyco/tear`. tear is a dev tool only: nothing here ships with the API.

## Database

The host changes rows freely, so it runs only on a dedicated database. It follows the shared rule in `../disposable.ts`: `TEAR_DATABASE_URL` must be a plain loopback URL, the database must carry the disposable marker (tear never sets it), and it must hold no workspace other than `default` or `tear_*` and no user other than `tear-user-*`. The host checks the URL before it connects and the marker and data before its first write and before every trace. Its workspaces are named `tear_dlv_*`.

Create and migrate a database of its own, then mark it once as its owner. From `api/`, after `bun install`:

```sh
createdb tear_delivery
DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_delivery BETTER_AUTH_SECRET=… PUBLIC_URL=http://127.0.0.1 node --import tsx src/migrate.ts
psql postgresql://…@127.0.0.1:5432/tear_delivery -c "DO \$\$ BEGIN EXECUTE format('COMMENT ON DATABASE %I IS %L', current_database(), 'bane-tear: disposable test database, every row may be changed or deleted'); END \$\$"
export TEAR_DATABASE_URL=postgresql://…@127.0.0.1:5432/tear_delivery
```

Use a separate database for each parallel run: the job runner claims across the whole database.

## Pull-request run (about 55 s after the build)

```sh
cd api/tear/delivery && cargo run --release -- ci
```

`ci` replays the bug witnesses, covers every transition of the core alphabet (one message and its duplicate, routing, every fault and admin action) and the ritual alphabet to depth 2, then runs drained random walks over the full alphabet with retryAttempts 1, 0 and 2 until `--budget` seconds (default 55) have passed. It prints a JSON report (with checklist coverage and the temporal verdicts) and exits 1 on any mismatch, error or temporal violation, printing each mismatch as a reduced trace.

## Deeper runs

| Command | Traces | Time (idle laptop) |
|---|---:|---:|
| `cargo run --release -- edges 3 --alpha core` | 3,040 (8,822 steps) | about 75 s |
| `cargo run --release -- edges 3 --alpha ritual` | 22,685 (66,837 steps) | about 8 min |
| `cargo run --release -- random 2000 30 --seed $(date +%s)` | 2,000 walks plus drains | about 6 min |
| `… random 2000 30 --retries 0` or `--retries 2` | | about 6 min |

- `space N --alpha A` prints a graph's size per depth without touching the database.
- `trace ACTION…` replays one trace, for example `trace "ingest m1 a" "claim K m1:W" "pause W" "go K"`. Add `--retries R` for the fixture's retryAttempts, and `TEAR_STEPS=1` to print every step.

Host logs go to `target/host.log` (set `TEAR_LOG`). Set `TEAR_TRACE=1` to log every action and host error.
