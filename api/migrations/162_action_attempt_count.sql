SET LOCAL lock_timeout='2s';
-- Attempts that passed the action fence, including ones whose outcome was never recorded (a runner
-- lost mid-request, a stale lease). A resumed delivery keeps at least this many attempts spent.
ALTER TABLE mail_action_attempts ADD COLUMN attempts integer NOT NULL DEFAULT 1;
