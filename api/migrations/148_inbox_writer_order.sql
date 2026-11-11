SET LOCAL lock_timeout='2s';

-- A READ COMMITTED store statement gets a snapshot AFTER taking the ingest lane.
-- Final membership removal must commit under that same lane, not merely under
-- inbox_state (a row lock can't refresh the store statement's existing snapshot).
CREATE FUNCTION inbox_lock_ingest(wid text) RETURNS void LANGUAGE sql AS $$
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'ingest') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false
$$;
ALTER FUNCTION inbox_mutate(text,text,text,text,jsonb,boolean) RENAME TO inbox_apply_mutation;
ALTER FUNCTION inbox_patch_thread(text,text,text,jsonb) RENAME TO inbox_apply_thread_patch;
ALTER FUNCTION inbox_expunge_folder(text,text,text,bigint[]) RENAME TO inbox_apply_folder_expunge;

-- Restore the transaction-local marker on return. On error PostgreSQL rolls the
-- marker back with the failed transaction (or caller savepoint). This needs no
-- superuser-only CREATE FUNCTION SET on an unregistered custom GUC.
CREATE FUNCTION inbox_mutate(wid text,bid text,mid text,op text,p jsonb,refresh boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE prior text:=current_setting('bane.inbox_writer',true); result jsonb;
BEGIN
 PERFORM set_config('bane.inbox_writer','folders',true);
 IF op='expunge' THEN PERFORM inbox_lock_ingest(wid); END IF;
 result:=inbox_apply_mutation(wid,bid,mid,op,p,refresh);
 PERFORM set_config('bane.inbox_writer',coalesce(prior,''),true);
 RETURN result;
END $$;
CREATE FUNCTION inbox_expunge_folder(wid text,bid text,folder text,only_uids bigint[])
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE prior text:=current_setting('bane.inbox_writer',true); result jsonb;
BEGIN
 PERFORM set_config('bane.inbox_writer','folders',true);
 PERFORM inbox_lock_ingest(wid);
 result:=inbox_apply_folder_expunge(wid,bid,folder,only_uids);
 PERFORM set_config('bane.inbox_writer',coalesce(prior,''),true);
 RETURN result;
END $$;
CREATE FUNCTION inbox_patch_thread(wid text,bid text,tid text,p jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE prior text:=current_setting('bane.inbox_writer',true); result boolean;
BEGIN
 PERFORM set_config('bane.inbox_writer','folders',true);
 PERFORM inbox_lock_ingest(wid);
 result:=inbox_apply_thread_patch(wid,bid,tid,p);
 PERFORM set_config('bane.inbox_writer',coalesce(prior,''),true);
 RETURN result;
END $$;
