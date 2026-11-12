SET LOCAL lock_timeout='2s';

-- Every ingest job enters through one check, a trigger on the job insert, so every producer and
-- every Worker version is covered: the SNS route (first receipts, reopens, held-envelope replays),
-- the hold release (156), the job-end drain below, lost-receipt recovery, and the previous Worker's
-- copies of each.
--
-- Before, each producer checked the backlog on its own, or not at all. A reopen queued another job
-- each time (one message notified with 1, 2, 3, 100, 101 and 200 recipients left six active jobs
-- under a backlog of 1). Lost-receipt recovery never checked it. A reopen released while the
-- receipt's previous job still ran gave the receipt two jobs, and the older one's final failure,
-- which only checks that the receipt is pending, then failed the newer recipients.
--
-- mail_ingest_admit decides each insert of an ingest job under the workspace's backlog row:
-- - The receipt has a pending job: that job reads the receipt's recipients when it is claimed, so
--   this insert is dropped. The pending job stays locked until this commits; runners skip locked
--   jobs.
-- - The receipt has a running job, or a claim of its pending job is in progress: that claim may lack
--   the new recipients. The receipt is held (MAILBOX_RECEIVE_BACKLOG) until the job ends. A stale
--   settlement or failure only touches a pending receipt, so it cannot retire the held one.
-- - Otherwise the job needs backlog room. Without it the receipt is held the same way.
-- An admitted insert counts itself in mail_ingest_turns.active at once, so later rows of the same
-- statement see it (the AFTER INSERT count of 095 is dropped).
--
-- When a job stops being active, the workspace's backlog holds are admitted in queue order, without
-- waiting on any row (mail_receive_drain). The hold release (156) catches any it skips. Producers
-- lock the receipt row before inserting its job, and the job end and the insert both take the
-- backlog row, so each check sees the other's commit.
--
-- The hourly window is charged once, when a message is first admitted (mail_receive_slot, now
-- without the backlog check): a backlog hold is already charged and needs only backlog room.
CREATE OR REPLACE FUNCTION mail_receive_slot(wid text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE h timestamptz:=date_trunc('hour',now()); maximum int;
BEGIN
 INSERT INTO mail_receive_windows AS w VALUES(wid,h,0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=w.messages WHERE false;
 SELECT p.messages INTO maximum FROM mail_receive_policy(wid) p;
 IF maximum<=0 THEN RETURN false; END IF;
 INSERT INTO mail_receive_windows AS w VALUES(wid,h,1,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=CASE WHEN w.window_at=h THEN w.messages+1 ELSE 1 END,bytes=CASE WHEN w.window_at=h THEN w.bytes ELSE 0 END,window_at=h WHERE w.window_at<>h OR w.messages<maximum;
 RETURN FOUND;
END $$;

CREATE FUNCTION mail_ingest_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid text:=NEW.workspace_id; mid text:=NEW.payload->>'sesMessageId';
BEGIN
 -- The backlog row first: a job end in progress commits (and drains) before the checks below.
 INSERT INTO mail_ingest_turns AS t(workspace_id,served_at,active) VALUES(wid,'-infinity',0) ON CONFLICT(workspace_id) DO UPDATE SET active=t.active WHERE false;
 PERFORM FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=mid AND status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=mid AND status IN ('pending','running'))
    AND (SELECT active FROM mail_ingest_turns WHERE workspace_id=wid)<(SELECT p.backlog FROM mail_receive_policy(wid) p) THEN
   UPDATE mail_ingest_turns SET active=active+1 WHERE workspace_id=wid;
   RETURN NEW;
 END IF;
 UPDATE mail_receipts SET status='held',error='MAILBOX_RECEIVE_BACKLOG',budget_retry_at=now() WHERE workspace_id=wid AND ses_message_id=mid AND status='pending';
 RETURN NULL;
END $$;
CREATE TRIGGER mail_ingest_admit BEFORE INSERT ON jobs FOR EACH ROW WHEN (NEW.type='mailbox.ingest' AND NEW.status IN ('pending','running'))
  EXECUTE FUNCTION mail_ingest_admit();

-- Admits a workspace's backlog holds in order (held first, first), never waiting on a receipt or a
-- job. A receipt whose job still runs is admitted when that job ends; one whose pending job a
-- claim is taking waits for the claimed job to end the same way.
CREATE FUNCTION mail_receive_drain(wid text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; backlog int:=(SELECT p.backlog FROM mail_receive_policy(wid) p);
BEGIN
 FOR r IN SELECT ses_message_id AS mid FROM mail_receipts WHERE workspace_id=wid AND status='held' AND error='MAILBOX_RECEIVE_BACKLOG'
   ORDER BY budget_retry_at,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
   CONTINUE WHEN EXISTS(SELECT FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='running');
   PERFORM FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN
     CONTINUE WHEN EXISTS(SELECT FROM jobs WHERE workspace_id=wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='pending');
     EXIT WHEN (SELECT active FROM mail_ingest_turns WHERE workspace_id=wid)>=backlog;
   END IF;
   UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE workspace_id=wid AND ses_message_id=r.mid;
   INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',wid,jsonb_build_object('sesMessageId',r.mid));
 END LOOP;
END $$;

-- Inserts are counted by mail_ingest_admit; a job leaving the active set drains its workspace.
CREATE OR REPLACE FUNCTION mail_ingest_head_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE removed boolean:=TG_OP<>'INSERT' AND OLD.type='mailbox.ingest' AND OLD.status IN ('pending','running');
        added boolean:=TG_OP='UPDATE' AND NEW.type='mailbox.ingest' AND NEW.status IN ('pending','running');
BEGIN
 IF added AND removed AND NEW.workspace_id=OLD.workspace_id THEN RETURN NULL; END IF;
 IF removed THEN
   UPDATE mail_ingest_turns SET active=active-1 WHERE workspace_id=OLD.workspace_id;
   PERFORM mail_receive_drain(OLD.workspace_id);
 END IF;
 IF added THEN INSERT INTO mail_ingest_turns(workspace_id,served_at,active) VALUES(NEW.workspace_id,'-infinity',1) ON CONFLICT(workspace_id) DO UPDATE SET active=mail_ingest_turns.active+1; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER mail_ingest_head_insert ON jobs;
