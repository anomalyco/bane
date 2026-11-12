-- Support access (src/support.ts, api/README.md "Support integration"). Internal: customers never call these routes.
--
-- A handoff is what a signed-in member sends from the dashboard's "Contact support": the workspace, the user, the
-- page and recent request IDs, and whether they let support read message content for this one request. It opens at
-- most one grant (used_at, grant_id), within 30 minutes.
CREATE TABLE support_handoffs (
  id text PRIMARY KEY CHECK (id ~ '^sho_[0-9a-f]{32}$'),
  user_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('support','appeal','limit_request')),
  page text CHECK (length(page) <= 200),
  request_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(request_ids) <= 5),
  message text CHECK (length(message) <= 2000),
  share_content boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 minutes'),
  used_at timestamptz,
  grant_id text,
  CHECK ((used_at IS NULL) = (grant_id IS NULL))
);
CREATE INDEX support_handoffs_user ON support_handoffs (user_id, created_at DESC);

-- A grant is a short-lived, read-only bearer (bane_support_<64 hex>, stored as its SHA-256) that an operator mints for
-- one ticket, bound to one user and the workspaces they belonged to then (narrowed at use to those they still belong
-- to). It reads only /v1/support/*. Message content only through the customer's own in-app opt-in (the handoff), and
-- only in the workspace they pressed "Contact support" in (content_workspace_id).
CREATE TABLE support_grants (
  id text PRIMARY KEY CHECK (id ~ '^sgr_[0-9a-f]{32}$'),
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL,
  workspace_ids text[] NOT NULL CHECK (cardinality(workspace_ids) BETWEEN 1 AND 100),
  ticket_ref text NOT NULL CHECK (length(ticket_ref) BETWEEN 1 AND 200),
  verification text NOT NULL CHECK (verification IN ('handoff','dmarc','magic_link')),
  handoff_id text,
  content_workspace_id text,
  operator_id text NOT NULL,
  operator_via text NOT NULL CHECK (operator_via IN ('console','support')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  -- Requests in the current minute, for the per-grant rate limit (one UPDATE authenticates, counts and touches).
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  used integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '2 hours'),
  CHECK (content_workspace_id IS NULL OR (verification = 'handoff' AND handoff_id IS NOT NULL AND content_workspace_id = ANY(workspace_ids)))
);
-- One active grant per ticket. An expired grant is closed (revoked_at = expires_at) before a new one is minted.
CREATE UNIQUE INDEX support_grants_ticket ON support_grants (ticket_ref) WHERE revoked_at IS NULL;
CREATE INDEX support_grants_user ON support_grants (user_id, created_at DESC);
CREATE INDEX support_grants_expiry ON support_grants (expires_at) WHERE revoked_at IS NULL;

-- A customer sees "Bane support viewed this workspace" once per grant and workspace, not once per call.
CREATE UNIQUE INDEX audit_events_support_view ON audit_events (actor_id, workspace_id) WHERE action = 'support.view';
