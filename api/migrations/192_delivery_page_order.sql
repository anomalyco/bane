-- bane:no-transaction
-- Webhook delivery pages are newest first by creation time; delivery IDs are random, so the ID-ordered pages
-- showed an arbitrary sample instead of the latest deliveries. Email events read per email and need no new index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS operation_delivery_created_page ON operation_deliveries(workspace_id,webhook_id,created_at,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_webhook_deliveries_created_page ON mailbox_webhook_deliveries(webhook_id,created_at,id);
