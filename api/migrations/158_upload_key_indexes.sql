-- bane:no-transaction
-- storage_key_in_use (158_upload_tombstones) looks up every row that may reference a stored object by its exact key.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_attachments_storage_key ON sending_attachments(storage_key);
CREATE INDEX CONCURRENTLY IF NOT EXISTS template_assets_storage_key ON template_assets(storage_key);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_messages_local_raw_key ON mail_messages(raw_key) WHERE raw_bucket='local:';
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_attachments_local_key ON mail_attachments(storage_key) WHERE bucket='local:';
