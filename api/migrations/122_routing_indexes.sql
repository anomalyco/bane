-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_webhook_subscribed ON mailbox_webhooks(workspace_id,id) WHERE NOT paused AND event_types<>'[]';
