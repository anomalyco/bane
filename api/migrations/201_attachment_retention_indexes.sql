-- bane:no-transaction
-- Retention now deletes unused attachments in batches. Each deleted attachment checks the foreign keys from
-- mail_attachments and sending_attachment_links, and the template-asset pass looks for attachments made from an asset;
-- without these indexes every check scanned the whole table (66 ms per attachment at 1M mail attachments).
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_attachments_source ON mail_attachments(source_attachment_id) WHERE source_attachment_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_attachment_links_attachment ON sending_attachment_links(attachment_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_attachments_template_source ON sending_attachments(workspace_id,source_template_asset_id) WHERE source_template_asset_id IS NOT NULL;
