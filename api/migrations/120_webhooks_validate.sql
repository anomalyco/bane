SET LOCAL lock_timeout='2s';
ALTER TABLE mailbox_webhooks VALIDATE CONSTRAINT mailbox_webhook_format_valid,
 VALIDATE CONSTRAINT mailbox_webhook_junk_valid,
 VALIDATE CONSTRAINT mailbox_webhook_timeout_seconds_valid,
 VALIDATE CONSTRAINT mailbox_webhook_retry_attempts_valid;
