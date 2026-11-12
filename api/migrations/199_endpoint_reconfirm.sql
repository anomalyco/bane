SET LOCAL lock_timeout='2s';
-- An endpoint URL is write-only: once saved, only its last four characters are shown. An endpoint held
-- because its approval was removed is marked (reconfirm) and resumes only when its URL is sent again.
-- A forward has no URL (its address is shown and cannot change), so it is paused without the mark.
-- A marked endpoint is always paused: the constraint holds that for every writer, old or new.
ALTER TABLE mailbox_webhooks ADD COLUMN reconfirm boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT mailbox_webhook_reconfirm_paused CHECK (NOT reconfirm OR paused);
CREATE OR REPLACE FUNCTION mail_disable_grant_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE domain text;
BEGIN
 IF OLD.kind='endpoint' THEN UPDATE mailbox_webhooks h SET paused=true,reconfirm=NOT EXISTS(SELECT FROM mail_endpoints d WHERE d.workspace_id=h.workspace_id AND d.hook_id=h.id AND d.ref LIKE 'forward:%') WHERE h.workspace_id=OLD.workspace_id AND h.id=OLD.resource;
 ELSIF OLD.kind='route' THEN UPDATE mail_routes SET enabled=false WHERE workspace_id=OLD.workspace_id AND id=OLD.resource RETURNING domain_id INTO domain; IF domain IS NOT NULL THEN PERFORM mail_compile_routes(OLD.workspace_id,domain); END IF;
 ELSIF OLD.kind='key' THEN UPDATE mailbox_keys SET revoked_at=now() WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='api_key' THEN UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 END IF;
 RETURN NULL;
END $$;
