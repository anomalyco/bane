SET LOCAL lock_timeout='2s';

-- Every hand-out of a webhook signing secret: when an endpoint is created, when the secret is read back (Reveal) and when
-- it is rotated, with the credential that asked and when. The secret lets its holder sign requests the customer's receiver
-- trusts, so reading it is recorded like a credential. Rows outlive the webhook they name: no foreign key.
CREATE TABLE IF NOT EXISTS webhook_secret_audit (
  workspace_id text NOT NULL,
  id text NOT NULL,
  webhook_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'revealed', 'rotated')),
  actor_key_id text NOT NULL,
  credential text NOT NULL,
  actor_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS webhook_secret_audit_webhook ON webhook_secret_audit(workspace_id, webhook_id, created_at);
