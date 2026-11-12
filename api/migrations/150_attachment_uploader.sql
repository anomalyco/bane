SET LOCAL lock_timeout='2s';
-- Without an uploader or a visible delivery link, old workspace assets confer no sender-domain access.
ALTER TABLE sending_attachments ADD COLUMN IF NOT EXISTS uploaded_by text;
