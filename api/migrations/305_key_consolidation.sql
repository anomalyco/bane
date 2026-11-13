SET LOCAL lock_timeout='2s';
-- Customers see one API key with permissions. Keys limited to receiving addresses keep their own table, prefix
-- (bane_mbx_) and door (mailboxAuth), so a limited key still never reaches a workspace route; the public API lists,
-- creates and revokes both tables as API keys. Nothing is reissued: secrets, hashes and IDs stay as they are.
--
-- A key limited to one agent inbox stops working when that inbox is deleted. That was implied by the shape of the row
-- (inbox_end matched mailbox_ids = [inbox] with an expiry, or a persistent inbox); it is now a property of the key.
ALTER TABLE mailbox_keys ADD COLUMN inbox_id text,
  ADD CONSTRAINT mailbox_keys_inbox_scope CHECK (inbox_id IS NULL OR mailbox_ids = jsonb_build_array(inbox_id));

-- Exactly the keys the previous inbox_end would have ended: nothing gains or loses access.
UPDATE mailbox_keys k SET inbox_id = b.id FROM mailboxes b
  WHERE jsonb_typeof(k.mailbox_ids) = 'array' AND jsonb_array_length(k.mailbox_ids) = 1
    AND b.workspace_id = k.workspace_id AND b.id = k.mailbox_ids->>0 AND b.kind = 'inbox'
    AND (k.expires_at IS NOT NULL OR b.create_request->>'type' = 'persistent');

CREATE INDEX mailbox_keys_inbox ON mailbox_keys(workspace_id, inbox_id) WHERE inbox_id IS NOT NULL;

-- Writers that don't name the inbox (create_managed_inbox, inbox connections, the deprecated createInboundKey) keep the
-- same rule as the backfill, so a new key ends with its inbox exactly when it would have before.
CREATE FUNCTION mailbox_key_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inbox_id IS NULL AND jsonb_typeof(NEW.mailbox_ids) = 'array' AND jsonb_array_length(NEW.mailbox_ids) = 1 THEN
    SELECT b.id INTO NEW.inbox_id FROM mailboxes b WHERE b.workspace_id = NEW.workspace_id AND b.id = NEW.mailbox_ids->>0 AND b.kind = 'inbox'
      AND (NEW.expires_at IS NOT NULL OR b.create_request->>'type' = 'persistent');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mailbox_keys_inbox BEFORE INSERT ON mailbox_keys FOR EACH ROW EXECUTE FUNCTION mailbox_key_inbox();

CREATE OR REPLACE FUNCTION inbox_end(wid text,bid text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE ended timestamptz;
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'ingest'),(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 PERFORM FROM mailboxes WHERE workspace_id=wid AND id=bid FOR NO KEY UPDATE;
 PERFORM FROM inbox_state WHERE inbox_id=bid AND workspace_id=wid FOR UPDATE;
 UPDATE mailboxes SET retention_mode='ephemeral', expires_at=least(expires_at,now()),delete_after=now() WHERE workspace_id=wid AND id=bid AND kind='inbox' RETURNING delete_after INTO ended;
 IF NOT FOUND THEN RETURN NULL; END IF;
 DELETE FROM mailbox_addresses a USING mailboxes b WHERE a.workspace_id=wid AND a.mailbox_id=bid AND b.id=bid AND b.create_request->>'type'<>'sandbox';
 UPDATE mailbox_keys SET expires_at=ended WHERE workspace_id=wid AND inbox_id=bid AND (expires_at IS NULL OR expires_at>ended);
 RETURN ended;
END $$;

-- When an agent (an MCP approval) was last used, for the API keys page. Touched at most once a minute.
ALTER TABLE bane_resource_grants ADD COLUMN last_used_at timestamptz;
