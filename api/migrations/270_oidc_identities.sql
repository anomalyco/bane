-- Run with dashboard sign-in, account linking and workspace user writes fenced.
-- Preserve user IDs: memberships, invitations and queued work refer to these IDs.
CREATE TABLE bane_users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL,
  selected_workspace_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bane_users (id, name, email, email_verified, selected_workspace_id, created_at, updated_at)
SELECT id, name, email, email_verified, selected_workspace_id, created_at, updated_at FROM auth_user;

CREATE TABLE bane_oidc_identities (
  issuer text COLLATE "C" NOT NULL CHECK (issuer <> ''),
  subject text COLLATE "C" NOT NULL CHECK (subject <> ''),
  user_id text NOT NULL REFERENCES bane_users(id) ON DELETE CASCADE,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX bane_oidc_identities_user_idx ON bane_oidc_identities(user_id);

-- #60 stored JSON.stringify([iss, sub]). Abort the whole migration on a
-- malformed link: treating that user as unconnected could transfer ownership.
DO $$
BEGIN
  IF EXISTS (
    SELECT FROM (SELECT account_id::jsonb AS pair FROM auth_account WHERE provider_id = 'account') links
    WHERE CASE WHEN jsonb_typeof(pair) = 'array' THEN
      jsonb_array_length(pair) <> 2 OR jsonb_typeof(pair->0) IS DISTINCT FROM 'string'
      OR jsonb_typeof(pair->1) IS DISTINCT FROM 'string'
      ELSE true END
  ) THEN RAISE EXCEPTION 'invalid legacy OIDC identity'; END IF;
END $$;

INSERT INTO bane_oidc_identities (issuer, subject, user_id)
SELECT account_id::jsonb->>0, account_id::jsonb->>1, user_id FROM auth_account WHERE provider_id = 'account';

-- An operator reviews mailbox reassignments before approving individual legacy
-- claims. Each approval pins the expected issuer, user and exact verified email.
CREATE TABLE bane_legacy_claims (
  user_id text PRIMARY KEY REFERENCES bane_users(id) ON DELETE CASCADE,
  issuer text COLLATE "C" NOT NULL,
  email text COLLATE "C" NOT NULL,
  UNIQUE (issuer, email)
);

-- Called only after ID-token verification. The DELETE serializes two subjects
-- racing for the same legacy user; a conflicting insert rolls the delete back.
CREATE FUNCTION claim_bane_legacy_user(p_issuer text, p_subject text, p_email text, p_verified boolean)
RETURNS text LANGUAGE sql VOLATILE AS $$
  WITH claimed AS (
    DELETE FROM bane_legacy_claims a USING bane_users u
    WHERE p_verified IS TRUE AND a.issuer = p_issuer AND a.email = p_email
      AND u.id = a.user_id AND u.email_verified AND u.email COLLATE "C" = a.email
      AND NOT EXISTS (SELECT FROM bane_oidc_identities i WHERE i.user_id = a.user_id)
    RETURNING a.user_id
  ), linked AS (
    INSERT INTO bane_oidc_identities (issuer, subject, user_id)
    SELECT p_issuer, p_subject, user_id FROM claimed RETURNING user_id
  ) SELECT user_id FROM linked;
$$;
