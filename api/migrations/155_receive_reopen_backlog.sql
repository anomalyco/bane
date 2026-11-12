SET LOCAL lock_timeout='2s';

-- Every ingest-job producer respects the backlog, enforced here so that every Worker version
-- running the route statement is covered.
--
-- A reopen (a known receipt gaining recipients) used to set the receipt back to pending and queue
-- another ingest job each time, with no backlog check and no coalescing: one message notified with
-- 1, 2, 3, 100, 101 and 200 recipients left six active jobs under a backlog of 1. Now a reopen:
-- - joins the receipt's pending ingest job when there is one. That job reads the merged recipients
--   when it is claimed; its row stays locked until this commits, and runners skip locked jobs.
-- - otherwise needs backlog room, read under the workspace's window row like every other producer.
-- - otherwise is held (MAILBOX_RECEIVE_BACKLOG) with its recipients merged. A running job's claim
--   is then stale and settles nothing. The hold is released later without charging the hourly
--   window again, because the message was charged when it was first admitted.
CREATE FUNCTION mail_receive_backlog_room(wid text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE backlog int;
BEGIN
 INSERT INTO mail_receive_windows AS w VALUES(wid,date_trunc('hour',now()),0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=w.messages WHERE false;
 SELECT p.backlog INTO backlog FROM mail_receive_policy(wid) p;
 RETURN coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=wid),0)<backlog;
END $$;

CREATE FUNCTION mail_receive_reopen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM FROM jobs WHERE workspace_id=NEW.workspace_id AND type='mailbox.ingest' AND payload->>'sesMessageId'=NEW.ses_message_id AND status='pending' LIMIT 1 FOR UPDATE;
 IF FOUND THEN RETURN NEW; END IF;
 IF NOT mail_receive_backlog_room(NEW.workspace_id) THEN
   NEW.status:='held';NEW.error:='MAILBOX_RECEIVE_BACKLOG';NEW.budget_retry_at:=date_trunc('hour',now())+interval '1 hour';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mail_receive_reopen BEFORE UPDATE OF recipients ON mail_receipts FOR EACH ROW
  WHEN (NEW.status='pending' AND OLD.status IN ('pending','processed') AND NEW.recipients IS DISTINCT FROM OLD.recipients)
  EXECUTE FUNCTION mail_receive_reopen();

-- At most one pending ingest job per receipt, whoever queues it: a second one would only re-read
-- the same receipt. Producers lock the receipt row first, so this check sees the other's commit.
CREATE FUNCTION mail_ingest_coalesce() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT FROM jobs WHERE workspace_id=NEW.workspace_id AND type='mailbox.ingest' AND payload->>'sesMessageId'=NEW.payload->>'sesMessageId' AND status='pending') THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mail_ingest_coalesce BEFORE INSERT ON jobs FOR EACH ROW WHEN (NEW.type='mailbox.ingest' AND NEW.status='pending')
  EXECUTE FUNCTION mail_ingest_coalesce();

-- A backlog hold was charged when its message was first admitted: release it on backlog room alone.
CREATE OR REPLACE FUNCTION release_receive_budget_holds(owner_filter text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; scanned int:=0; admit boolean;
BEGIN
 FOR r IN SELECT workspace_id,ses_message_id,created_at,error FROM mail_receipts WHERE status='held' AND budget_retry_at<=now()
   AND (owner_filter IS NULL OR workspace_id=owner_filter) ORDER BY budget_retry_at,workspace_id,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
   scanned:=scanned+1;
   IF r.created_at<now()-interval '3 days' THEN
     UPDATE mail_receipts SET status='failed',error='MAILBOX_BUDGET_HOLD_EXPIRED',processed_at=now(),budget_retry_at=NULL WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
     CONTINUE;
   END IF;
   admit:=CASE WHEN r.error='MAILBOX_RECEIVE_BACKLOG' THEN mail_receive_backlog_room(r.workspace_id) ELSE mail_receive_slot(r.workspace_id) END;
   IF admit THEN
     UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
     INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',r.workspace_id,jsonb_build_object('sesMessageId',r.ses_message_id));
   ELSE
     UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
   END IF;
 END LOOP;
 RETURN scanned;
END $$;
