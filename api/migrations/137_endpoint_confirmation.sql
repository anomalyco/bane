SET LOCAL lock_timeout='2s';
-- Forward confirmation by emailed link alone: when it was requested and from which address,
-- who pre-verified an own-domain address, and the recipient's answer.
ALTER TABLE mail_endpoints
  ADD COLUMN requested_at timestamptz,
  ADD COLUMN request_from text,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN declined_at timestamptz,
  ADD COLUMN preverified_by text;
-- One endpoint name per workspace whatever its type (keyed webhooks are checked by the API under the address lane).
CREATE UNIQUE INDEX mail_endpoints_name ON mail_endpoints(workspace_id,(split_part(ref,':',2)));
-- A decline or stop blocks the workspace from asking that address again for 30 days. Only a hash of the address is kept.
CREATE TABLE mail_forward_declines(workspace_id text NOT NULL,address_hash text NOT NULL,declined_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,address_hash));
