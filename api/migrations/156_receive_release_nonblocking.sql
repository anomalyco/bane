SET LOCAL lock_timeout='2s';

-- The global release (release_receive_budget_holds(NULL)) visited holds by retry time across
-- workspaces. It kept each workspace's window row locked until it committed, and waited on the next
-- one. A multi-workspace SNS admission takes those rows in its own order, so the two could deadlock:
-- the release held B's window and waited on A's, while the admission held A's and waited on B's.
-- The release now never waits. It takes each due hold's workspace window row and backlog counter row
-- with SKIP LOCKED, and leaves a hold whose rows are busy for its next pass: that hold is not counted,
-- so the pass does not reschedule itself for it. Holds are still claimed FOR UPDATE SKIP LOCKED.
-- Admissions take window rows in workspace order (the route sorts its receipts) and backlog rows
-- in workspace order (it sorts its jobs).
--
-- Every workspace with a hold gets a window row: holds are created since 153 with one, older ones
-- may lack it, and SKIP LOCKED cannot lock a missing row.
INSERT INTO mail_receive_windows(workspace_id,window_at,messages,bytes)
  SELECT DISTINCT workspace_id,date_trunc('hour',now()),0,0::bigint FROM mail_receipts WHERE status='held' ON CONFLICT(workspace_id) DO NOTHING;

CREATE OR REPLACE FUNCTION release_receive_budget_holds(owner_filter text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; scanned int:=0; admit boolean;
BEGIN
 FOR r IN SELECT workspace_id,ses_message_id,created_at,error FROM mail_receipts WHERE status='held' AND budget_retry_at<=now()
   AND (owner_filter IS NULL OR workspace_id=owner_filter) ORDER BY budget_retry_at,workspace_id,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
   IF r.created_at<now()-interval '3 days' THEN
     scanned:=scanned+1;
     UPDATE mail_receipts SET status='failed',error='MAILBOX_BUDGET_HOLD_EXPIRED',processed_at=now(),budget_retry_at=NULL WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
     CONTINUE;
   END IF;
   PERFORM FROM mail_receive_windows WHERE workspace_id=r.workspace_id FOR UPDATE SKIP LOCKED;
   IF NOT FOUND THEN CONTINUE; END IF;
   IF EXISTS(SELECT FROM mail_ingest_turns WHERE workspace_id=r.workspace_id) THEN
     PERFORM FROM mail_ingest_turns WHERE workspace_id=r.workspace_id FOR UPDATE SKIP LOCKED;
     IF NOT FOUND THEN CONTINUE; END IF;
   END IF;
   scanned:=scanned+1;
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
