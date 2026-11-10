-- Hosted sign-up is invite-only. A Google-verified identity outside AUTH_ALLOWED_EMAILS/DOMAINS that tries to
-- sign up is told so and kept here, so operators can invite it. Holds no workspace data. Bounded: one row per
-- identity, at most 10,000 rows (google-auth.ts), pruned 90 days after the last request (maintenance.ts).
CREATE TABLE access_requests (
  email text PRIMARY KEY CHECK (length(email) <= 320),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  hosted_domain text CHECK (length(hosted_domain) <= 253),
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
CREATE INDEX access_requests_retire ON access_requests(last_requested_at);

-- Unchanged from 082 except nextCap/nextCapAt: the next step of the new-sender schedule, so GET /v1/me and a
-- 429 SEND_LIMIT_REACHED can say what the limit becomes and when. Null with an override, an exemption or the mature cap.
CREATE OR REPLACE FUNCTION hosted_allowance(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE (allowance jsonb) LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('cap',c.cap,'marketingCap',m.cap,'used',usage.used,'resetAt',least(usage.next_expiry,c.next_tier),
    'nextChangeAt',least(c.next_tier,coalesce(usage.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),
    'pauseReason',c.pause_reason,'pendingCapOverride',c.pending_cap_override,'exemptHostedQuotas',c.exempt_hosted_quotas,
    'nextCap',CASE WHEN c.next_tier IS NULL THEN NULL WHEN c.created_at>now()-interval '7 days' THEN second_week ELSE mature END,'nextCapAt',c.next_tier)
  FROM (SELECT p.*,coalesce(send_cap_override,CASE WHEN exempt_hosted_quotas THEN NULL WHEN created_at>now()-interval '7 days' THEN first_week WHEN created_at>now()-interval '14 days' THEN second_week ELSE mature END) AS cap,
    CASE WHEN send_cap_override IS NOT NULL OR exempt_hosted_quotas THEN NULL WHEN created_at>now()-interval '7 days' THEN created_at+interval '7 days' WHEN created_at>now()-interval '14 days' THEN created_at+interval '14 days' END AS next_tier
    FROM hosted_admission_policy p WHERE p.workspace_id=wid) c
  CROSS JOIN LATERAL (SELECT c.cap-ceil(c.cap*headroom::numeric/100)::int AS cap) m
  CROSS JOIN LATERAL (SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
    max(hour) FILTER (WHERE running+least(incoming,c.cap)>c.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS next_expiry FROM (
    SELECT hour,sum(recipients) OVER (ORDER BY hour DESC) AS running FROM hosted_usage_hourly WHERE workspace_id=c.workspace_id
      AND hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND recipients>0
      AND incoming>0 AND c.pause_reason IS NULL) charged) usage
$$;

-- GET /v1/public/stats is materialized by the minute cron (public-stats.ts) and served from public_stats alone, so a
-- request never reads sending_emails (O-H1). One bucket per creation minute, 30 days; each refresh recomputes only
-- recent minutes. `workspaces` holds at most 10 sender IDs per minute: enough to apply the privacy floor, never published.
CREATE TABLE public_stats_minutes (
  minute timestamptz PRIMARY KEY,
  accepted integer NOT NULL, delivered integer NOT NULL, bounced integer NOT NULL,
  regions text[] NOT NULL, workspaces text[] NOT NULL,
  computed_at timestamptz NOT NULL
);
CREATE TABLE public_stats (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  stats jsonb NOT NULL,
  generated_at timestamptz NOT NULL
);

-- GET /v1/me shows the Hosted allowance without row locks (O-L4). Admission keeps hosted_allowance, whose policy view
-- locks the connection and workspace rows FOR SHARE; this is the same body over the same policy, read without locks.
-- Keep the two bodies identical (the acceptance suite compares their results).
CREATE VIEW hosted_admission_policy_read AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override,w.exempt_hosted_quotas
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared';
CREATE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE (allowance jsonb) LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('cap',c.cap,'marketingCap',m.cap,'used',usage.used,'resetAt',least(usage.next_expiry,c.next_tier),
    'nextChangeAt',least(c.next_tier,coalesce(usage.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),
    'pauseReason',c.pause_reason,'pendingCapOverride',c.pending_cap_override,'exemptHostedQuotas',c.exempt_hosted_quotas,
    'nextCap',CASE WHEN c.next_tier IS NULL THEN NULL WHEN c.created_at>now()-interval '7 days' THEN second_week ELSE mature END,'nextCapAt',c.next_tier)
  FROM (SELECT p.*,coalesce(send_cap_override,CASE WHEN exempt_hosted_quotas THEN NULL WHEN created_at>now()-interval '7 days' THEN first_week WHEN created_at>now()-interval '14 days' THEN second_week ELSE mature END) AS cap,
    CASE WHEN send_cap_override IS NOT NULL OR exempt_hosted_quotas THEN NULL WHEN created_at>now()-interval '7 days' THEN created_at+interval '7 days' WHEN created_at>now()-interval '14 days' THEN created_at+interval '14 days' END AS next_tier
    FROM hosted_admission_policy_read p WHERE p.workspace_id=wid) c
  CROSS JOIN LATERAL (SELECT c.cap-ceil(c.cap*headroom::numeric/100)::int AS cap) m
  CROSS JOIN LATERAL (SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
    max(hour) FILTER (WHERE running+least(incoming,c.cap)>c.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS next_expiry FROM (
    SELECT hour,sum(recipients) OVER (ORDER BY hour DESC) AS running FROM hosted_usage_hourly WHERE workspace_id=c.workspace_id
      AND hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND recipients>0
      AND incoming>0 AND c.pause_reason IS NULL) charged) usage
$$;
