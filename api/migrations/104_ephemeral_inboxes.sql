SET LOCAL lock_timeout='2s';
ALTER TABLE mailboxes ADD COLUMN kind text NOT NULL DEFAULT 'address', ADD COLUMN retention_mode text NOT NULL DEFAULT 'default', ADD COLUMN delete_after timestamptz, ADD COLUMN quota_messages int, ADD COLUMN quota_bytes bigint, ADD COLUMN client_id text, ADD COLUMN created_by text, ADD COLUMN create_request jsonb,
 ADD CONSTRAINT mailboxes_kind CHECK (kind IN ('address','inbox')) NOT VALID,
 ADD CONSTRAINT mailboxes_retention_mode CHECK (retention_mode IN ('default','forever','days','ephemeral')) NOT VALID,
 ADD CONSTRAINT mailboxes_ephemeral_shape CHECK (retention_mode <> 'ephemeral' OR (kind='inbox' AND expires_at IS NOT NULL AND delete_after IS NOT NULL AND delete_after>=expires_at)) NOT VALID;
ALTER TABLE mail_messages ADD COLUMN lifecycle text NOT NULL DEFAULT 'default', ADD CONSTRAINT mail_messages_lifecycle CHECK(lifecycle IN ('ephemeral','default','kept')) NOT VALID;
ALTER TABLE mailbox_messages ADD COLUMN held_reason text, ADD COLUMN inbox_seq bigint, ADD CONSTRAINT mailbox_messages_held CHECK(held_reason IN ('quota','expired')) NOT VALID;
ALTER TABLE mailbox_keys ADD COLUMN expires_at timestamptz;
ALTER TABLE mail_receipts ADD COLUMN dropped_recipients smallint NOT NULL DEFAULT 0;
CREATE TABLE inbox_state(inbox_id text PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,workspace_id text NOT NULL,messages int NOT NULL DEFAULT 0,bytes bigint NOT NULL DEFAULT 0,held int NOT NULL DEFAULT 0,held_since timestamptz);
CREATE TABLE mail_retired_addresses(workspace_id text NOT NULL,address text NOT NULL,until timestamptz NOT NULL,PRIMARY KEY(workspace_id,address));
CREATE TABLE mail_gc_candidates(workspace_id text NOT NULL,message_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,message_id));

-- Virtual sandbox domains use no DNS, SES connection, or receiving host.
ALTER TABLE mailbox_domains ADD CONSTRAINT sandbox_never_routable CHECK (name NOT LIKE '%.sandbox.invalid' OR (status='disabled' AND receiving_host IS NULL)) NOT VALID;
ALTER TABLE inbox_state ADD COLUMN simulated_count int NOT NULL DEFAULT 0;
