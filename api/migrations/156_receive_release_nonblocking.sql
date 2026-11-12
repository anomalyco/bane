SET LOCAL lock_timeout='2s';

-- The global release (release_receive_budget_holds(NULL)) visited holds by retry time across
-- workspaces. It kept each workspace's window row locked until it committed, and waited on the next
-- one. A multi-workspace SNS admission takes those rows in its own order, so the two could deadlock:
-- the release held B's window and waited on A's, while the admission held A's and waited on B's.
--
-- The release now never waits. It takes each due hold's workspace window row and backlog row with
-- SKIP LOCKED. A hold whose rows are busy moves ten seconds back and counts as scanned, so a full
-- pass schedules its continuation and the next pass reaches the holds behind it: retrying the busy
-- ones first on every pass, uncounted, starved every later hold until its three-day expiry.
--
-- A budget hold takes a slot of the hourly window, then an ingest job through mail_ingest_admit
-- (155), which can hold it again for the backlog: then it waits for the next hour. A backlog hold
-- was charged when its message was first admitted and needs only an ingest job: it joins the
-- receipt's pending job, waits behind its running job, or takes backlog room. The job-end drain
-- (155) admits backlog holds as soon as room frees; this pass is the backstop.
--
-- Every workspace with a hold gets a window row: holds are created since 153 with one, older ones
-- may lack it, and SKIP LOCKED cannot lock a missing row.
INSERT INTO mail_receive_windows(workspace_id,window_at,messages,bytes)
  SELECT DISTINCT workspace_id,date_trunc('hour',now()),0,0::bigint FROM mail_receipts WHERE status='held' ON CONFLICT(workspace_id) DO NOTHING;

CREATE OR REPLACE FUNCTION release_receive_budget_holds(owner_filter text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; scanned int:=0; free boolean; coalesced boolean;
BEGIN
 FOR r IN SELECT workspace_id AS wid,ses_message_id AS mid,created_at,error FROM mail_receipts WHERE status='held' AND budget_retry_at<=now()
   AND (owner_filter IS NULL OR workspace_id=owner_filter) ORDER BY budget_retry_at,workspace_id,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
   scanned:=scanned+1;
   IF r.created_at<now()-interval '3 days' THEN
     UPDATE mail_receipts SET status='failed',error='MAILBOX_BUDGET_HOLD_EXPIRED',processed_at=now(),budget_retry_at=NULL WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     CONTINUE;
   END IF;
   PERFORM FROM mail_receive_windows WHERE workspace_id=r.wid FOR UPDATE SKIP LOCKED;
   free:=FOUND;
   IF free AND EXISTS(SELECT FROM mail_ingest_turns WHERE workspace_id=r.wid) THEN
     PERFORM FROM mail_ingest_turns WHERE workspace_id=r.wid FOR UPDATE SKIP LOCKED;
     free:=FOUND;
   END IF;
   IF NOT free THEN
     UPDATE mail_receipts SET budget_retry_at=now()+interval '10 seconds' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     CONTINUE;
   END IF;
   IF r.error='MAILBOX_RECEIVE_BACKLOG' THEN
     IF EXISTS(SELECT FROM jobs WHERE workspace_id=r.wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='running') THEN
       UPDATE mail_receipts SET budget_retry_at=now()+interval '10 seconds' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       CONTINUE;
     END IF;
     PERFORM FROM jobs WHERE workspace_id=r.wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
     coalesced:=FOUND;
     IF NOT coalesced AND EXISTS(SELECT FROM jobs WHERE workspace_id=r.wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='pending') THEN
       UPDATE mail_receipts SET budget_retry_at=now()+interval '10 seconds' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       CONTINUE;
     END IF;
     IF coalesced OR coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=r.wid),0)<(SELECT p.backlog FROM mail_receive_policy(r.wid) p) THEN
       UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',r.wid,jsonb_build_object('sesMessageId',r.mid));
     ELSE
       UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     END IF;
     CONTINUE;
   END IF;
   IF mail_receive_slot(r.wid) THEN
     UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',r.wid,jsonb_build_object('sesMessageId',r.mid));
     -- Held again for the backlog: the drain or the next hour's pass admits it.
     UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE workspace_id=r.wid AND ses_message_id=r.mid AND status='held';
   ELSE
     UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
   END IF;
 END LOOP;
 RETURN scanned;
END $$;
