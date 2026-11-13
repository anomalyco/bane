-- One append-only audit trail per account: who did what to which workspace or user, when, through what and why.
-- Support reads it through the operator API; owners and admins read their own workspace's customer-visible rows
-- (Settings → Activity). Writers call recordAudit() (src/audit.ts) inside the transaction or statement that makes
-- the change, so a change and its audit row commit together. Send admission never writes here: sending activity is
-- in the sending logs.
--
-- Never secrets, never message content: summaries hold IDs, names, roles, scopes and changed field names only
-- (redacted again in src/audit.ts). The client address is reduced to its /24 (IPv4) or /48 (IPv6) network and the
-- user agent to a product family.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  -- The workspace the event belongs to; null for account-level events (sign-in, a support grant spanning workspaces).
  workspace_id text,
  -- The person the event concerns, for the per-user trail: the member who acted, or the subject of an operator action.
  user_id text,
  actor_type text NOT NULL CHECK (actor_type IN ('member','api_key','mcp_grant','agent_token','inbox_key','app_password','operator','support','system','stripe')),
  actor_id text,
  -- A short, non-secret label for display: a key name and prefix, a client name. Never an email address.
  actor_label text CHECK (length(actor_label) <= 120),
  via text NOT NULL CHECK (via IN ('dashboard','api','mcp','imap','smtp','console','support','script','job','webhook')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' AND length(action) <= 64),
  target_type text CHECK (length(target_type) <= 40),
  target_id text CHECK (length(target_id) <= 200),
  -- {before, after, ...}: redacted and at most 8 KiB.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object' AND octet_length(summary::text) <= 8192),
  reason text CHECK (length(reason) <= 1000),
  ticket_ref text CHECK (length(ticket_ref) <= 200),
  request_id text CHECK (length(request_id) <= 64),
  ip_network text CHECK (length(ip_network) <= 64),
  user_agent text CHECK (length(user_agent) <= 80),
  -- Operator, support and system rows are hidden from the customer Activity view, except the ones written for it.
  internal boolean NOT NULL DEFAULT false,
  -- Retention (src/audit.ts RETENTION): 1 year by default, 7 years for billing, 90 days for per-call support reads.
  retain_until timestamptz NOT NULL,
  CHECK (workspace_id IS NOT NULL OR user_id IS NOT NULL),
  CHECK (retain_until > at)
);
-- The three readers: a workspace's trail, a user's trail and an actor's trail, newest first, paged by (at, id).
CREATE INDEX audit_events_workspace ON audit_events (workspace_id, at DESC, id DESC) WHERE workspace_id IS NOT NULL;
CREATE INDEX audit_events_user ON audit_events (user_id, at DESC, id DESC) WHERE user_id IS NOT NULL;
CREATE INDEX audit_events_actor ON audit_events (actor_type, actor_id, at DESC);
CREATE INDEX audit_events_request ON audit_events (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX audit_events_expiry ON audit_events (retain_until);

-- Append-only, enforced in SQL whatever the caller's privileges: a row never changes, and it is deleted only by
-- the retention purge once retain_until has passed. TRUNCATE is refused outright.
CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.retain_until <= now() THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only (%)', TG_OP USING ERRCODE = 'BA001';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_early_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
-- No role but the owner holds a grant; the owner keeps INSERT, SELECT and DELETE (the purge) but not UPDATE or TRUNCATE.
REVOKE ALL ON audit_events FROM PUBLIC;
REVOKE UPDATE, TRUNCATE ON audit_events FROM CURRENT_USER;
