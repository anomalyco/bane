SET LOCAL lock_timeout='1s';
ALTER TABLE mail_receipts ADD COLUMN IF NOT EXISTS recovery_attempts smallint NOT NULL DEFAULT 0;
ALTER TABLE mail_receipts ADD COLUMN IF NOT EXISTS last_recovered_at timestamptz;
CREATE INDEX IF NOT EXISTS mail_receipts_recovery ON mail_receipts (coalesce(last_recovered_at,created_at),workspace_id,ses_message_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS mail_receipts_staging ON mail_receipts(bucket,ses_message_id);
CREATE INDEX IF NOT EXISTS jobs_mail_receipt ON jobs(workspace_id,(payload->>'sesMessageId')) WHERE type='mailbox.ingest';
CREATE INDEX IF NOT EXISTS jobs_ingest_due ON jobs(workspace_id,available_at,id) WHERE type='mailbox.ingest' AND status IN ('pending','running');
CREATE INDEX IF NOT EXISTS mailboxes_auto_budget ON mailboxes(workspace_id,domain_id,created_at) WHERE origin='auto';
CREATE INDEX IF NOT EXISTS mailboxes_routing_rules ON mailboxes(workspace_id,domain_id,created_at,id) WHERE expires_at IS NULL AND rules<>'[]'::jsonb;

-- Installation-private until the envelope host passes the usual timestamped ownership checks.
CREATE TABLE IF NOT EXISTS mail_receipt_holds (
  bucket text NOT NULL, ses_message_id text NOT NULL, region text NOT NULL, topic_arn text NOT NULL,
  binding_workspace text, owners jsonb NOT NULL, recipients jsonb NOT NULL, notification jsonb NOT NULL,
  received_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  next_check timestamptz NOT NULL DEFAULT now(), status text NOT NULL DEFAULT 'held', error text,
  PRIMARY KEY(bucket,ses_message_id)
);
CREATE INDEX IF NOT EXISTS mail_receipt_holds_due ON mail_receipt_holds(next_check,bucket,ses_message_id) WHERE status='held';
CREATE INDEX IF NOT EXISTS mail_receipt_holds_expired ON mail_receipt_holds(expires_at) WHERE status<>'held';
CREATE INDEX IF NOT EXISTS mail_receipts_expired ON mail_receipts(coalesce(processed_at,created_at)) WHERE status IN ('processed','failed');
CREATE TABLE IF NOT EXISTS mail_ingest_turns (workspace_id text PRIMARY KEY, served_at timestamptz NOT NULL);
