-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_messages_modseq ON mailbox_messages(mailbox_id,modseq) WHERE modseq IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_managed_cap ON mailboxes(workspace_id) WHERE kind='inbox';
