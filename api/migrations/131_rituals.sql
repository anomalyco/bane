SET LOCAL lock_timeout='2s';
-- Bounded config snapshots for editing/rollback. The claim never reads sources or connector credentials.
CREATE TABLE mail_ritual_configs(workspace_id text PRIMARY KEY, version integer NOT NULL, config jsonb NOT NULL, programs jsonb, owners jsonb NOT NULL DEFAULT '{}');
CREATE TABLE mail_ritual_versions(workspace_id text NOT NULL,version integer NOT NULL,config jsonb NOT NULL,actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,version));
CREATE TABLE mail_endpoints(workspace_id text NOT NULL,ref text NOT NULL,hook_id text UNIQUE NOT NULL REFERENCES mailbox_webhooks(id) ON DELETE CASCADE,encrypted_value text NOT NULL, verified boolean NOT NULL DEFAULT false, proof_hash text UNIQUE,expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,ref));
CREATE TABLE mail_forward_once(workspace_id text NOT NULL,message_id text NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,endpoint text NOT NULL,PRIMARY KEY(message_id,workspace_id,endpoint));
CREATE TABLE mail_action_policies(workspace_id text NOT NULL,hook_id text NOT NULL REFERENCES mailbox_webhooks ON DELETE CASCADE,per_minute integer NOT NULL CHECK(per_minute BETWEEN 1 AND 6000),retry_on_timeout boolean NOT NULL,idempotent boolean NOT NULL,PRIMARY KEY(workspace_id,hook_id));
-- Commit the send fence before attempting HTTP. A worker disappearing after POST is also an unknown outcome.
CREATE TABLE mail_action_attempts(workspace_id text NOT NULL,delivery_id text NOT NULL REFERENCES mailbox_webhook_deliveries ON DELETE CASCADE,state text NOT NULL CHECK(state IN ('sending','retry','delivered','unknown')),PRIMARY KEY(delivery_id,workspace_id));
