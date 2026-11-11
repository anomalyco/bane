-- bane:no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_webhook_action_event ON mailbox_webhook_deliveries(webhook_id,event_seq,coalesce(payload->>'ritualAction',''));
