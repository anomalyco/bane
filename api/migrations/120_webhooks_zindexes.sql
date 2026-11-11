-- bane:no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_key ON mailboxes(workspace_id,key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_webhooks_key ON mailbox_webhooks(workspace_id,key) WHERE key IS NOT NULL;
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_hook_once_per_routed_message ON mailbox_webhook_deliveries(workspace_id,webhook_id,(payload->>'messageId')) WHERE routed;
