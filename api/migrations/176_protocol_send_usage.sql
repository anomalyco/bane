SET LOCAL lock_timeout='2s';
-- Deleting an entry, the last Sent copy, or an old password must not refund sends.
CREATE TABLE inbox_protocol_sends(inbox_id text NOT NULL REFERENCES inbox_state ON DELETE CASCADE,day date NOT NULL, accepted integer NOT NULL,PRIMARY KEY(inbox_id,day));
-- Order matches inbox_end and inbox_mutate; DELETE of a folder may drop a membership.
ALTER FUNCTION inbox_edit_folder(text,text,text,text,text,boolean) RENAME TO inbox_apply_folder_edit;
CREATE FUNCTION inbox_edit_folder(w text,b text,op text,f text,p text,sub boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN IF op='delete' THEN PERFORM inbox_lock_ingest(w); END IF; RETURN inbox_apply_folder_edit(w,b,op,f,p,sub); END $$;
CREATE FUNCTION inbox_stop_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM FROM inbox_state WHERE inbox_id=NEW.id FOR UPDATE;
 UPDATE inbox_app_passwords SET revoked_at=now() WHERE inbox_id=NEW.id AND revoked_at IS NULL;
 UPDATE inbox_state SET protocol_passwords=0 WHERE inbox_id=NEW.id AND protocol_passwords>0;
 RETURN NULL;
END $$;
CREATE TRIGGER protocol_stop_on_end AFTER UPDATE OF delete_after ON mailboxes FOR EACH ROW WHEN(OLD.delete_after IS NULL AND NEW.delete_after IS NOT NULL) EXECUTE FUNCTION inbox_stop_protocol();
