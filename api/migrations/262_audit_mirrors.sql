-- Changes made in SQL by operator scripts, the operator API and Bane's own health checks reach the audit trail here,
-- in the statement that makes them, whatever the caller: no code path can skip its row.

-- 1. Every hosted_operator_audit row (operator scripts today, the operator API with #115) gets an internal audit row.
-- Read through to_jsonb(NEW) so the columns #111/#115 add (operator_id, via, reason, ticket_ref, request_id, before,
-- after) are carried when present. 'platform' rows (operator role grants) are user-level events.
CREATE FUNCTION audit_mirror_operator() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r jsonb := to_jsonb(NEW);
BEGIN
  INSERT INTO audit_events(at, workspace_id, user_id, actor_type, actor_id, via, action, target_type, target_id, summary, reason, ticket_ref, request_id, internal, retain_until)
  VALUES (coalesce((r->>'at')::timestamptz, now()), nullif(NEW.workspace_id, 'platform'), CASE WHEN NEW.workspace_id = 'platform' THEN NEW.details->>'userId' END,
    'operator', coalesce(r->>'operator_id', r->>'db_actor'), CASE r->>'via' WHEN 'console' THEN 'console' WHEN 'support' THEN 'support' ELSE 'script' END,
    'operator.' || coalesce(nullif(left(trim(BOTH '_' FROM regexp_replace(lower(NEW.action), '[^a-z]+', '_', 'g')), 50), ''), 'action'),
    CASE WHEN NEW.workspace_id = 'platform' THEN 'user' ELSE 'workspace' END, coalesce(nullif(NEW.workspace_id, 'platform'), NEW.details->>'userId'),
    (SELECT CASE WHEN octet_length(s::text) > 8000 THEN jsonb_build_object('truncated', true) ELSE s END
      FROM jsonb_strip_nulls(jsonb_build_object('details', NEW.details, 'before', r->'before', 'after', r->'after')) s),
    left(coalesce(r->>'reason', NEW.details->>'reason'), 1000), left(r->>'ticket_ref', 200), left(r->>'request_id', 64), true, now() + interval '1 year');
  RETURN NULL;
END $$;
CREATE TRIGGER audit_mirror_operator AFTER INSERT ON hosted_operator_audit FOR EACH ROW
  WHEN (NEW.workspace_id <> 'platform' OR NEW.details ->> 'userId' IS NOT NULL) EXECUTE FUNCTION audit_mirror_operator();

-- The operator actions recorded before this migration, once.
INSERT INTO audit_events(at, workspace_id, actor_type, actor_id, via, action, target_type, target_id, summary, internal, retain_until)
SELECT o.at, o.workspace_id, 'operator', o.db_actor, 'script', 'operator.' || coalesce(nullif(left(trim(BOTH '_' FROM regexp_replace(lower(o.action), '[^a-z]+', '_', 'g')), 50), ''), 'action'),
  'workspace', o.workspace_id, CASE WHEN octet_length(o.details::text) > 8000 THEN jsonb_build_object('truncated', true) ELSE jsonb_build_object('details', o.details) END,
  true, greatest(o.at + interval '1 year', now() + interval '1 day')
FROM hosted_operator_audit o WHERE o.workspace_id <> 'platform';

-- 2. A hosted sending pause or resume, by Bane's health checks, an operator script or the standing ladder. Visible to
-- the customer: they see the pause in the dashboard anyway, and this says when and why.
CREATE FUNCTION audit_mirror_sending_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events(workspace_id, actor_type, via, action, target_type, target_id, summary, internal, retain_until)
  VALUES (NEW.workspace_id, 'system', 'job', CASE WHEN NEW.paused_at IS NULL THEN 'sending.resume' ELSE 'sending.pause' END, 'connection', NEW.id,
    jsonb_strip_nulls(jsonb_build_object('kind', NEW.kind, 'reason', left(to_jsonb(NEW)->>'pause_reason', 200), 'previousReason', CASE WHEN NEW.paused_at IS NULL THEN left(to_jsonb(OLD)->>'pause_reason', 200) END)),
    false, now() + interval '1 year');
  RETURN NULL;
END $$;
CREATE TRIGGER audit_mirror_sending_pause AFTER UPDATE OF paused_at ON provider_connections FOR EACH ROW
  WHEN ((OLD.paused_at IS NULL) <> (NEW.paused_at IS NULL)) EXECUTE FUNCTION audit_mirror_sending_pause();

-- 3. Hosted limit overrides and quota exemptions (operator scripts, the operator API). Internal.
CREATE FUNCTION audit_mirror_limits() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events(workspace_id, actor_type, via, action, target_type, target_id, summary, internal, retain_until)
  VALUES (NEW.id, 'system', 'script', 'limit.override', 'workspace', NEW.id,
    jsonb_build_object('before', jsonb_build_object('daily', OLD.send_cap_override, 'pending', OLD.pending_cap_override, 'exempt', OLD.exempt_hosted_quotas),
      'after', jsonb_build_object('daily', NEW.send_cap_override, 'pending', NEW.pending_cap_override, 'exempt', NEW.exempt_hosted_quotas)),
    true, now() + interval '1 year');
  RETURN NULL;
END $$;
CREATE TRIGGER audit_mirror_limits AFTER UPDATE OF send_cap_override, pending_cap_override, exempt_hosted_quotas ON workspaces FOR EACH ROW
  WHEN (OLD.send_cap_override IS DISTINCT FROM NEW.send_cap_override OR OLD.pending_cap_override IS DISTINCT FROM NEW.pending_cap_override
    OR OLD.exempt_hosted_quotas IS DISTINCT FROM NEW.exempt_hosted_quotas) EXECUTE FUNCTION audit_mirror_limits();
