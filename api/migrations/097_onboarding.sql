-- Hosted sign-up is invite-only. A Google-verified identity outside AUTH_ALLOWED_EMAILS/DOMAINS that tries to
-- sign up is told so and kept here, so operators can invite it. Holds no workspace data.
CREATE TABLE access_requests (
  email text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  hosted_domain text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);

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
