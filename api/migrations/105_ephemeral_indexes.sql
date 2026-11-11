-- bane:no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_client_id ON mailboxes(workspace_id,client_id) WHERE client_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_delete_due ON mailboxes(delete_after) WHERE delete_after IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_ephemeral_active ON mailboxes(workspace_id,created_at) WHERE retention_mode='ephemeral';
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_created_by ON mailboxes(created_by) WHERE created_by IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_retired_prune ON mail_retired_addresses(until);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_messages_cursor ON mailbox_messages(mailbox_id,inbox_seq) WHERE inbox_seq IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_message_ids_message ON mail_message_ids(mail_message_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_threads_thread ON mailbox_threads(thread_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_messages_delivered_cursor ON mailbox_messages(mailbox_id,inbox_seq) WHERE inbox_seq IS NOT NULL AND held_reason IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_gc_candidates_message ON mail_gc_candidates(message_id);
