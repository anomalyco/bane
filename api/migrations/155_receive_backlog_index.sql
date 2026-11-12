-- bane:no-transaction
-- The job-end drain (155_receive_reopen_backlog) reads one workspace's backlog holds in queue order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_receive_backlog_held ON mail_receipts(workspace_id,budget_retry_at,ses_message_id) WHERE status='held' AND error='MAILBOX_RECEIVE_BACKLOG';
