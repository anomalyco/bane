CREATE UNIQUE INDEX bane_oidc_identity_owner ON bane_oidc_identities(issuer,subject,user_id);
CREATE TABLE bane_sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL, issuer text NOT NULL, subject text NOT NULL,
  expires_at timestamptz NOT NULL, verified_email text, acr text,
  FOREIGN KEY (issuer,subject,user_id) REFERENCES bane_oidc_identities(issuer,subject,user_id) ON DELETE CASCADE
);
CREATE INDEX bane_sessions_expiry ON bane_sessions(expires_at);
CREATE TABLE bane_login_flows (
  state_hash text PRIMARY KEY, cookie_hash text NOT NULL, issuer text NOT NULL, client_id text NOT NULL,
  nonce text NOT NULL, verifier text NOT NULL, return_url text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX bane_login_flows_expiry ON bane_login_flows(expires_at);

-- During a rolling upgrade legacy writers still create users referenced by
-- workspace_members. Preserve those IDs until the last old process is drained.
CREATE FUNCTION bane_mirror_legacy_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM bane_users WHERE id=OLD.id; RETURN OLD; END IF;
  INSERT INTO bane_users(id,name,email,email_verified,selected_workspace_id,created_at,updated_at)
  VALUES(NEW.id,NEW.name,NEW.email,NEW.email_verified,NEW.selected_workspace_id,NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,email_verified=excluded.email_verified,
    selected_workspace_id=excluded.selected_workspace_id,updated_at=excluded.updated_at;
  RETURN NEW;
END $$;
CREATE TRIGGER bane_legacy_user_writes AFTER INSERT OR UPDATE OR DELETE ON auth_user
  FOR EACH ROW EXECUTE FUNCTION bane_mirror_legacy_user();
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_user_id_fkey,
  ADD FOREIGN KEY (user_id) REFERENCES bane_users(id) ON DELETE CASCADE;
ALTER TABLE workspace_invitations DROP CONSTRAINT workspace_invitations_inviter_id_fkey,
  ADD FOREIGN KEY (inviter_id) REFERENCES bane_users(id) ON DELETE CASCADE;
