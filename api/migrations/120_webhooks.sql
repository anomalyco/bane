SET LOCAL lock_timeout='2s';
ALTER TABLE mailbox_webhooks ADD key text, ADD name text,
 ADD format text NOT NULL DEFAULT 'bane',
 ADD junk text NOT NULL DEFAULT 'skip',
 ADD include jsonb NOT NULL DEFAULT '[]', ADD timeout_seconds smallint NOT NULL DEFAULT 5,
 ADD retry_attempts smallint NOT NULL DEFAULT 9; -- 9 retries keeps today's 10 attempts.
ALTER TABLE mailbox_webhooks ADD CONSTRAINT mailbox_webhook_format_valid CHECK(format IN ('bane','inbound')) NOT VALID,
 ADD CONSTRAINT mailbox_webhook_junk_valid CHECK(junk IN ('skip','include')) NOT VALID,
 ADD CONSTRAINT mailbox_webhook_timeout_seconds_valid CHECK(timeout_seconds BETWEEN 1 AND 30) NOT VALID,
 ADD CONSTRAINT mailbox_webhook_retry_attempts_valid CHECK(retry_attempts BETWEEN 0 AND 10) NOT VALID;
