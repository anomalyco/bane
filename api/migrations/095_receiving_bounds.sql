SET LOCAL lock_timeout='2s';
ALTER TABLE provider_pool_regions ADD COLUMN receiving_checked_at timestamptz;
ALTER TABLE domain_claims ADD COLUMN receiving_proved_at timestamptz;
ALTER TABLE domain_claims ADD COLUMN receiving_identity_at timestamptz;
ALTER TABLE domain_claims ADD COLUMN receiving_proof_missed_at timestamptz;
ALTER TABLE mail_ingest_turns ADD COLUMN active bigint NOT NULL DEFAULT 0;
-- Job ownership and type are immutable for ingest. Count every writer, including receipt replay,
-- lease exhaustion, manual deletion and migration of already queued work.
CREATE FUNCTION mail_ingest_head_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE removed boolean:=TG_OP<>'INSERT' AND OLD.type='mailbox.ingest' AND OLD.status IN ('pending','running');
        added boolean:=TG_OP<>'DELETE' AND NEW.type='mailbox.ingest' AND NEW.status IN ('pending','running');
BEGIN
 IF added AND removed AND NEW.workspace_id=OLD.workspace_id THEN RETURN NULL; END IF;
 IF removed THEN UPDATE mail_ingest_turns SET active=active-1 WHERE workspace_id=OLD.workspace_id; END IF;
 IF added THEN INSERT INTO mail_ingest_turns(workspace_id,served_at,active) VALUES(NEW.workspace_id,'-infinity',1) ON CONFLICT(workspace_id) DO UPDATE SET active=mail_ingest_turns.active+1; END IF;
 RETURN NULL;
END $$;
CREATE TABLE mail_ignored_staging(bucket text NOT NULL,ses_message_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(bucket,ses_message_id));
CREATE INDEX mail_ignored_expiry ON mail_ignored_staging(created_at);
ALTER TABLE mailbox_webhook_deliveries ADD COLUMN generation integer NOT NULL DEFAULT 0;
CREATE TABLE mail_receive_limits(workspace_id text PRIMARY KEY,spam_policy text NOT NULL DEFAULT 'store' CHECK(spam_policy IN ('store','quarantine')),message_limit integer NOT NULL DEFAULT 600000,backlog_limit integer NOT NULL DEFAULT 50000,byte_limit bigint NOT NULL DEFAULT 68719476736);
CREATE TABLE mail_receive_windows(workspace_id text PRIMARY KEY,window_at timestamptz NOT NULL,messages bigint NOT NULL,bytes bigint NOT NULL);
ALTER TABLE mail_receipts ADD COLUMN reserved_bytes bigint;
-- Admission uses one current UTC hour per workspace; charging retries would amplify SNS redelivery.
CREATE FUNCTION mail_receive_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h timestamptz:=date_trunc('hour',now()); maximum bigint; backlog bigint;
BEGIN
 IF NEW.status<>'pending' OR EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN RETURN NEW; END IF;
 SELECT message_limit,backlog_limit INTO maximum,backlog FROM mail_receive_limits WHERE workspace_id=NEW.workspace_id;
 INSERT INTO mail_receive_windows AS w VALUES(NEW.workspace_id,h,1,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=CASE WHEN w.window_at=h THEN w.messages+1 ELSE 1 END,bytes=CASE WHEN w.window_at=h THEN w.bytes ELSE 0 END,window_at=h WHERE w.window_at<>h OR w.messages<coalesce(maximum,600000);
 IF NOT FOUND OR coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=NEW.workspace_id),0)>=coalesce(backlog,50000) OR jsonb_array_length(NEW.recipients)>100 THEN
   NEW.status:='failed';NEW.processed_at:=now();NEW.error:='MAILBOX_RECEIVE_BUDGET';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mail_receive_admit BEFORE INSERT ON mail_receipts FOR EACH ROW EXECUTE FUNCTION mail_receive_admit();
CREATE TABLE mail_candidate_uploads(batch text PRIMARY KEY,workspace_id text NOT NULL,ses_message_id text NOT NULL,bucket text NOT NULL,region text NOT NULL,message_id text NOT NULL,keys text[] NOT NULL,check_at timestamptz NOT NULL DEFAULT now()+interval '1 hour');
CREATE INDEX mail_candidate_due ON mail_candidate_uploads(check_at);
