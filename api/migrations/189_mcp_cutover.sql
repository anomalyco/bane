-- The PR's new resource-grant table is empty at cutover. Keep a revocation
-- tombstone even when the access token expires or the workspace is deleted.
ALTER TABLE bane_resource_grants DROP CONSTRAINT bane_resource_grants_issuer_subject_fkey,
  ADD COLUMN user_id text NOT NULL REFERENCES bane_users ON DELETE CASCADE,
  ADD UNIQUE(user_id,client_id), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN issued_at bigint NOT NULL;
ALTER TABLE bane_resource_grants ALTER COLUMN workspace_id DROP NOT NULL,
  DROP CONSTRAINT bane_resource_grants_workspace_id_fkey,
  ADD FOREIGN KEY(workspace_id) REFERENCES workspaces ON DELETE SET NULL;

-- The dashboard reads this audit-only projection after cutover.
CREATE TABLE bane_expired_approvals (id text PRIMARY KEY,user_id text NOT NULL,client_id text NOT NULL,name text,scopes text[] NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE INDEX bane_expired_approvals_user ON bane_expired_approvals(user_id,id);
ALTER TABLE oauth_consent ADD COLUMN retired_at timestamptz;
