# Receiving audit fix: measurements and release evidence

The one hosted rule still takes zero per-domain or per-address conditions. [Production cause, operator commands and expected results](receiving-operations.md). No deployment, live delivery, database inspection or AWS/Cloudflare mutation was performed.

Verification on `fix-recv` off `bb00802`: `bun run check`, `bun run sdk`, the Pulumi TypeScript check and workflow `actionlint` passed. The full isolated acceptance harness ran 197 tests: **195 passed, 0 failed, 2 skipped** (`inbound_0fde4d9b91d5.out`). The benchmark cluster was stopped after measurement. Its JSON plans, query-meter logs and fixture drivers are under `~/dev/opensend-harness/pgdata-bench-fix-recv/`.

## Timing

Warm PostgreSQL 17.11 execution time in milliseconds, not Worker/Hyperdrive/S3 latency. Same isolated audit fixture: 1,000 workspaces, 100,000 domains/claims, 100,000 addresses on the hot domain, 100,000 archived sends with message-ID rows. Three measured executions after warm-up, savepoint rollback, normal planner settings. The before column reruns the audited implementation; audit figures differ across runs. A claim requests six slots with only ingest jobs due. One isolate intentionally leases one MIME job, leaving siblings available to other isolates. Existing-address store cases include one small attachment metadata row.

| Actual application operation | Before (ms) | After (ms) |
|---|---:|---:|
| One known host, receipt + job committed by statement | 15.04–16.62 | **0.230–0.252** |
| One unrelated host, no workspace work | 22.75–22.99 | **0.084–0.106** |
| Claim from 10k due ingests | 1.79–1.85 | **0.135–0.145** |
| Claim from 100k due ingests | 18.63–19.90 | **0.164–0.174** |
| Existing address, new thread | 2.43–2.66 | 1.66–3.12 |
| 100 ordinary external references + own ID, 100k sends | 138.33–139.35 | **1.88–2.32** |
| Actual SES-shaped outbound parent, 100k sends | 1.93–2.27 | 1.83–2.22 |
| Unmatched local part, 10k legacy wildcard rows | 6.51–6.66 | 1.53–1.73 |
| 50 historical endpoints subscribing to both events | 3.61–3.84 | 1.66–2.03 |

The last row measures the lock section, not HTTP delivery: before it inserted 100 deliveries and 100 jobs; after it inserts one durable fan-out job carrying IDs for the bounded subscription set. New configurations cannot exceed 32 active endpoints. The post-change store timing includes acquisition of its database lane. The original store CTE was timed without the preceding lock statement. No production throughput or industry ranking follows from these plans.

**60-second burst, admission only.** Four connections, one new envelope every 6 ms to one existing address in the 100k-domain database. Audit: 9,997 by 60 s, all 10,000 by 60.016 s, p50/p95/p99 15.4/19.8/24.5 ms. Fixed: **10,000 by 59.997 s**, p50/p95/p99 **1.52/3.13/3.65 ms**. The synthetic workspace backlog ceiling was raised to 200k so the existing 100k benchmark jobs did not intentionally reject the run. All 10,000 committed receipt/job pairs; none of these were parsed or delivered by the burst test.

## One message: database and object budget

Actual `acceptInboundNotification` → `processJobs` → S3/MIME → message store → webhook deliveries/jobs. One workspace, one existing address, one 64-byte attachment, one endpoint on both `stored` and `received`. The second message is a reply and joins the first thread. A mocked S3 client supplied the same bytes to each implementation. Driver query interception counts **wire statements**, including explicit BEGIN/COMMIT. Transaction counts below refer to application transactions (not the benchmark's outer rollback). Row instrumentation counts INSERT, UPDATE and DELETE through all affected tables, including trigger writes. **Tuple bytes** = sum of `pg_column_size(NEW)` on inserts/updates, zero for deletes. **Net stored bytes** subtract old row sizes. They exclude indexes, toast/table page overhead, WAL, cleanup and allocation rounding at filesystem level; they are not an AWS bill.

| New-thread stage | Statements before → after | Transactions before → after | Row writes before → after | Tuple bytes before → after |
|---|---:|---:|---:|---:|
| Notification routing, receipt, durable enqueue | 1 → 1 | 1 → 1 | 2 → 4 | 554 → 658 |
| Ingest claim (now includes the receipt, storage binding and policy) | 1 → 1 | 1 → 1 | 2 → 2 | 208 → 216 |
| Object metadata, MIME, upload journal, thread/message/attachment/link/events/store | **5 → 3** | 2 → 3 | 16 → 16 | **5,634 → 4,289** |
| Ingest job settlement | 1 → 1 | 1 → 1 | 1 → 2 | 160 → 208 |
| Deferred fan-out claim + expansion/settlement | 0 → 2 | 0 → 2 | 0 → 6 | 0 → 1,600 |
| **Total through durable webhook work** | **8 → 8** | **5 → 8** | **21 → 30** | **6,556 → 6,971** |

| Existing-thread reply stage | Statements before → after | Transactions before → after | Row writes before → after | Tuple bytes before → after |
|---|---:|---:|---:|---:|
| Admission | 1 → 1 | 1 → 1 | 2 → 4 | 554 → 658 |
| Ingest claim | 1 → 1 | 1 → 1 | 2 → 2 | 208 → 216 |
| Parse/upload/store reply | **5 → 3** | 2 → 3 | 14 → 15 | **5,741 → 4,435** |
| Ingest settlement | 1 → 1 | 1 → 1 | 1 → 2 | 160 → 208 |
| Deferred fan-out claim + expansion/settlement | 0 → 2 | 0 → 2 | 0 → 6 | 0 → 1,600 |
| **Total** | **8 → 8** | **5 → 8** | **19 → 29** | **6,663 → 7,117** |

Old fan-out was part of the store. New fan-out happens after its lock releases, batches both events, and expands in the job settlement statement. The extra counters, retry fence and transient upload journal **increase total tuple-write volume**, even though stored message size falls. Mail without hooks needs no fan-out job; mail without attachments needs no upload journal. Under normal queue claims, plain ingest is **two** statements; with any number of extracted parts, **three**. The Bcc fixture's directly invoked handler takes one additional statement because it has no queue claim. S3 GET and MIME parsing do not query Postgres; the byte debit runs after HEAD but before GET. Worker SNS ingress additionally needs one topic lookup on cache miss, zero on a warm binding; signature verification is not timed. The old Worker's singleton wake reservation cost one more SQL round trip per small live callback; the new ingress wake costs zero SQL trips. No endpoint POST, certification lookup, idle poll or continuation-scheduling query is charged to these rows.

**Net DB storage per message through fan-out:** first message **5,834 → 5,065 bytes** with cold counter/turn rows (5,009 with the hourly counter already present); reply **5,303 → 4,837 bytes**. The body/headers/addresses live on one canonical customer `mail_messages` row. Address membership has only IDs and state. Inbound summaries no longer duplicate participants, snippet or subject. Events reference message/thread/address IDs and disposition, not copied content. Durable per-endpoint delivery snapshots keep the small immutable payload, so retries have the same signed event body/ID even after event pruning. The receipt retains just enough signed facts for partial-recipient replay and unparsed fallback, not the full SNS envelope.

**S3 bytes, unchanged before/after:** first message 875 ingress + 875 private raw + 64 attachment = **1,814 bytes**; reply 952 + 952 + 64 = **1,968 bytes** during staging retention. Raw MIME must be workspace-scoped and Bcc-scrubbed. Distinct workspaces never share a downloadable object. Extracted bytes enable independent attachment downloads; MIME or attachment bytes are not copied into events or deliveries. Staging, quarantine and raw retain their original periods.

## Review map

All tests below live in `api/api.acceptance.test.ts`.

| Audit finding | Implementation entry | Acceptance evidence |
|---|---|---|
| P0: fresh account and empty set | `.github/workflows/deploy.yml:321`; `api/src/provider-connections.ts:93`; `api/src/receiving-health.ts:5` | `cold hosted receiving confirms without a workspace or a sending-ready pool` |
| Host-first known/unknown routing | `api/src/mailbox-receipts.ts:24`; `api/migrations/095_receiving_bounds.sql:5` | `MX inbound routes only MX-verified customer hosts, independently of DKIM, and splits private Bcc`; 100k plans above |
| Queue cost and fairness | `api/src/jobs.ts:188`; `api/migrations/095_receiving_bounds.sql:10`; `api/wrangler.prod.jsonc:58` | `concurrent inbound drains reserve only claimed rows and rotate past a flooded workspace`; `inbound claim leaves waiting ingest jobs unleased while sibling lanes serve other work` |
| Busy-domain lock, volume and fan-out | `api/migrations/096_mail_store_incoming.sql:7,54,82`; `api/migrations/095_receiving_bounds.sql:39`; `api/src/mailbox-ingest.ts:351`; `api/src/mailbox-events.ts:34` | `noisy workspace budgets do not suppress a neighbor and never fetch over-budget MIME`; `claimed ingest uses two DB trips with no files and three with files, including a reply`; ordered-cursor and auto-address-cap tests |
| Thread lookup | `api/migrations/096_mail_store_incoming.sql:26` | `forwarded support: query every stored inbound message and reply to the selected message as the public address`; 100k sends above |
| Identity quota | `api/src/operations.ts:77,242`; `api/src/reputation-alerts.ts:112` | `regional identity capacity is terminal and alerts the operator once` |
| Fresh ownership | `api/src/operations.ts:564,598`; `api/src/mailbox-setup.ts:350`; `api/src/mailbox-receipts.ts:29` | `receipt admission expires ownership without waiting for a verifier`; `inbound held recipients replay after MX proof and expire without transferring old mail` |
| Virus/spam barriers and historical unsafe downloads | `api/src/mailbox-ingest.ts:336`; `api/src/inbound-threads.ts:131,209`; `api/src/mailbox-send.ts:43`; `api/src/mailbox.ts:462` | `scan barriers precede MIME, including unknown verdicts and workspace spam policy` |
| Dead letters, unknown hosts and staging sweep | `infra/pulumi/index.ts:66`; `api/src/mailbox-setup.ts:195`; `api/src/mailbox-receipts.ts:53`; `api/src/mailbox-staging.ts:16,49` | cold-hosted redrive test above; `inbound staging sweep resumes, recovers only an object-bound SES trace, and quarantines ambiguity` |
| Paused webhooks, ten retries, spent leases and scoped replay | `api/src/jobs.ts:76,183`; `api/src/mailbox-events.ts:64`; `api/src/mailbox.ts:656,700` | `inbound pause parks queued delivery; resume and terminal lease retry are generation fenced` |
| Orphan storage and bounded maintenance | `api/src/mailbox-ingest.ts:388`; `api/src/mailbox-staging.ts:90`; `api/src/mailbox-events.ts:85`; `api/src/inbound-threads.ts:132` | `deduplicated uploads are reclaimed without expiring the owned attachment`; `inbound migration is repeatable and retention drains only terminal receipts and holds past 30 days` |

Limits are deliberate: 600k messages / 64 GiB per UTC hour and 50k pending/running ingest jobs per workspace by default. A rejected new receipt leaves a private terminal reason, no workspace copy or normal hook. The oversize check, MIME limits, original-owner hold fence, staged object checks, signature and topic pinning remain. Only an authorized production canary can verify the deployed end-to-end path.
