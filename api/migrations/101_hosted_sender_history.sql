SET LOCAL lock_timeout='2s';
-- Sponsorship stays with the approved creator even if ownership is transferred.
-- For existing tenants the earliest remaining owner is the best available record.
ALTER TABLE workspaces ADD COLUMN quota_sponsor text;
UPDATE workspaces w SET quota_sponsor=(SELECT m.user_id FROM workspace_members m WHERE m.workspace_id=w.id AND role='owner' ORDER BY created_at,id LIMIT 1);
CREATE TABLE hosted_sponsor_locks(sponsor text PRIMARY KEY);

-- Only real SES acceptances (not queued, simulated, or simulator destinations)
-- in this resume epoch count. Give feedback at least a day to catch up.
CREATE FUNCTION hosted_history_tier(wid text) RETURNS int LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN accepted>=100 AND bounces < accepted*.02 AND complaints < accepted*.0005 THEN
   CASE WHEN accepted>=1000 AND created_at<=now()-interval '14 days' THEN 3 WHEN created_at<=now()-interval '7 days' THEN 2 ELSE 1 END ELSE 1 END
 FROM provider_connections c CROSS JOIN LATERAL (
   SELECT sum(h.accepted) FILTER(WHERE h.hour<=now()-interval '1 day') AS accepted,sum(h.bounces) AS bounces,sum(h.complaints) AS complaints
   FROM hosted_health_hourly h WHERE h.workspace_id=wid AND h.epoch=coalesce(c.resumed_at,'-infinity') AND h.hour BETWEEN now()-interval '30 days' AND now()) history
 WHERE c.workspace_id=wid AND c.kind='shared'
$$;
CREATE FUNCTION hosted_allowance_snapshot(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric,sponsor text)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,coalesce(p.send_cap_override,CASE WHEN NOT p.exempt_hosted_quotas THEN
     CASE hosted_history_tier(wid) WHEN 3 THEN mature WHEN 2 THEN second_week ELSE first_week END END) AS cap
   FROM hosted_admission_policy p WHERE p.workspace_id=wid
 ), siblings AS (
   SELECT wid AS id UNION ALL SELECT w.id FROM workspaces w WHERE w.id<>wid AND w.quota_sponsor=sponsor AND w.send_cap_override IS NULL AND NOT w.exempt_hosted_quotas
 ), hours AS (
   SELECT h.hour,sum(h.recipients) AS recipients FROM siblings s JOIN hosted_usage_hourly h ON h.workspace_id=s.id
   WHERE incoming>0 AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND h.recipients>0 GROUP BY h.hour
 ), usage AS (SELECT hour,sum(recipients) OVER(ORDER BY hour DESC) AS running FROM hours)
 SELECT jsonb_build_object('cap',p.cap,'marketingCap',m.cap,'used',u.used,'resetAt',u.reset,'nextChangeAt',coalesce(u.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours'),
   'pauseReason',p.pause_reason,'pendingCapOverride',p.pending_cap_override,'exemptHostedQuotas',p.exempt_hosted_quotas,'nextCap',NULL,'nextCapAt',NULL)
 FROM policy p CROSS JOIN LATERAL (SELECT p.cap-ceil(p.cap*headroom/100)::int AS cap) m CROSS JOIN LATERAL (
   SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
     max(hour) FILTER(WHERE running+least(incoming,p.cap)>p.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS reset FROM usage) u
$$;
CREATE OR REPLACE FUNCTION hosted_allowance(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE plpgsql VOLATILE AS $$
DECLARE sponsor text;
BEGIN
 SELECT w.quota_sponsor INTO sponsor FROM workspaces w JOIN provider_connections pc ON pc.workspace_id=w.id AND pc.kind='shared'
 WHERE w.id=wid AND NOT w.exempt_hosted_quotas AND w.send_cap_override IS NULL;
 IF incoming>0 AND sponsor IS NOT NULL THEN
   -- Take the same transaction-scoped row lock across sibling workspaces; the
   -- following statement gets a fresh snapshot after any competing admission.
   INSERT INTO hosted_sponsor_locks AS l VALUES(sponsor) ON CONFLICT ON CONSTRAINT hosted_sponsor_locks_pkey DO UPDATE SET sponsor=l.sponsor WHERE false;
 END IF;
 RETURN QUERY SELECT s.allowance FROM hosted_allowance_snapshot(wid,incoming,marketing,first_week,second_week,mature,headroom,sponsor) s;
END $$;

CREATE FUNCTION hosted_minute_cap(wid text) RETURNS int LANGUAGE sql STABLE AS $$
 SELECT greatest(CASE hosted_history_tier(wid) WHEN 3 THEN 500 WHEN 2 THEN 100 ELSE 50 END,ceil(w.send_cap_override/1440.0)::int) FROM workspaces w WHERE w.id=wid
$$;
CREATE OR REPLACE FUNCTION hosted_burst_ok(wid text,domain_key text,cost int) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE cap int; tenant int; dom int; sponsor text; tick timestamptz:=date_trunc('minute',statement_timestamp());
BEGIN
 IF cost=0 THEN RETURN true; END IF;
 SELECT hosted_minute_cap(wid), CASE WHEN p.send_cap_override IS NULL THEN w.quota_sponsor END INTO cap,sponsor
 FROM hosted_admission_policy p JOIN workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=wid AND NOT p.exempt_hosted_quotas;
 IF NOT FOUND THEN RETURN true; END IF;
 INSERT INTO hosted_burst_windows VALUES(wid,'',tick,0) ON CONFLICT DO NOTHING;
 SELECT CASE WHEN minute=tick THEN used ELSE 0 END INTO tenant FROM hosted_burst_windows WHERE workspace_id=wid AND scope='' FOR UPDATE;
 SELECT used INTO dom FROM hosted_burst_windows WHERE workspace_id=wid AND scope=domain_key AND minute=tick;
 IF tenant+cost>cap OR coalesce(dom,0)+cost>greatest(50,cap/2) THEN RETURN false; END IF;
 IF sponsor IS NOT NULL THEN
   INSERT INTO hosted_burst_windows AS b VALUES(sponsor,'#sponsor',tick,cost) ON CONFLICT(workspace_id,scope) DO UPDATE SET
     minute=tick,used=cost+CASE WHEN b.minute=tick THEN b.used ELSE 0 END WHERE b.minute<>tick OR b.used+cost<=cap;
   IF NOT FOUND THEN RETURN false; END IF;
 END IF;
 UPDATE hosted_burst_windows SET used=tenant+cost,minute=tick WHERE workspace_id=wid AND scope='';
 INSERT INTO hosted_burst_windows VALUES(wid,domain_key,tick,coalesce(dom,0)+cost) ON CONFLICT(workspace_id,scope) DO UPDATE SET minute=tick,used=excluded.used;
 RETURN true;
END $$;
