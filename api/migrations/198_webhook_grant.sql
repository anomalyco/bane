SET LOCAL lock_timeout='2s';
-- A sending webhook that an approval set up, changed or read the signing secret of is held when the approval is
-- removed, like the keys and receiving endpoints it created. A webhook URL is write-only, so a held webhook is
-- marked (reconfirm) and resumes only when its URL is sent again; it gets a new signing secret then.
-- A marked webhook is always paused: the constraint holds that for every writer, old or new.
ALTER TABLE operation_webhooks ADD COLUMN reconfirm boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT operation_webhook_reconfirm_paused CHECK (NOT reconfirm OR paused);
CREATE FUNCTION operation_webhook_grant_removed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE operation_webhooks SET paused=true,reconfirm=true WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 RETURN NULL;
END $$;
CREATE TRIGGER operation_webhook_grant_removed AFTER DELETE ON mail_grant_objects FOR EACH ROW WHEN (OLD.kind='webhook') EXECUTE FUNCTION operation_webhook_grant_removed();
