-- bane:no-transaction
-- 134 removes the original index by name. Preserve its conflict target through Worker rollout.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_hook_legacy_event ON mailbox_webhook_deliveries(webhook_id,event_seq);
