# Real-store integration: proposed contract at `29f3010`

**Status: design, not deployed or verified.** The current gateway still runs only with the memory adapter. Do not scale the service with that binary.

## Product decisions at the integration boundary

1. **What may an SMTP password send?** `api/migrations/145_persistent_inboxes.sql` returns `send.replyOnly: true` for persistent as well as temporary inboxes. `sendFromMailbox` (`api/src/mailbox-send.ts`) enforces that for every `kind='inbox'`: it requires an existing thread, sending enabled, and recipients who were authenticated authors in that thread. The existing gateway suite submits *new* mail. A signed gateway route must not silently bypass these restrictions, and `In-Reply-To` is not proof that a recipient is authorized. Recommendation: add an explicit, workspace-manager-granted **submission** permission for persistent inboxes on verified sending domains. Keep existing inbox keys and temporary inboxes reply-only and sandbox sends disabled. Enforce daily/monthly caps, sender score, screening, domain verification, balance and Sent filing inside the API transaction, not in the listener. The mailbox currently persists `perDay` but has no per-inbox monthly-cap field; add an explicit monthly limit rather than borrowing a workspace-wide value.
2. **Where do client-created folders live?** Migration 141 restricts the `role` primary key to `inbox`, `sent`, `junk`, `archive`, `trash`. There is no Drafts role, custom path, independent folder ID or subscription state. The first-slice differential and imaptest runs create, rename, subscribe to and delete folders, then verify UIDVALIDITY after path reuse. Recommendation: extend the shared phase-2 folder model with stable folder IDs, optional special-use roles and subscriptions. Preserve the existing role-addressed API and existing UIDVALIDITY values. Do not add a second gateway-only namespace or report those tests as real-store passes against a fake.

## Data path and proposed database budgets

Use **signed internal Bane API routes** for metadata, bodies and mutations; use a dedicated, minimally privileged PostgreSQL connection only for `LISTEN bane_inbox_changed`. Compared with direct SQL for metadata this adds an HTTP hop but need not add a SQL round trip. The task already has `MAILGW_API_TOKEN` and `DATABASE_URL`, not an R2 key. The Worker already owns R2 and the rules for workspace, inbox membership and held content. Never grant the gateway general table reads or accept raw bucket/key coordinates from clients.

Targets below are PostgreSQL statements executed on behalf of a protocol operation, including those inside the API, **not measurements**. No remote DB operations should run under the current synchronous `Memory` mutex.

| Operation | Target SQL statements | Conditions |
|---|---:|---|
| LOGIN | 1 cold; 0 valid cache hit | Indexed credential hash lookup joins protocol, inbox eligibility, workspace and owned addresses. Bind cached decisions to the actual login and protocol. Never accept an expired credential just because its cache entry is warm. |
| SELECT | 1 | Single snapshot of folder counters, UIDVALIDITY, UID sequence and MODSEQ. No MIME bodies. |
| FETCH | 0 warm; 1 per cold UID batch | Batch authorization and metadata. For requested bodies return short-lived, read-only handles from that authorized result; body service verifies the handle without another SQL query and reads immutable bytes/ranges from R2. Non-PEEK reads that set `Seen` must include an authoritative flag mutation: one additional batched write unless fused with the metadata query. |
| IDLE wake | 0 if no selected folder for that inbox; 1 per distinct interested folder/checkpoint | Coalesce identical requests across sessions. NOTIFY is only a hint. Diff by committed MODSEQ/vanished UIDs, reconcile on listener reconnect, and force resync if the checkpoint predates `changes_floor`. |

Migration 147 emits mail-change hints only if the **new** password count is nonzero. Revoking the last password therefore needs its own commit-time auth invalidation; relying on the existing trigger leaves open sessions unaware. Revalidate live principals after listener loss and before content writes. Meter an inbox/day once, even if its last password is revoked and another is issued that day; the instantaneous `protocol_passwords` count by itself is not a historical billing ledger.
