SET LOCAL lock_timeout='2s';

-- Two changes to the receipt insert trigger, which every route statement of every Worker runs.
--
-- One lock order. A first receipt took the workspace window row and then created the receipt; a
-- reopen (a known receipt gaining recipients) locked the receipt and later needed the window row.
-- A held-envelope replay batch and an ordinary reopen of one of its messages could then deadlock
-- (40P01): the batch held the window for a new message and waited on the known receipt, while the
-- reopen held that receipt and waited on the window. Sorting rows by workspace does not order the
-- messages within one. Now every row takes its workspace's window row first, then the receipt, so
-- route statements of one workspace serialize on its window row. The ingest byte debit takes the
-- window row before the receipt as well.
--
-- The database owns the merge. Commit 96c9c9f fixed the route's 200-recipient reopen bound to count
-- the merged recipients once. A Worker running the previous route still checks
-- jsonb_array_length(old||new)<=200 during a deploy's overlap, so a notification repeating 100 known
-- recipients and adding one was refused: the callback was still accepted, no job was queued, and
-- staging recovery skips objects that already have a receipt, so the new recipient never got the
-- message. Now, for a known receipt, the trigger locks the receipt row and passes on only the
-- recipients its newest version lacks. Locking first means a concurrent reopen has committed before
-- the subtraction. Both bounds then count exactly the merged set, and the merge (old || new,
-- deduplicated) stores the same union. If none are new, the notification still matches the stored
-- list and changes nothing.
CREATE FUNCTION mail_receive_new_recipients(wid text,mid text,proposed jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE known jsonb;
BEGIN
 SELECT recipients INTO known FROM mail_receipts WHERE workspace_id=wid AND ses_message_id=mid FOR UPDATE;
 IF NOT FOUND THEN RETURN proposed; END IF;
 RETURN coalesce((SELECT jsonb_agg(a ORDER BY a) FROM jsonb_array_elements_text(proposed) a WHERE NOT known ? a),proposed);
END $$;

CREATE OR REPLACE FUNCTION mail_receive_admit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status<>'pending' THEN RETURN NEW; END IF;
 -- The window row first (the no-op upsert locks it even when its UPDATE predicate is false), then
 -- the receipt. A first receipt is rechecked after the wait (153).
 INSERT INTO mail_receive_windows AS w VALUES(NEW.workspace_id,date_trunc('hour',now()),0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=w.messages WHERE false;
 IF EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN
   NEW.recipients:=mail_receive_new_recipients(NEW.workspace_id,NEW.ses_message_id,NEW.recipients);RETURN NEW;
 END IF;
 IF jsonb_array_length(NEW.recipients)>100 THEN
   NEW.status:='failed';NEW.processed_at:=now();NEW.error:='MAILBOX_RECEIVE_BUDGET';
 ELSIF NOT mail_receive_slot(NEW.workspace_id) THEN
   NEW.status:='held';NEW.error:='MAILBOX_RECEIVE_BUDGET';NEW.budget_retry_at:=date_trunc('hour',now())+interval '1 hour';
 END IF;
 RETURN NEW;
END $$;
