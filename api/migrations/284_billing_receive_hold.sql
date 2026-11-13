SET LOCAL lock_timeout='2s';
-- Receipts parked by billing (status 'held', error 'BILLING_HOLD', raw object under held/) go back to ingest after a
-- credit (billing.restored). Billing holds keep budget_retry_at NULL, so release_receive_budget_holds (and its 3-day
-- expiry) never sees them, and nothing is deleted. The mail_ingest_admit trigger applies backlog limits as usual.
CREATE FUNCTION billing_release_receive_holds(wid text, lim int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  WITH held AS (SELECT ses_message_id FROM mail_receipts WHERE workspace_id=wid AND status='held' AND error='BILLING_HOLD'
                ORDER BY created_at LIMIT lim FOR UPDATE SKIP LOCKED),
  released AS (UPDATE mail_receipts r SET status='pending',error=NULL,budget_retry_at=NULL FROM held h
               WHERE r.workspace_id=wid AND r.ses_message_id=h.ses_message_id RETURNING r.ses_message_id),
  queued AS (INSERT INTO jobs(id,type,workspace_id,payload)
             SELECT 'job_'||gen_random_uuid(),'mailbox.ingest',wid,jsonb_build_object('sesMessageId',ses_message_id) FROM released RETURNING 1)
  SELECT count(*)::int INTO n FROM queued;
  RETURN n;
END $$;
