CREATE TABLE bane_resource_grants (
  id text PRIMARY KEY, issuer text NOT NULL, subject text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  permissions text[] NOT NULL, expires_at timestamptz NOT NULL,
  client_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked boolean NOT NULL DEFAULT false,
  FOREIGN KEY (issuer,subject) REFERENCES bane_oidc_identities ON DELETE CASCADE
);
CREATE INDEX bane_resource_grants_expiry ON bane_resource_grants(expires_at);
CREATE TABLE bane_dpop_proofs (id text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE INDEX bane_dpop_proofs_expiry ON bane_dpop_proofs(expires_at);
