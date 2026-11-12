# Dispatch throughput: findings, design and scaling playbook

## Current Hosted release gate (2026-11-10, local measurements)

**Keep production at 8 shards per shared account/region.** Six in-flight calls per shard at 170 ms give an ideal ceiling of 35 recipients/s/shard for one-recipient envelopes. Use **25/s/shard** for initial sizing, not the ideal ceiling. Start at **2–3 shards for 50/s, 8 for 200/s, 40 for 1,000/s**. BYO remains one shard. A 40-shard region may open 80 dispatcher DB clients before HTTP, queues or cron. Drain the old shard-count generation before enabling the new one: count is part of the DO identity. A higher shard count is neither an SES quota increase nor a demonstrated end-to-end rate.

Measure *accepted* and *delivered* separately. This fixture uses real PostgreSQL and dispatcher code with a synthetic 170-ms SES transport. Classifier RTT, Hyperdrive RTT, large-attachment bandwidth, SES throttling and webhook latency are not represented. End-to-end approval requires flat feedback and webhook ages under sustained regional load, daily recipient quota, healthy Postgres pool/lock waits and provisioned storage headroom. Do not advertise an industry ranking from this benchmark.

| Regional quota | Envelopes | Eight-shard acceptance, audit → rerun | Rerun per shard |
|---:|---:|---:|---:|
| 50/s | 250 | 35.8 → 36.2/s | 4.5/s |
| 200/s | 1,000 | 186.8 → 184.7/s | 23.1/s |
| 1,000/s | 1,500 | 271.0 → 259.9/s | 32.5/s |

These finite runs include cold quota election and draining an uneven tail. Eight shards do **not** sustain 1,000/s. Sizing is a starting point; it is not evidence that 40 shards, or the current single feedback consumer, can sustain that rate.

### Query and storage budget

Baseline `bb00802` and the working tree use the same local fixtures. Calls count driver round trips **including BEGIN/COMMIT** (savepoint/release inside the rollback harness); a lone statement commits implicitly in production. Writes count inserted/updated row versions, including triggers; bytes sum `pg_column_size(NEW)`, **not** network traffic, indexes, TOAST, dead tuples or WAL. Counts vary with batch completion order, ID length, number of dirty counter stripes, cold quota elections and subscribers. Campaign figures use 100 recipients and 20 attachments; divide by 100 for cost per recipient. Reply includes idempotency and a selected visible parent. Direct measurements use a warm quota, API key, simulator, no subscribers and preverified domain, isolating the database cost from classifier/provider latency.

| Path | Calls before → after (explicit transactions) | Row versions before → after | Logical bytes before → after |
|---|---:|---:|---:|
| Transactional admission, 1 | 4 → **1** (1 → 0) | 5 → 6 | 1,334 → 1,440 |
| Warm fused lease/claim, 1 | 1 → 1 (0) | 2 → 2 | 898 → 900 |
| SES acceptance write, 1 | 1 → 1 (0) | 4 → 5 | 1,780 → 1,888 |
| Delivery, 1 | 1 → 1 (0) | 5 → 5 | 2,108 → 2,112 |
| Batch admission, 100 | 4 → **1** (1 → 0) | 102 → 118 | 58,756 → 60,644 |
| Batch dispatch incl. acceptance, 100 | 30 → 31 (0) | 700 → 760 | 323,200 → 330,240 |
| Delivery batch, 100 | 1 → 1 (0) | 500 → 500 | 210,800 → 211,200 |
| Campaign launch incl. capture | 19 → 19 (1) | 123 → 123 | 26,060 → 26,060 |
| Campaign preparation | 11 → 11 (1) | 101 → 101 | 27,916 → 27,116 |
| Campaign release | 14 → 13 (1) | 2,102 → 102 | 503,632 → 46,304 |
| Campaign dispatch incl. finish | 43 → **41** (0) | 803 → 803 | 801,312 → 335,840 |
| Inbound reply admission | 25 → 23 (1) | 11 → 13 | 5,047 → 5,225 |

Hosted direct JSON sends with a normal API key use **one client statement** for authentication, the request budget, policy checks, the idempotency receipt and all envelopes. For bodies over 64 KiB with a cold credential fingerprint, authentication runs first to bound speculative parsing; subsequent direct admissions can fuse authentication again. A policy denial releases its new receipt without refunding the request charge; neither envelopes nor attachment links nor unsubscribe tokens are created. This is not a one-call claim for mailbox tracking, stored templates, self-hosted discovery or dashboard authentication. A screened Hosted singleton still needs a lease, external screen, fresh authorization/consent claim and outcome write (three statements with warm quota; two for envelopes eligible for the fused claim). No database lock crosses the classifier or SES call, and ambiguous acceptance is never automatically resent.

The previous audit-fix build took **46** calls for campaign dispatch and finish. The lease now returns attachment metadata once per immutable review, and small attachment pages can overlap within the shared byte limit. The acceptance fixture asserts at most **42** calls, a finished campaign and no per-recipient attachment copies. It measured **41** in the full run.

**Campaign storage:** 5,438 → 872 logical bytes per accepted recipient, including its prepared recipient and envelope rows and private per-email attachment links. For 1M equivalent recipients that is **5.438 GB → 0.872 GB** (decimal; projection from measured tuples, not a 1M-row physical database size). Store the frozen draft, rendered base and attachment ownership once per review. The minimal envelope holds indexed delivery/search fields and kind, a deferred marker and, once claimed, its unique unsubscribe capability. No copied body, headers, attachment IDs or email attachment links. A 2,000 × 20 release went from failing to construct the bind list to one bounded recordset insert; the immutable review owns 20 links, not 40,000.

### Feedback, webhook and screening operations

`FEEDBACK_BATCH.retiredUnmatched` counts unresolved callbacks acknowledged after one short retry: these came from a verified BYO topic or name mail older than the 30-day detail window. Recent unmatched Hosted feedback and failed persistence still retry. BYO ingress uses a per-topic limit after signature verification; one customer's SNS topic cannot consume another's allowance.

* The deployed config is `api/wrangler.prod.jsonc`. Queue names use `bane-prod-` (dev: `bane-dev-`). Provision the Pulumi queues **before** the config change. Work and webhook consumers have separate claims and wake reservations. The endpoint cap is ten including paused; inventory grandfathered workspaces before rollout. At 100 callbacks the worst new workspace creates 1,000 deliveries, not 10,000. In the final local storm fixture, 100 deliveries × ten endpoints took 50.5 ms vs 233 ms at the previous 100-endpoint fan-out. Six campaign claims behind 100k ready webhook jobs took 0.141 ms DB with no temp spill vs the old priority sort's 111.5 ms and 6,192 kB spill.
* **Page on any `QUEUE_BACKLOG_ALERT` for `feedback-dlq`, or `oldestMs > 60000` for feedback.** Minute cron samples queue bindings independently of DB ingestion. If cron itself is unhealthy, the independent [Queues metrics](https://developers.cloudflare.com/queues/observability/metrics/) endpoint provides depth and oldest timestamp. `FEEDBACK_BATCH` reports failures and oldest callback age; alert on sustained failures, `SES_FEEDBACK_QUARANTINED`, `CONTENT_SCREEN_UNAVAILABLE`, ambiguous/interrupted attempts, SES throttles and account pauses. Monitor per-stream acceptance using the metrics API; watch pool acquisition/lock waits, deadlocks, WAL and autovacuum externally. Source sampling applies only to successful routine requests, never warnings/errors. Do not log message bodies or classify queue payloads as wake hints.
* **Private DLQ replay:** stop on any ownership ambiguity; never invent a workspace or alter the topic, message ID, provider ID or payload. Repair DB availability, conflict or pinned attribution first. An authorized operator enables [HTTP pull](https://developers.cloudflare.com/queues/configuration/pull-consumers/) **only on the stage's `feedback-dlq`**, pulls a small batch with a visibility lease and republishes each original JSON body to that stage's `feedback` queue. For JSON pull responses decode the base64 JSON first; publish as JSON, not a base64 string. Ack a DLQ lease **only after confirmed enqueue**. On uncertainty stop, leave it unacked and replay idempotently. Inspect SNS receipt, suppression/event and queue depth after the canary before continuing. No email is sent by replay. DLQ retention is finite: page immediately; if unresolved, preserve verified inputs in restricted incident storage before expiry. DB quarantine is also private, and its existing retention is unchanged.
* Configure Jev before enabling Hosted live traffic. Start with dev, inspect rejection/deferral metrics, inventory DMARC for active exact From domains, then enable production. Hosted marketing and probation defer during classifier/key failure; a password reset on an operator-approved trusted pool may proceed during an outage. A sender cannot choose that tier or opt out. The simulator and BYO delivery remain separate. Hosted marketing and high-volume transactional senders require aligned DMARC. Leases omit Hosted envelopes that do not fit the remaining minute budget, before classifier and storage work. Only the durable claim charges the budget; it rechecks current state to arbitrate between shards. BYO is not charged. Default budgets: new/second-week/mature workspace limits are 50/100/500 per fixed minute; individual From identities get half with a floor of 50. A daily override raises the workspace minute floor to `ceil(override / 1440)`. Explicit Hosted quota exemptions remain operator-owned. Missing attachment bytes get four delayed retries before a final rejection; the repair queue is `sending_emails WHERE status='rejected' AND error_code='ATTACHMENT_STORAGE_UNAVAILABLE'`. Restore immutable bytes and verify the checksum before a separately authorized **new** submission. Never reset an attempting or ambiguous row.

The sections below are historical measurements, **not** the current production manifest.

Status as of 2026-09-12, `main` at `7f82248` (deployed). Written so the next person who hits a
throughput wall can start from measurements instead of theory. Numbers below were measured against
production infrastructure (Cloudflare Workers/Durable Objects/Queues, Hyperdrive, PlanetScale Postgres
in us-east-2, SES us-east-1) unless marked otherwise.

## 1. The question that started this

Campaigns of 50–100k recipients felt slow. The live SES quota in us-east-1 is **20 recipients/s**
(250k/day), so the real ceiling for a 100k campaign is 83 minutes regardless of infrastructure; the
goal became: saturate whatever quota we have, exactly and steadily, with a design that keeps working
when the quota grows toward thousands per second.

## 2. What the original pipeline actually did (measured)

Design: PostgreSQL `jobs` table as the queue (one `email.dispatch` row per recipient), Cloudflare
Queues used only as a wake-up signal, consumer invocations with a 2 s drain budget and six lanes,
a permit gate in `sending_region_limits` with a one-second look-ahead, SNS feedback turned into
`operation.ses` jobs in the same table.

| Measurement | Value |
| --- | --- |
| Live 1k campaign, active dispatch rate | 12.5/s (curve: 5/s for 10 s → 10/s → 20/s after 25 s, sagging to ~9/s mid-run) |
| Test-mode 10k campaign, quota gate removed (5,000/s) | **17/s mean**, 19 median, 41 peak, 28 idle seconds, 582 s |
| Per-email database time | ~800 ms of a 1.3 s job: ~10 sequential round trips at 70–80 ms each |
| Feedback share of lane time | 2 `operation.ses` jobs per email ≈ 37 % of all lane-seconds; delivery lagged dispatch by 160 s |
| Expansion | 270 jobs for 10k rows (50 productive @ 200 rows, 220 buffer-full deferrals) |

Root causes, in order of impact:

1. **Queues autoscaling was blind.** Postgres held the backlog; Queues saw a flat handful of wake
   messages and kept 2–5 invocations instead of 8. Each invocation lived ~2.5 s, so concurrency
   thrashed and every cycle paid Queues redelivery latency.
2. **Consumers cannot be placed.** Smart Placement applies only to `fetch` handlers; queue and cron
   consumers ran ~70–80 ms from the database, and every email paid that ten times.
3. **Hyperdrive origin limit 20** vs 8 invocations × 6 pool + HTTP + cron. Claims (a 4-statement
   transaction) held an origin connection ~300 ms.
4. **Feedback competed with dispatch** for lanes and connections.
5. Latent: every 60 s all lanes hit stale quota and called `GetAccount` (1 TPS, unadjustable).

The pipeline did reach exactly 20/s in stretches, so the gate and claim logic were correct; the
scheduling around them was the problem.

## 3. What was built

Commits `be8076e` → `7f82248` on `main`.

### 3.1 Batch dispatcher (`api/src/dispatcher.ts`)
- Queued `sending_emails` rows *are* the queue. No per-recipient job rows.
- Loop per environment/region: one statement leases up to 24 due rows (`FOR UPDATE SKIP LOCKED`,
  `lease_until`), rows are prepared in memory (render, hash check, MIME), then processed in
  **groups of six**: one claim statement (key revocation under `FOR SHARE`, consent locks, campaign
  cancellation, unsubscribe token, attempt event; flips `queued → attempting` under
  `dispatch_version`), paced provider calls, one record statement (events, monotonic status, public
  events, webhook deliveries, throttled requeue). Recording overlaps the next group.
- Group size six = the Workers limit of six connections awaiting response headers per invocation,
  and the exposure window if the host is reset mid-call (see §6).
- Origin authorization (permissions, sender domain, workspace membership, MCP grant) is evaluated once per
  actor/domain per run and cached 10 s; durable key revocation is enforced inside the claim statement.
- Recovery: rows `attempting` for >3 min become `acceptance_unknown` (never auto-resent; SES has no
  idempotency key). Leases expire after 2 min. Preflight failures reject or retry after 15 s.

### 3.2 Hosts
- **Cloudflare:** `DispatcherShard` Durable Object per `environment:region:shard/count`
  (`api/src/dispatcher-do.ts`), `locationHint: 'enam'`; landed in EWR/IAD/ATL with 6–24 ms database
  round trips. Alarm loop runs 45 s then re-arms; keeps its `pg` pool (max 4) and pacing state across
  alarms, persists the gate to DO storage so eviction never bursts. Woken by API sends
  (`Actor.dispatchTargets`), campaign expansion, and the minute cron. Logs `DISPATCHER_PLACEMENT`
  once per lifetime and `DISPATCH_RUN` per run with per-phase timings.
- **Node:** the runner (`api/src/runner.ts`) calls `drain()`, which runs orchestration jobs and then the
  same dispatcher loop per environment/region with an in-process gate. Tests use `dispatchDue()`.
- The Cloudflare queue consumer runs orchestration only (`drainJobs`, 10 s budget).

### 3.3 Pacing (`GateState`, `reserve`, `brake`)
- Target per shard = `MaxSendRate × DISPATCH_RATE_FACTOR ÷ shards` (or an absolute live
  `DISPATCH_TARGET_RATE`). Production uses factor `1.1` → 22/s at a 20/s quota. Slots are spaced
  evenly per recipient. The shared gate assigns each slot only when it opens: ready transactional
  mail goes before waiting marketing, without reserving rate for either stream. A transactional API
  admission nudges the active shard (Node: `LISTEN/NOTIFY`; Cloudflare: the existing DO wake) to
  lease fresh transactional work without polling between sends. Existing provider calls finish;
  missed wakes and scheduled rows are still picked up by the ordinary fair per-owner batch lease.
  Grouped claims have a five-second pre-provider deadline. Longer waits stay queued; if preemption
  moves a slot beyond the deadline after claim, the uncalled message is requeued for another shard.
- Marketing leaves `DISPATCH_DAILY_HEADROOM_PERCENT` of the rolling 24-hour quota unused (default
  10%); transactional mail may use it. Quota holds leave the campaign `sending` and its rows queued.
  The dispatcher rechecks at the next quota-cache refresh, not on every send or via a manual resume.
- Any `429` sets `brakeUntil = now + 10 s` (target falls to the raw quota) and yields the slots the
  shard ran ahead by. Throttled rows requeue with 2 s, 4 s, 8 s, 16 s, 32 s backoff (five attempts).
- `sending_region_limits` is the shared one-minute quota cache; only a shard that finds it stale calls
  `GetAccount`, with a conditional upsert so concurrent shards don't repeat the call.

### 3.4 Feedback (`bane-feedback` queue)
- `/v1/events/ses` verifies the SNS signature and account binding, enqueues, returns 202 with no
  database call. Exempt from the per-IP admission limiter (SNS publishes from a small IP pool).
- Consumer: batches of ≤100 within 2 s. Routine Delivery (and any Send) callbacks are persisted by one
  set-based statement per environment (`ingestRoutineSesEvents`; `DISTINCT ON` picks the
  highest-ranked event per email when several share a batch). Bounce/complaint/engagement/subscription
  are processed inline with their receipt. Messages ack/retry individually.
- `SEND` removed from the SES event destination: acceptance is recorded from the `SendEmail` response;
  the callback doubled feedback volume. Re-run provisioning after this change (done for us-east-1).
- Test-mode simulated Send/Delivery callbacks ride the same queue wherever a `runtime.feedback` sink
  exists, so test mode exercises the live ingestion path.

### 3.5 Orchestration bounds
- Preparation up to 20,000 rows / 64 MiB estimated content / 10 s per job (was 1,000 rows / 4 MiB);
  a 10k static campaign is one hop.
- Expansion 2,000 rows per job; buffer = 10 s of the cached rate per campaign (400 floor, 20k cap),
  20 s per environment (1k floor, 50k cap).
- Campaign launches request an uncoalesced scheduler wake (`Actor.wakeJobs`).
- Migration `019_batch_dispatcher.sql`: `sending_emails.lease_until`, partial indexes for due and
  attempting rows. Pre-migration `email.dispatch` jobs complete as no-ops.
- Hyperdrive `origin_connection_limit` raised 20 → 35 (Postgres `max_connections` is 50).

## 4. Results

All test-mode runs: 10,000 recipients, simulated SES at 170 ms (measured live p50), simulated quota
5,000/s so the gate is not the ceiling. Curves come from `attempt_started_at` per second.

| Build | Mean | Median | p90 | Peak | Wall to all delivered | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline (jobs + Queues) | 17/s | 19 | 31 | 41 | 783 s | 28 idle s; feedback 160 s behind |
| DO, 1 shard | 34/s | 40 | 40 | 40 | 293 s | flat; exactly the 6 × 170 ms ceiling |
| DO, 4 shards, feedback queue | 124/s | 140 | 160 | 190 | ~100 s | 40 rows stranded by a DO reset |
| DO, 4 shards, grouped claim | 119/s | 132 | 144 | 156 | 124 s | 0 stranded; start latency 37 s (9 prep hops) |
| + 20k prep, uncoalesced wake, 10 s drain | 118/s | 132 | 150 | 162 | 97 s | start latency 11 s; 20 job rows total |
| Pacing check: quota 20, factor 1.1, 1k | 21.3/s active | | | | 60 s | target 22 |

Live, 1,000 real recipients, quota 20/s: **21.3/s over a 47 s span, all delivered, zero 429s, zero
stranded rows, 76 s request→all delivered** (previously 12.5/s active, 117 s).

Per-shard phase timings from `DISPATCH_RUN` at 4 shards (lane time ÷ emails): claim 13 ms, record
15 ms, lease 3 ms, send 47 ms (six-wide, two lanes sharing), origin/quota/prepare ≈ 0. Per statement:
40–130 ms under load versus 8–25 ms idle → contention, not distance (§5.2).

## 5. Ceilings, component by component

### 5.1 Dispatcher shard (Durable Object)
- Hard: six provider calls in flight per invocation → `6 ÷ latency`. At SES's ~170 ms that is 35/s;
  measured 30–34/s including database work. Faster provider latency raises it proportionally.
- CPU: 0.5–2 ms per email (render, hash, SigV4, JSON). A 45 s run at 35/s ≈ 1.5 s CPU; default DO
  budget 30 s per invocation. Not binding below ~500/s per shard, which the connection limit prevents anyway.
- Count: unlimited. Scaling measured near-linear 1 → 4 shards. Rule: `DISPATCH_SHARDS ≈ quota ÷ 25`.
- **Today's configuration (4 shards) becomes the bottleneck at a quota of ~120/s.**

### 5.2 PostgreSQL + Hyperdrive
- Statements per email ≈ 1/24 lease + 1/6 claim + 1/6 record ≈ 0.38, plus 1 per 100 feedback events,
  plus expansion inserts (2,000 rows each).
- Claim statement server cost ≈ 5 ms (3.3 planning + 1.4 execution, `EXPLAIN ANALYZE`). Idle round
  trip from the DOs 6–24 ms; large-parameter query 8–33 ms. Under 8 lanes + feedback + expansion,
  claim/record rose to 40–130 ms → connection-queue contention at Hyperdrive (35 origin connections)
  and/or Postgres. This is the next wall: expect it to bite around **300–500/s (12–20 shards)**.
- Levers, in order: larger PlanetScale instance (`max_connections` 50 today), Hyperdrive limit toward
  45, bigger groups (each doubling halves statements per email but doubles reset exposure), merging
  the record of group N with the claim of N+1 into one statement.
- Write volume at 5,000/s ≈ 25k row writes/s during a burst (email update, attempt event, accepted
  event, token, public event); needs a database sized for that before it is attempted.

### 5.3 Expansion and preparation
- Expansion is a single sequential chain per campaign: 2,000 rows per job, one scheduler hop
  (~1–2 s) between jobs → ~1,000–2,000 rows/s per campaign. Fine to ~1,000/s; above that, parallel
  expansion workers (partition the review by ordinal range) are required.
- Preparation: 20k rows or 10 s per job, sequential cursor. A 100k static campaign ≈ 5 hops ≈ 15 s.

### 5.4 Feedback
- Cloudflare Queues: 5,000 messages/s per queue. Volume ≈ 1 Delivery per email + bounces + delays +
  opens/clicks over days. One queue is enough to ~4,000/s of sends; shard by region or hash beyond that.
- Batch statement handles 100 events with one round trip; consumer `max_concurrency` 10.
- SNS ingress: one Worker request per callback, no database call. Fine.

### 5.5 Provider control plane
- `GetAccount` is 1 TPS and not adjustable; the cache makes it ~1/min/region regardless of shards.
- SES `SendEmail` latency ~165–175 ms p50 from Workers; bandwidth becomes relevant only with large
  attachments (SES documents throttling to ~40 MB/s for >10 MB messages).

### 5.6 Platform semantics to design around
- **Durable Objects are reset on deploys and when a `wrangler tail` attaches.** In-flight groups at
  that instant end as `acceptance_unknown` after 3 min (six rows per lane at most). Do not deploy or
  attach tails during a live campaign you care about; use `--no-tail` for benchmarks.
- `locationHint` is honored only at first creation; a shard keeps its colo for life. Delete and
  recreate (rename) shards to move them.
- Alarm wall limit 15 min (we use 45 s); CPU limit 30 s per invocation by default.

## 6. Scaling playbook by SES quota

| Quota | Action |
| --- | --- |
| 20 → ~100/s | Nothing. One shard already saturates 35/s; four are deployed. Factor 1.1 follows the quota automatically. |
| ~100 → ~400/s | `DISPATCH_SHARDS = quota ÷ 25` (16 at 400). Hyperdrive limit toward 45. Watch `DISPATCH_RUN.timings.claim/record ÷ claimed`; above ~100 ms per statement the database is next. Run the 12-shard test-mode benchmark first (§7). |
| ~400 → ~1,500/s | Bigger PlanetScale instance (connections and CPU). Consider group size 12 (halves statements; doubles reset exposure to 12 rows per lane). Merge record+claim statements. Verify feedback consumer keeps `delivered ≈ accepted` during the run. |
| ~1,500 → 5,000/s | Parallel expansion per campaign. Second feedback queue (by region or hash). Database sized for ~25k row writes/s. ~200 shards. Request the quota increase only after a test-mode run at the target rate shows zero stranded rows and flat statement latency. |

Before any quota request: run the test-mode benchmark with `SIMULATED_SES_RATE` set to the target and
`DISPATCH_SHARDS` set for it. Test mode exercises everything except AWS itself and real SNS ingress.

## 7. How to measure again

Local, gitignored tooling in `api/` (tokens in `.env.benchmark`, 24 h agent tokens minted via MCP
`createAgentToken`):

```sh
# audience of N synthetic subscribed test contacts (creates a list, records its id in .env.benchmark)
node --env-file=.env.benchmark scripts/expand-test-benchmark-list.local.mjs --target=10000

# test-mode campaign (no real mail); --no-tail avoids resetting the Durable Objects mid-run
node --env-file=.env.benchmark scripts/test-campaign-benchmark.local.mjs --confirm-test-send --recipients=10000 --no-tail

# live campaign (real mail; requires BANE_LIVE_TOKEN and a ready domain)
node --env-file=.env.benchmark scripts/test-campaign-benchmark.local.mjs --live --confirm-live-send --recipients=1000 --from=benchmark@example.com --no-tail

# per-second dispatch curve straight from the database (attempt_started_at = claim time, groups of six)
node --env-file=.env.production scripts/dispatch-curve.local.mjs campaign_...
```

Reading the logs (Workers Logs or `wrangler tail --search DISPATCH_RUN`, attached ≥90 s before the
send so its reset happens while idle):

- `DISPATCH_RUN`: `claimed`, `sent`, `deferred`, `skipped`, `batches`, `statements`, `timings`
  (lease/claim/record/send/pace per lane in ms), `quota`, `rate` (effective per-shard target),
  `braked`. Per-statement cost ≈ `timings.claim ÷ (claimed ÷ 6)`.
- `DISPATCHER_PLACEMENT`: colo and `dbPingMs`/`dbPayloadMs` once per object lifetime.
- `FEEDBACK_BATCH`: batch size and failures; `SES_FEEDBACK_INGESTED`: processed/deferred/duplicate.
- Database: `sending_emails` by status for the campaign (any `acceptance_unknown` with
  `INTERRUPTED_PROVIDER_ATTEMPT` means a host reset mid-call); `jobs` should show only
  one `campaign.run:<id>` row per active campaign.

Benchmark artifacts live in `api/.benchmark-results/` (gitignored).

## 8. Open items

- Run 12 shards against the 10k test list to locate the database wall precisely.
- Parallel expansion design (partition `sending_review_recipients` by ordinal range across N expand
  jobs; each inserts its own rows; completion when all partitions report).
- `campaign.finish` still polls every 2 s while a campaign has queued mail; the dispatcher could
  complete the campaign when it records the last row.
- `sending_region_limits.reserved` is unused since the in-memory gate. `next_allowed_at` now fences
  self-hosted quota refreshes; it is not the provider pacing clock.
- Node runners hold one in-process gate each; running several against one region overshoots the quota
  unless the factor is split. Document or coordinate via `sending_region_limits` if Node replicas matter.
