SET LOCAL lock_timeout='2s';
CREATE FUNCTION inbox_revoke_password(w text,b text,k text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN false; END IF;
 UPDATE inbox_app_passwords SET revoked_at=clock_timestamp() WHERE id=k AND inbox_id=b AND revoked_at IS NULL;
 IF NOT FOUND THEN RETURN false; END IF;
 UPDATE inbox_state SET protocol_passwords=protocol_passwords-1 WHERE inbox_id=b;
 RETURN true;
END $$;
CREATE FUNCTION inbox_protocol_grant_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM inbox_revoke_password(OLD.workspace_id,p.inbox_id,p.id) FROM inbox_app_passwords p WHERE p.id=OLD.resource; RETURN NULL; END $$;
CREATE TRIGGER protocol_grant_removed AFTER DELETE ON mail_grant_objects FOR EACH ROW WHEN (OLD.kind='protocol') EXECUTE FUNCTION inbox_protocol_grant_removed();
