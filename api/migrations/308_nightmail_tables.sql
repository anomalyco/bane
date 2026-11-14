-- Bane → Nightmail: the account, session and OAuth tables take the product's name (nightmail_*), with their indexes
-- and the functions and trigger that name them. Each old table name stays as a plain view of the new table, which
-- Postgres keeps writable, so the release still running while this deploy migrates keeps working. The cutover removal
-- drops the views (remove after rename cleanup). The migration ledger (bane_migrations) moves in src/migrate.ts.

ALTER TABLE bane_users RENAME TO nightmail_users;
ALTER TABLE bane_sessions RENAME TO nightmail_sessions;
ALTER TABLE bane_oidc_identities RENAME TO nightmail_oidc_identities;
ALTER TABLE bane_signin_attempts RENAME TO nightmail_signin_attempts;
ALTER TABLE bane_login_flows RENAME TO nightmail_login_flows;
ALTER TABLE bane_resource_grants RENAME TO nightmail_resource_grants;
ALTER TABLE bane_dpop_proofs RENAME TO nightmail_dpop_proofs;
ALTER TABLE bane_expired_approvals RENAME TO nightmail_expired_approvals;
ALTER TABLE bane_retired_grant_objects RENAME TO nightmail_retired_grant_objects;

ALTER INDEX bane_dpop_proofs_expiry RENAME TO nightmail_dpop_proofs_expiry;
ALTER INDEX bane_dpop_proofs_pkey RENAME TO nightmail_dpop_proofs_pkey;
ALTER INDEX bane_expired_approvals_pkey RENAME TO nightmail_expired_approvals_pkey;
ALTER INDEX bane_expired_approvals_user RENAME TO nightmail_expired_approvals_user;
ALTER INDEX bane_login_flows_expiry RENAME TO nightmail_login_flows_expiry;
ALTER INDEX bane_login_flows_pkey RENAME TO nightmail_login_flows_pkey;
ALTER INDEX bane_oidc_identities_pkey RENAME TO nightmail_oidc_identities_pkey;
ALTER INDEX bane_oidc_identities_user_idx RENAME TO nightmail_oidc_identities_user_idx;
ALTER INDEX bane_oidc_identity_owner RENAME TO nightmail_oidc_identity_owner;
ALTER INDEX bane_resource_grants_expiry RENAME TO nightmail_resource_grants_expiry;
ALTER INDEX bane_resource_grants_grant_key_key RENAME TO nightmail_resource_grants_grant_key_key;
ALTER INDEX bane_resource_grants_pkey RENAME TO nightmail_resource_grants_pkey;
ALTER INDEX bane_resource_grants_user_id_client_id_key RENAME TO nightmail_resource_grants_user_id_client_id_key;
ALTER INDEX bane_retired_grant_objects_pkey RENAME TO nightmail_retired_grant_objects_pkey;
ALTER INDEX bane_sessions_expiry RENAME TO nightmail_sessions_expiry;
ALTER INDEX bane_sessions_pkey RENAME TO nightmail_sessions_pkey;
ALTER INDEX bane_signin_attempts_last RENAME TO nightmail_signin_attempts_last;
ALTER INDEX bane_signin_attempts_pkey RENAME TO nightmail_signin_attempts_pkey;
ALTER INDEX bane_users_pkey RENAME TO nightmail_users_pkey;
ALTER INDEX bane_users_verified_address RENAME TO nightmail_users_verified_address;

ALTER TABLE nightmail_oidc_identities RENAME CONSTRAINT bane_oidc_identities_issuer_check TO nightmail_oidc_identities_issuer_check;
ALTER TABLE nightmail_oidc_identities RENAME CONSTRAINT bane_oidc_identities_subject_check TO nightmail_oidc_identities_subject_check;
ALTER TABLE nightmail_oidc_identities RENAME CONSTRAINT bane_oidc_identities_user_id_fkey TO nightmail_oidc_identities_user_id_fkey;
ALTER TABLE nightmail_resource_grants RENAME CONSTRAINT bane_resource_grants_profile_check TO nightmail_resource_grants_profile_check;
ALTER TABLE nightmail_resource_grants RENAME CONSTRAINT bane_resource_grants_user_id_fkey TO nightmail_resource_grants_user_id_fkey;
ALTER TABLE nightmail_resource_grants RENAME CONSTRAINT bane_resource_grants_workspace_id_fkey TO nightmail_resource_grants_workspace_id_fkey;
ALTER TABLE nightmail_sessions RENAME CONSTRAINT bane_sessions_issuer_subject_user_id_fkey TO nightmail_sessions_issuer_subject_user_id_fkey;

CREATE VIEW bane_users AS SELECT * FROM nightmail_users;
CREATE VIEW bane_sessions AS SELECT * FROM nightmail_sessions;
CREATE VIEW bane_oidc_identities AS SELECT * FROM nightmail_oidc_identities;
CREATE VIEW bane_signin_attempts AS SELECT * FROM nightmail_signin_attempts;
CREATE VIEW bane_login_flows AS SELECT * FROM nightmail_login_flows;
CREATE VIEW bane_resource_grants AS SELECT * FROM nightmail_resource_grants;
CREATE VIEW bane_dpop_proofs AS SELECT * FROM nightmail_dpop_proofs;
CREATE VIEW bane_expired_approvals AS SELECT * FROM nightmail_expired_approvals;
CREATE VIEW bane_retired_grant_objects AS SELECT * FROM nightmail_retired_grant_objects;

CREATE OR REPLACE FUNCTION mail_management_grant(w text, gid text, policy jsonb, needs_receiving boolean) RETURNS boolean LANGUAGE sql AS $$
  -- Same rule as externalMcpGrant: the approval is active, and its subject (admitted, and on self-hosted installations
  -- allowlisted) is an owner or admin of w with manage. Receiving needs nothing more. The address is not an input.
  SELECT EXISTS(SELECT FROM nightmail_resource_grants g
    JOIN nightmail_oidc_identities i USING(issuer,subject) JOIN nightmail_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.user_id=i.user_id AND m.workspace_id=w
    WHERE g.grant_key=gid AND g.issuer=policy->>'issuer' AND g.expires_at>now() AND NOT g.revoked
    AND (coalesce((policy->>'hosted')::boolean,false) OR coalesce(policy->'subjects','[]'::jsonb) ? i.subject)
    AND m.role IN ('owner','admin') AND 'manage'=ANY(g.permissions) FOR SHARE OF g,i,u,m);
$$;

CREATE OR REPLACE FUNCTION billing_user_identities(uid text) RETURNS TABLE(issuer text, subject text) LANGUAGE sql STABLE AS $$
  SELECT issuer::text, subject::text FROM nightmail_oidc_identities WHERE user_id=uid
$$;

ALTER FUNCTION bane_mirror_legacy_user() RENAME TO nightmail_mirror_legacy_user;
CREATE OR REPLACE FUNCTION nightmail_mirror_legacy_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN DELETE FROM nightmail_users WHERE id=OLD.id; RETURN OLD; END IF;
  INSERT INTO nightmail_users(id,name,email,email_verified,selected_workspace_id,created_at,updated_at)
  VALUES(NEW.id,NEW.name,NEW.email,NEW.email_verified,NEW.selected_workspace_id,NEW.created_at,NEW.updated_at)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name,email=excluded.email,email_verified=excluded.email_verified,
    selected_workspace_id=excluded.selected_workspace_id,updated_at=excluded.updated_at;
  RETURN NEW;
END $$;
ALTER TRIGGER bane_legacy_user_writes ON auth_user RENAME TO nightmail_legacy_user_writes;
