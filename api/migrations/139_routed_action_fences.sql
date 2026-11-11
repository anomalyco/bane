-- bane:no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_hook_route_only_message ON mailbox_webhook_deliveries(workspace_id,webhook_id,(payload->>'messageId')) WHERE routed AND NOT (payload ? 'ritualAction');
DROP INDEX CONCURRENTLY IF EXISTS mailbox_hook_once_per_routed_message;
