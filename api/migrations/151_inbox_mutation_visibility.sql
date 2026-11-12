SET LOCAL lock_timeout='2s';

-- A request that waited on the inbox row behind DELETE /v1/inboxes/{id} resumed with the
-- mailbox row from its pre-wait snapshot (a row lock re-reads only the locked row) and changed
-- the deleted inbox. Lock first, then check visibility in a fresh statement.
CREATE OR REPLACE FUNCTION inbox_mutate(wid text,bid text,mid text,op text,p jsonb,refresh boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE prior text:=current_setting('bane.inbox_writer',true); result jsonb;
BEGIN
 PERFORM set_config('bane.inbox_writer','folders',true);
 IF op='expunge' THEN PERFORM inbox_lock_ingest(wid); END IF;
 PERFORM FROM inbox_state WHERE inbox_id=bid AND workspace_id=wid FOR UPDATE;
 IF NOT EXISTS(SELECT FROM mailboxes WHERE id=bid AND workspace_id=wid AND (delete_after IS NULL OR delete_after>statement_timestamp())) THEN
  result:='{"error":"NOT_FOUND"}';
 ELSE
  result:=inbox_apply_mutation(wid,bid,mid,op,p,refresh);
 END IF;
 PERFORM set_config('bane.inbox_writer',coalesce(prior,''),true);
 RETURN result;
END $$;
