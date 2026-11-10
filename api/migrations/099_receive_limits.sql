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
CREATE OR REPLACE FUNCTION mail_receive_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h timestamptz:=date_trunc('hour',now()); maximum int; backlog int;
BEGIN
 IF NEW.status<>'pending' OR EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN RETURN NEW; END IF;
 SELECT p.messages,p.backlog INTO maximum,backlog FROM mail_receive_policy(NEW.workspace_id) p;
 INSERT INTO mail_receive_windows AS w VALUES(NEW.workspace_id,h,1,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=CASE WHEN w.window_at=h THEN w.messages+1 ELSE 1 END,bytes=CASE WHEN w.window_at=h THEN w.bytes ELSE 0 END,window_at=h WHERE w.window_at<>h OR w.messages<maximum;
 IF NOT FOUND OR coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=NEW.workspace_id),0)>=backlog OR jsonb_array_length(NEW.recipients)>100 THEN
   NEW.status:='failed';NEW.processed_at:=now();NEW.error:='MAILBOX_RECEIVE_BUDGET';
 END IF;
 RETURN NEW;
END $$;
