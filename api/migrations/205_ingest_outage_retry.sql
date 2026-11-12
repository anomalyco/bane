SET LOCAL lock_timeout='2s';

-- An inbound receipt whose ingest lost its final attempt to an outage keeps one final attempt an hour, while it is younger than
-- the 48-hour outage window (lost-receipt recovery and the ingest job's deferral record when on the receipt). The job that
-- carries that retry is not the only way the receipt gets a job back: if the old job still runs, or the backlog is full,
-- mail_ingest_admit (155) turns the insert into a backlog hold, and the job-end drain (155) or the hold release (156) queues the
-- job later with the defaults, attempt 0 and due now: the short retry sequence started over.
--
-- Every ingest job enters through mail_ingest_admit, so it applies the recorded retry there. An admitted job never starts
-- below the final attempt or before the retry time, and a pending job the insert joins is raised to them. Nothing lowers
-- either. The final attempt is five spent attempts: MAX_ATTEMPTS (6) in jobs.ts, less the one the claim charges.
ALTER TABLE mail_receipts ADD COLUMN IF NOT EXISTS ingest_retry_at timestamptz;

CREATE OR REPLACE FUNCTION mail_ingest_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid text:=NEW.workspace_id; mid text:=NEW.payload->>'sesMessageId'; retry timestamptz; joined text;
BEGIN
 -- The backlog row first: a job end in progress commits (and drains) before the checks below.
 INSERT INTO mail_ingest_turns AS t(workspace_id,served_at,active) VALUES(wid,'-infinity',0) ON CONFLICT(workspace_id) DO UPDATE SET active=t.active WHERE false;
 SELECT ingest_retry_at INTO retry FROM mail_receipts WHERE workspace_id=wid AND ses_message_id=mid;
 SELECT id INTO joined FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=mid AND status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF joined IS NOT NULL THEN
   IF retry IS NOT NULL THEN UPDATE jobs SET attempts=greatest(attempts,5),available_at=greatest(available_at,retry) WHERE id=joined; END IF;
   RETURN NULL;
 END IF;
 IF NOT EXISTS(SELECT FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=mid AND status IN ('pending','running'))
    AND (SELECT active FROM mail_ingest_turns WHERE workspace_id=wid)<(SELECT p.backlog FROM mail_receive_policy(wid) p) THEN
   UPDATE mail_ingest_turns SET active=active+1 WHERE workspace_id=wid;
   IF retry IS NOT NULL THEN NEW.attempts:=greatest(NEW.attempts,5); NEW.available_at:=greatest(NEW.available_at,retry); END IF;
   RETURN NEW;
 END IF;
 UPDATE mail_receipts SET status='held',error='MAILBOX_RECEIVE_BACKLOG',budget_retry_at=now() WHERE workspace_id=wid AND ses_message_id=mid AND status='pending';
 RETURN NULL;
END $$;
