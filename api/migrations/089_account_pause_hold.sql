SET LOCAL lock_timeout='1s';
-- A held envelope can outlive both its dispatcher and the retention of its attempt events.
ALTER TABLE sending_emails ADD COLUMN account_pause_started_at timestamptz;
