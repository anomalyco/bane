SET LOCAL lock_timeout='2s';
ALTER TABLE mail_receive_limits ALTER message_limit SET DEFAULT 5000, ALTER byte_limit SET DEFAULT 2147483648, ALTER backlog_limit SET DEFAULT 5000;
-- Preserve custom operator limits while bringing old defaults into line.
UPDATE mail_receive_limits SET message_limit=5000 WHERE message_limit=600000;
UPDATE mail_receive_limits SET byte_limit=2147483648 WHERE byte_limit=68719476736;
UPDATE mail_receive_limits SET backlog_limit=5000 WHERE backlog_limit=50000;
CREATE FUNCTION mail_receive_policy(wid text) RETURNS TABLE(messages int,bytes bigint,backlog int) LANGUAGE sql STABLE AS $$
 SELECT coalesce(l.message_limit,5000),coalesce(l.byte_limit,2147483648),coalesce(l.backlog_limit,5000)
 FROM (SELECT wid AS workspace_id) w LEFT JOIN mail_receive_limits l USING(workspace_id)
$$;
ALTER TABLE mail_receipts ADD COLUMN budget_retry_at timestamptz;
CREATE FUNCTION mail_receive_slot(wid text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE h timestamptz:=date_trunc('hour',now()); maximum int; backlog int;
BEGIN
 SELECT p.messages,p.backlog INTO maximum,backlog FROM mail_receive_policy(wid) p;
 IF maximum<=0 OR coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=wid),0)>=backlog THEN RETURN false; END IF;
 INSERT INTO mail_receive_windows AS w VALUES(wid,h,1,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=CASE WHEN w.window_at=h THEN w.messages+1 ELSE 1 END,bytes=CASE WHEN w.window_at=h THEN w.bytes ELSE 0 END,window_at=h WHERE w.window_at<>h OR w.messages<maximum;
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION mail_receive_admit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'pending' OR EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN RETURN NEW; END IF;
 IF jsonb_array_length(NEW.recipients)>100 THEN
   NEW.status:='failed';NEW.processed_at:=now();NEW.error:='MAILBOX_RECEIVE_BUDGET';
 ELSIF NOT mail_receive_slot(NEW.workspace_id) THEN
   NEW.status:='held';NEW.error:='MAILBOX_RECEIVE_BUDGET';NEW.budget_retry_at:=date_trunc('hour',now())+interval '1 hour';
 END IF;
 RETURN NEW;
END $$;
-- Keep the original, workspace-bound receipt; do not reroute by today's DNS.
CREATE FUNCTION release_receive_budget_holds(owner_filter text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; scanned int:=0;
BEGIN
 FOR r IN SELECT workspace_id,ses_message_id,created_at FROM mail_receipts WHERE status='held' AND budget_retry_at<=now()
   AND (owner_filter IS NULL OR workspace_id=owner_filter) ORDER BY budget_retry_at,workspace_id,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
   scanned:=scanned+1;
   IF r.created_at<now()-interval '3 days' THEN
     UPDATE mail_receipts SET status='failed',error='MAILBOX_BUDGET_HOLD_EXPIRED',processed_at=now(),budget_retry_at=NULL WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
   ELSIF mail_receive_slot(r.workspace_id) THEN
     UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
     INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',r.workspace_id,jsonb_build_object('sesMessageId',r.ses_message_id));
   ELSE
     UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE (workspace_id,ses_message_id)=(r.workspace_id,r.ses_message_id);
   END IF;
 END LOOP;
 RETURN scanned;
END $$;
