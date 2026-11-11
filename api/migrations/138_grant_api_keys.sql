SET LOCAL lock_timeout='2s';
-- API keys an MCP agent creates are tied to the approval that created them: revoking the approval revokes the keys.
CREATE OR REPLACE FUNCTION mail_disable_grant_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE domain text;
BEGIN
 IF OLD.kind='endpoint' THEN UPDATE mailbox_webhooks SET paused=true WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='route' THEN UPDATE mail_routes SET enabled=false WHERE workspace_id=OLD.workspace_id AND id=OLD.resource RETURNING domain_id INTO domain; IF domain IS NOT NULL THEN PERFORM mail_compile_routes(OLD.workspace_id,domain); END IF;
 ELSIF OLD.kind='key' THEN UPDATE mailbox_keys SET revoked_at=now() WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='api_key' THEN UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 END IF;
 RETURN NULL;
END $$;
