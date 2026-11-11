SET LOCAL lock_timeout='2s';
-- Cascade on actual consent deletion, regardless of which OAuth revoke endpoint removed it.
CREATE TABLE mail_grant_objects(grant_id text NOT NULL REFERENCES oauth_consent ON DELETE CASCADE,workspace_id text NOT NULL,kind text NOT NULL,resource text NOT NULL,PRIMARY KEY(grant_id,workspace_id,kind,resource));
CREATE INDEX mail_grant_object_resource ON mail_grant_objects(workspace_id,kind,resource);
CREATE FUNCTION mail_disable_grant_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE domain text;
BEGIN
 IF OLD.kind='endpoint' THEN UPDATE mailbox_webhooks SET paused=true WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='route' THEN UPDATE mail_routes SET enabled=false WHERE workspace_id=OLD.workspace_id AND id=OLD.resource RETURNING domain_id INTO domain; IF domain IS NOT NULL THEN PERFORM mail_compile_routes(OLD.workspace_id,domain); END IF;
 ELSIF OLD.kind='key' THEN UPDATE mailbox_keys SET revoked_at=now() WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='rituals' THEN UPDATE mail_ritual_configs SET programs=NULL WHERE workspace_id=OLD.workspace_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER mail_grant_removed AFTER DELETE ON mail_grant_objects FOR EACH ROW EXECUTE FUNCTION mail_disable_grant_object();
