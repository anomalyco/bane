SET LOCAL lock_timeout='2s';

-- Lost-receipt recovery (recoverMailReceipts) is the durable reconcile for inbound mail: every pending receipt without a live
-- ingest job is queued again, hourly, until it is two days old. A receipt it has queued before (last_recovered_at) that was
-- first seen over an hour ago is past the normal retry sequence and gets one final attempt per job. The sweep inserts its
-- job at that attempt, but the insert is not the only way the receipt gets a job: if the old job still runs or the backlog is
-- full, mail_ingest_admit (155) turns it into a backlog hold, and the job-end drain (155) or the hold release (156) queues
-- the job later with the defaults (attempt 0), restarting the short sequence.
--
-- Every ingest job enters through mail_ingest_admit, so the rule is applied there, from the receipt's timestamps alone:
-- only the sweep writes last_recovered_at (a reopen of a processed receipt clears it), and no worker writes either column,
-- so a worker whose lease was retired cannot change it. The final attempt is five spent attempts: MAX_ATTEMPTS (6) in
-- jobs.ts, less the one the claim charges.
CREATE OR REPLACE FUNCTION mail_ingest_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid text:=NEW.workspace_id; mid text:=NEW.payload->>'sesMessageId';
BEGIN
 -- The backlog row first: a job end in progress commits (and drains) before the checks below.
 INSERT INTO mail_ingest_turns AS t(workspace_id,served_at,active) VALUES(wid,'-infinity',0) ON CONFLICT(workspace_id) DO UPDATE SET active=t.active WHERE false;
 PERFORM FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=mid AND status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=mid AND status IN ('pending','running'))
    AND (SELECT active FROM mail_ingest_turns WHERE workspace_id=wid)<(SELECT p.backlog FROM mail_receive_policy(wid) p) THEN
   UPDATE mail_ingest_turns SET active=active+1 WHERE workspace_id=wid;
   IF EXISTS(SELECT FROM mail_receipts WHERE workspace_id=wid AND ses_message_id=mid AND last_recovered_at IS NOT NULL AND created_at<now()-interval '1 hour') THEN
     NEW.attempts:=greatest(NEW.attempts,5);
   END IF;
   RETURN NEW;
 END IF;
 UPDATE mail_receipts SET status='held',error='MAILBOX_RECEIVE_BACKLOG',budget_retry_at=now() WHERE workspace_id=wid AND ses_message_id=mid AND status='pending';
 RETURN NULL;
END $$;
