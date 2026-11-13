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

-- Identity is (issuer, subject) only. No legacy user is adopted by email: an address is display and
-- contact data, and an issuer can assert a verified address that the sign-in method never vouched for.
-- Operators link a subject to an existing user explicitly (scripts/list-signin-attempts.ts).
