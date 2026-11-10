-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_ready_page ON jobs(job_class(type),(CASE WHEN status='running' THEN lease_until ELSE available_at END),id) WHERE status IN ('pending','running');
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_expired_page ON jobs(lease_until,id) WHERE status='running';
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_interrupted_page ON sending_emails(attempt_started_at,id) WHERE status='attempting';
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_thread_send_guard ON mail_messages(sender_mailbox_id,thread_id,created_at) WHERE direction='outbound';
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_attachment_repair ON sending_emails(updated_at,id) WHERE status='rejected' AND error_code='ATTACHMENT_STORAGE_UNAVAILABLE';
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_upload_expiry ON sending_upload_reservations(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_outbound_sync_ready ON mail_outbound_sync(due,id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_hook_owner_due ON jobs(workspace_id,(CASE WHEN status='running' THEN lease_until ELSE available_at END),id) WHERE job_class(type)='hook' AND status IN ('pending','running');
