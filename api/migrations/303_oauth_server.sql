SET LOCAL lock_timeout='2s';
-- Bane is the OAuth 2.1 authorization server of its own /mcp (src/oauth-server.ts). The account service only signs the
-- person in to the dashboard. An approval (bane_resource_grants) is made on Bane's consent page by a dashboard session,
-- one per authorization, and the client gets Bane's own opaque tokens. Approvals the account service's access tokens
-- created (kind 'issuer') stay as they are: they expired with their last token, can be revoked, and are never renewed.
ALTER TABLE bane_resource_grants DROP CONSTRAINT bane_resource_grants_user_id_client_id_key,
  ADD COLUMN kind text NOT NULL DEFAULT 'issuer' CHECK (kind IN ('issuer','oauth','key')),
  -- The client's own name (its metadata document or registration), or an MCP key's label. Display only.
  ADD COLUMN client_name text CHECK (char_length(client_name) <= 160),
  -- The authentication context of the session that approved it (ACCOUNT_REQUIRED_ACR is checked against it on use).
  ADD COLUMN acr text,
  ADD COLUMN last_used_at timestamptz,
  ALTER COLUMN issued_at SET DEFAULT 0;
ALTER TABLE bane_resource_grants ALTER COLUMN kind DROP DEFAULT;
CREATE INDEX bane_resource_grants_user ON bane_resource_grants(user_id, id);
-- How the session's sign-in authenticated (the ID token's acr), so an approval records it.
ALTER TABLE bane_sessions ADD COLUMN acr text;

-- Dynamically registered clients (RFC 7591). Clients that publish a metadata document (CIMD) are fetched, not stored.
CREATE TABLE bane_oauth_clients (
  id text PRIMARY KEY,
  auth_method text NOT NULL CHECK (auth_method IN ('none','client_secret_basic','client_secret_post')),
  secret_hash text,
  name text CHECK (char_length(name) <= 160),
  client_uri text CHECK (char_length(client_uri) <= 2048),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) <= 20),
  grant_types text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CHECK ((auth_method = 'none') = (secret_hash IS NULL))
);

-- One authorization in progress: a browser request (code) or a device request (device), until its client collects the
-- tokens or it expires. The consent page shows it; approving it creates the approval.
CREATE TABLE bane_oauth_requests (
  id text PRIMARY KEY,
  flow text NOT NULL CHECK (flow IN ('code','device')),
  client_id text NOT NULL,
  client_name text,
  redirect_uri text,
  state text,
  code_challenge text,
  scopes text[] NOT NULL,
  profile text,
  refresh boolean NOT NULL,
  device_hash text UNIQUE,
  user_code text UNIQUE,
  requested_ip text,
  requested_country text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','used')),
  code_hash text UNIQUE,
  grant_id text REFERENCES bane_resource_grants ON DELETE CASCADE,
  interval_seconds integer NOT NULL DEFAULT 5,
  polled_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (flow = 'code' AND redirect_uri IS NOT NULL AND code_challenge IS NOT NULL OR flow = 'device' AND device_hash IS NOT NULL AND user_code IS NOT NULL)
);
CREATE INDEX bane_oauth_requests_expiry ON bane_oauth_requests(expires_at);
CREATE INDEX bane_oauth_requests_grant ON bane_oauth_requests(grant_id);

-- Bane's access tokens (5 minutes) and MCP keys, stored as SHA-256 hashes.
CREATE TABLE bane_oauth_tokens (
  hash text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('access','key')),
  grant_id text NOT NULL REFERENCES bane_resource_grants ON DELETE CASCADE,
  client_id text NOT NULL,
  scopes text[] NOT NULL,
  jkt text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bane_oauth_tokens_grant ON bane_oauth_tokens(grant_id);
CREATE INDEX bane_oauth_tokens_expiry ON bane_oauth_tokens(expires_at);
-- One refresh token chain per approval. A refresh token is bane_rt_<family><secret>. The chain's current token rotates
-- it; the previous one, within a minute of its rotation, returns the same new pair again (encrypted in replay until
-- then), for a client that lost the response or refreshed twice at once; any other token of the chain is a reuse and
-- ends the approval. One row per chain keeps that check for the chain's whole life.
CREATE TABLE bane_oauth_refresh (
  family text PRIMARY KEY,
  grant_id text NOT NULL UNIQUE REFERENCES bane_resource_grants ON DELETE CASCADE,
  client_id text NOT NULL,
  scopes text[] NOT NULL,
  jkt text,
  current_hash text NOT NULL,
  previous_hash text,
  rotated_at timestamptz,
  replay text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bane_oauth_refresh_expiry ON bane_oauth_refresh(expires_at);
