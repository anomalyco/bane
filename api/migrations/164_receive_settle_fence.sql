SET LOCAL lock_timeout='2s';

-- A pending receipt fails only for the claim that is settling it now, enforced in the database so that
-- the previous Worker's code cannot get around it.
--
-- Lease exhaustion retires a job row, but not the invocation that holds it: that Worker keeps running.
-- Since 155 the retired job's end admits the receipt's held reopen with a replacement job. The previous
-- Worker's terminal failure write (and its quarantine write) checks only status='pending', so the old
-- invocation, finishing late, failed the reopened receipt and its new recipients never got the mail.
--
-- Now a write that moves a receipt from pending to failed must either
-- - name its claim in settled_by: '<job id>|<lease_until as claimed>' (the lease is empty when a
--   handler runs outside the job runner). That job must be this receipt's ingest job, still running
--   on that lease. The current handler does this, besides fencing on the recipients it claimed.
-- - or be lost-receipt recovery failing a receipt that has no live job (its exhaustion codes, with
--   recovery_attempts incremented), from any Worker version.
-- Anything else, notably the previous Worker's handler write, is dropped (the row is not updated). That
-- receipt stays pending until its job ends; lost-receipt recovery then queues it again for a current
-- Worker, or fails it if that job used up its attempts. During a deploy's overlap a permanent failure is
-- therefore settled up to an hour later, and never on recipients its claim did not see.
ALTER TABLE mail_receipts ADD COLUMN settled_by text;

CREATE FUNCTION mail_receipt_settle_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE jid text; fence text;
BEGIN
 IF NEW.settled_by IS NOT NULL AND NEW.settled_by IS DISTINCT FROM OLD.settled_by THEN
   jid:=split_part(NEW.settled_by,'|',1); fence:=nullif(split_part(NEW.settled_by,'|',2),'');
   IF EXISTS(SELECT FROM jobs WHERE id=jid AND type='mailbox.ingest' AND workspace_id=NEW.workspace_id AND payload->>'sesMessageId'=NEW.ses_message_id
       AND status='running' AND (fence IS NULL OR lease_until=fence::timestamptz)) THEN
     RETURN NEW;
   END IF;
   RETURN NULL;
 END IF;
 IF NEW.error IN ('MAILBOX_INGEST_EXHAUSTED','MAILBOX_RECOVERY_EXHAUSTED') AND NEW.recovery_attempts>OLD.recovery_attempts THEN RETURN NEW; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER mail_receipt_settle_fence BEFORE UPDATE ON mail_receipts FOR EACH ROW WHEN (OLD.status='pending' AND NEW.status='failed')
  EXECUTE FUNCTION mail_receipt_settle_fence();
