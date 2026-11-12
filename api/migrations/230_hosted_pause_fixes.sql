SET LOCAL lock_timeout='2s';
-- Reputation quick fixes (api/README.md, Security boundaries):
-- 1. A resume restores a share of the limit for a while instead of restarting the sender's history.
-- 2. Bane records the SES tenant status it last applied, so the hourly check retries a pause or resume
--    whose UpdateReputationEntityCustomerManagedStatus call has not succeeded yet.
ALTER TABLE provider_connections
  ADD COLUMN restore_until timestamptz,
  ADD COLUMN restore_percent smallint CHECK (restore_percent BETWEEN 1 AND 100),
  ADD COLUMN tenant_status_applied text CHECK (tenant_status_applied IN ('ENABLED','DISABLED'));

CREATE OR REPLACE VIEW hosted_admission_policy AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override,w.exempt_hosted_quotas,pc.restore_until,pc.restore_percent
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared' FOR SHARE OF pc,w;
CREATE OR REPLACE VIEW hosted_admission_policy_read AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override,w.exempt_hosted_quotas,pc.restore_until,pc.restore_percent
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared';

-- A resume keeps the sender's history: the age and the accepted volume of every epoch count towards the limit.
-- Only bounces and complaints from before the last resume, which an operator reviewed, are forgiven.
CREATE OR REPLACE FUNCTION hosted_history_tier(wid text) RETURNS int LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN accepted>=100 AND bounces < accepted*.02 AND complaints < accepted*.0005 THEN
   CASE WHEN accepted>=1000 AND created_at<=now()-interval '14 days' THEN 3 WHEN created_at<=now()-interval '7 days' THEN 2 ELSE 1 END ELSE 1 END
 FROM provider_connections c CROSS JOIN LATERAL (
   SELECT coalesce(sum(h.accepted) FILTER(WHERE h.hour<=now()-interval '1 day'),0) AS accepted,
     coalesce(sum(h.bounces) FILTER(WHERE h.epoch=coalesce(c.resumed_at,'-infinity')),0) AS bounces,
     coalesce(sum(h.complaints) FILTER(WHERE h.epoch=coalesce(c.resumed_at,'-infinity')),0) AS complaints
   FROM hosted_health_hourly h WHERE h.workspace_id=wid AND h.hour BETWEEN now()-interval '30 days' AND now()) history
 WHERE c.workspace_id=wid AND c.kind='shared'
$$;

-- Unchanged from 101 except the restore: for restore_until after a resume, the history cap is restore_percent of
-- itself, and nextCap/nextCapAt say when the full cap returns. An operator override is used as set.
CREATE OR REPLACE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,CASE WHEN NOT p.exempt_hosted_quotas AND p.send_cap_override IS NULL THEN w.quota_sponsor END AS sponsor,
     CASE WHEN p.send_cap_override IS NULL AND NOT p.exempt_hosted_quotas AND p.restore_until>now() THEN p.restore_until END AS restored_until,
     CASE WHEN NOT p.exempt_hosted_quotas THEN CASE hosted_history_tier(wid) WHEN 3 THEN mature WHEN 2 THEN second_week ELSE first_week END END AS full_cap
   FROM hosted_admission_policy_read p JOIN workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=wid
 ), capped AS (
   SELECT p.*,coalesce(p.send_cap_override,CASE WHEN p.restored_until IS NOT NULL THEN greatest(1,p.full_cap*p.restore_percent/100) ELSE p.full_cap END) AS cap FROM policy p
 ), siblings AS (
   SELECT wid AS id UNION ALL SELECT w.id FROM workspaces w WHERE w.id<>wid AND w.quota_sponsor=(SELECT sponsor FROM capped) AND w.send_cap_override IS NULL AND NOT w.exempt_hosted_quotas
 ), hours AS (
   SELECT h.hour,sum(h.recipients) AS recipients FROM siblings s JOIN hosted_usage_hourly h ON h.workspace_id=s.id
   WHERE incoming>0 AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND h.recipients>0 GROUP BY h.hour
 ), usage AS (SELECT hour,sum(recipients) OVER(ORDER BY hour DESC) AS running FROM hours)
 SELECT jsonb_build_object('cap',p.cap,'marketingCap',m.cap,'used',u.used,'resetAt',u.reset,
   'nextChangeAt',least(p.restored_until,coalesce(u.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),
   'pauseReason',p.pause_reason,'pendingCapOverride',p.pending_cap_override,'exemptHostedQuotas',p.exempt_hosted_quotas,
   'nextCap',CASE WHEN p.restored_until IS NOT NULL THEN p.full_cap END,'nextCapAt',p.restored_until)
 FROM capped p CROSS JOIN LATERAL (SELECT p.cap-ceil(p.cap*headroom/100)::int AS cap) m CROSS JOIN LATERAL (
   SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
     max(hour) FILTER(WHERE running+least(incoming,p.cap)>p.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS reset FROM usage) u
$$;

-- 3. A content-screen rejection counts against the limit like a send: rejected spam is not a free retry.
-- Other rejections (rendering, validation) are still refunded.
CREATE FUNCTION hosted_charged(status text, provider_id text, error_code text) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT hosted_charged(status,provider_id) OR (status='rejected' AND error_code IS NOT DISTINCT FROM 'CONTENT_REJECTED_SPAM')
$$;
CREATE OR REPLACE FUNCTION hosted_adjust_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT CASE WHEN NEW.charge_simulator THEN jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses) ELSE e.cost END INTO n
    FROM hosted_real_envelopes e WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO hosted_usage_hourly AS u SELECT NEW.workspace_id,h,sum(delta) FROM (VALUES
    (date_trunc('hour',OLD.created_at,'UTC'),-n*hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)::int),
    (date_trunc('hour',NEW.created_at,'UTC'), n*hosted_charged(NEW.status,NEW.provider_id,NEW.error_code)::int)) d(h,delta)
    WHERE h >= date_trunc('hour',now(),'UTC')-interval '23 hours' GROUP BY h HAVING sum(delta)<>0 ORDER BY h
    ON CONFLICT (workspace_id,hour) DO UPDATE SET recipients=u.recipients+excluded.recipients;
  RETURN NULL;
END $$;
DROP TRIGGER hosted_adjust ON sending_emails;
CREATE TRIGGER hosted_adjust AFTER UPDATE OF status,provider_id,created_at,error_code ON sending_emails FOR EACH ROW
  WHEN (NOT NEW.simulated AND (hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)<>hosted_charged(NEW.status,NEW.provider_id,NEW.error_code) OR OLD.created_at<>NEW.created_at))
  EXECUTE FUNCTION hosted_adjust_usage();
