SET LOCAL lock_timeout='2s';

-- Two SNS notifications of the same new message can run at once (SES retries, two receipt rules).
-- Both saw no receipt, so both charged the hourly window; the second's INSERT then found the
-- first's receipt and changed nothing, leaving the window charged twice for one message. The same
-- happened when the first receipt was failed or held: the second charged for a receipt it never
-- created. Serialize first receipts of a workspace on its window row (as charging already does)
-- and recheck for the receipt after the wait; a notification of a known message still never
-- touches the window. The no-op upsert locks the row even when its UPDATE predicate is false.
CREATE OR REPLACE FUNCTION mail_receive_admit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'pending' OR EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN RETURN NEW; END IF;
 INSERT INTO mail_receive_windows AS w VALUES(NEW.workspace_id,date_trunc('hour',now()),0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=w.messages WHERE false;
 IF EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN RETURN NEW; END IF;
 IF jsonb_array_length(NEW.recipients)>100 THEN
   NEW.status:='failed';NEW.processed_at:=now();NEW.error:='MAILBOX_RECEIVE_BUDGET';
 ELSIF NOT mail_receive_slot(NEW.workspace_id) THEN
   NEW.status:='held';NEW.error:='MAILBOX_RECEIVE_BUDGET';NEW.budget_retry_at:=date_trunc('hour',now())+interval '1 hour';
 END IF;
 RETURN NEW;
END $$;
