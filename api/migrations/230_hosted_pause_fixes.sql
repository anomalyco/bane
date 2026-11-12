SET LOCAL lock_timeout='2s';
-- Reputation quick fixes (api/README.md, Security boundaries):
-- 1. Two holds: a pause stops all mail (complaints, the spam screen); a marketing hold (bounces only) refuses
--    marketing and pauses campaigns while transactional mail keeps flowing.
-- 2. A resume keeps the reputation history and restores min(current limit, its percentage of the limit before the
--    resume) for 48 hours, as an absolute cap that a second resume cannot raise.
-- 3. Bane is the source of truth for the SES tenant status: every pause and resume bumps a generation, each regional
--    tenant records what was applied at which generation, and a resume holds sending until the tenants it disabled
--    are enabled again.
-- 4. Content-screen verdicts are counted when the screen runs (dispatch), by the epoch then current.
ALTER TABLE provider_connections
  ADD COLUMN restore_until timestamptz,
  ADD COLUMN restore_cap int CHECK (restore_cap > 0),
  ADD COLUMN marketing_held_at timestamptz,
  ADD COLUMN marketing_hold_reason text,
  ADD COLUMN tenant_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN resume_pending_at timestamptz;
CREATE TABLE hosted_tenant_status (
  connection_id text NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE, region text NOT NULL,
  applied text NOT NULL CHECK (applied IN ('ENABLED','DISABLED')), generation bigint NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, region));
CREATE TABLE hosted_screen_hourly (workspace_id text NOT NULL, epoch timestamptz NOT NULL, hour timestamptz NOT NULL,
  screened int NOT NULL DEFAULT 0, rejected int NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, epoch, hour));

CREATE OR REPLACE VIEW hosted_admission_policy AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override,w.exempt_hosted_quotas,pc.restore_until,pc.restore_cap,pc.marketing_held_at,pc.marketing_hold_reason
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared' FOR SHARE OF pc,w;
CREATE OR REPLACE VIEW hosted_admission_policy_read AS
  SELECT pc.workspace_id,pc.created_at,pc.pause_reason,w.send_cap_override,w.pending_cap_override,w.exempt_hosted_quotas,pc.restore_until,pc.restore_cap,pc.marketing_held_at,pc.marketing_hold_reason
  FROM provider_connections pc JOIN workspaces w ON w.id=pc.workspace_id WHERE pc.kind='shared';

-- The limit's history spans every epoch and keeps every outcome: a resume (a new evidence epoch for the pause check)
-- never forgives the bounces and complaints that decide the tier.
CREATE OR REPLACE FUNCTION hosted_history_tier(wid text) RETURNS int LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN accepted>=100 AND bounces < accepted*.02 AND complaints < accepted*.0005 THEN
   CASE WHEN accepted>=1000 AND created_at<=now()-interval '14 days' THEN 3 WHEN created_at<=now()-interval '7 days' THEN 2 ELSE 1 END ELSE 1 END
 FROM provider_connections c CROSS JOIN LATERAL (
   SELECT coalesce(sum(h.accepted) FILTER(WHERE h.hour<=now()-interval '1 day'),0) AS accepted,coalesce(sum(h.bounces),0) AS bounces,coalesce(sum(h.complaints),0) AS complaints
   FROM hosted_health_hourly h WHERE h.workspace_id=wid AND h.hour BETWEEN now()-interval '30 days' AND now()) history
 WHERE c.workspace_id=wid AND c.kind='shared'
$$;
-- The limit before any resume restore: an operator override, nothing when exempt, else the earned tier.
CREATE FUNCTION hosted_base_cap(wid text,first_week int,second_week int,mature int) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce(w.send_cap_override,CASE WHEN NOT w.exempt_hosted_quotas THEN CASE hosted_history_tier(wid) WHEN 3 THEN mature WHEN 2 THEN second_week ELSE first_week END END)
  FROM workspaces w WHERE w.id=wid
$$;

-- Unchanged from 101 except: the cap is min(base, restore_cap) until restore_until (nextCap/nextCapAt say when the
-- rest returns), and a marketing hold is reported (assertHostedAllowance refuses marketing with 409 MARKETING_HELD).
CREATE OR REPLACE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,CASE WHEN NOT p.exempt_hosted_quotas AND p.send_cap_override IS NULL THEN w.quota_sponsor END AS sponsor,
     hosted_base_cap(wid,first_week,second_week,mature) AS base_cap
   FROM hosted_admission_policy_read p JOIN workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=wid
 ), capped AS (
   SELECT p.*,CASE WHEN p.base_cap IS NOT NULL AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN p.restore_until END AS restored_until,
     CASE WHEN p.base_cap IS NOT NULL AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN least(p.base_cap,p.restore_cap) ELSE p.base_cap END AS cap FROM policy p
 ), siblings AS (
   SELECT wid AS id UNION ALL SELECT w.id FROM workspaces w WHERE w.id<>wid AND w.quota_sponsor=(SELECT sponsor FROM capped) AND w.send_cap_override IS NULL AND NOT w.exempt_hosted_quotas
 ), hours AS (
   SELECT h.hour,sum(h.recipients) AS recipients FROM siblings s JOIN hosted_usage_hourly h ON h.workspace_id=s.id
   WHERE incoming>0 AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND h.recipients>0 GROUP BY h.hour
 ), usage AS (SELECT hour,sum(recipients) OVER(ORDER BY hour DESC) AS running FROM hours)
 SELECT jsonb_build_object('cap',p.cap,'marketingCap',m.cap,'used',u.used,'resetAt',u.reset,
   'nextChangeAt',least(p.restored_until,coalesce(u.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),
   'pauseReason',p.pause_reason,'pendingCapOverride',p.pending_cap_override,'exemptHostedQuotas',p.exempt_hosted_quotas,
   'nextCap',CASE WHEN p.restored_until IS NOT NULL AND p.base_cap>p.cap THEN p.base_cap END,'nextCapAt',CASE WHEN p.restored_until IS NOT NULL AND p.base_cap>p.cap THEN p.restored_until END,
   'marketingHeld',p.marketing_held_at IS NOT NULL,'marketingHoldReason',p.marketing_hold_reason)
 FROM capped p CROSS JOIN LATERAL (SELECT p.cap-ceil(p.cap*headroom/100)::int AS cap) m CROSS JOIN LATERAL (
   SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
     max(hour) FILTER(WHERE running+least(incoming,p.cap)>p.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS reset FROM usage) u
$$;

-- Unchanged from 110 except: marketing is refused while held (the report says why: assertHostedAllowance, MARKETING_HELD).
CREATE OR REPLACE FUNCTION key_admission_decision(wid text,kid text,domains jsonb,path text,idem text,hash text,receipt jsonb,
  wanted jsonb,asset_ids jsonb,sim boolean,cost int,marketing int,first_week int,second_week int,mature int,
  headroom numeric,regional boolean,trusted boolean,require_dmarc boolean,valid_content boolean,platform jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE s jsonb; h jsonb; m jsonb; r jsonb; c jsonb; facts jsonb; obs jsonb; ses jsonb; reg text; host text;
  ok boolean; invalid_mime boolean:=false; rows_ok boolean; cap int; bulk jsonb;
BEGIN
  s:=direct_admission_state(wid,kid,path,idem,hash,receipt,wanted,asset_ids,sim,cost,marketing,first_week,second_week,mature,headroom);
  IF s ? 'previous' THEN RETURN s; END IF;
  IF regional THEN
    SELECT s||jsonb_build_object('routes',coalesce(jsonb_object_agg(k.host,to_jsonb(route)),'{}'::jsonb),
      'quota',(SELECT max(l.max_24_hour_send) FROM regional_workspace_limits l JOIN provider_connections pc USING(workspace_id) WHERE l.workspace_id=wid AND pc.kind='byo')) INTO s
    FROM (SELECT DISTINCT x->>'host' host FROM jsonb_array_elements(wanted) x) k CROSS JOIN LATERAL regional_sender(wid,k.host,sim,platform) route;
  END IF;
  h:=s->'hosted'; cap:=coalesce((h->>'pendingCapOverride')::int,CASE WHEN (h->>'exemptHostedQuotas')::boolean THEN 200000 END,
    CASE WHEN jsonb_typeof(h)='object' THEN 10000 ELSE least(200000,greatest(10000,floor((s->>'quota')::numeric)))::int END);
  ok:=valid_content AND s->>'default_region' IS NOT NULL AND (s->>'projected')::int<=cap AND h->>'pauseReason' IS NULL AND
    (marketing=0 OR NOT coalesce((h->>'marketingHeld')::boolean,false)) AND (cost=0 OR h->>'cap' IS NULL OR ((h->>'used')::bigint+cost<=(h->>'cap')::int AND (marketing=0 OR (h->>'used')::bigint+marketing<=(h->>'marketingCap')::int)));
  IF jsonb_array_length(asset_ids)>0 THEN
    SELECT EXISTS(SELECT FROM sending_attachments a WHERE a.workspace_id=wid AND a.id IN (SELECT jsonb_array_elements_text(asset_ids))
      AND (length(a.content_type)>78 OR a.content_type ~ '[^ -~]' OR length(a.content_id)>78)) INTO invalid_mime;
    ok:=ok AND NOT invalid_mime;
  END IF;
  IF require_dmarc AND (EXISTS(SELECT FROM jsonb_array_elements(wanted) x WHERE x->>'kind'='marketing') OR (cost>0 AND (h->>'used')::bigint+cost>=5000)) THEN
    SELECT jsonb_object_agg(dc.name,dc.identity-'mx'-'note') INTO bulk FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.sending_state IN ('verified','lost') AND dc.name IN (SELECT x->>'host' FROM jsonb_array_elements(wanted) x);
  END IF;
  FOR m IN SELECT * FROM jsonb_array_elements(wanted) LOOP
    host:=m->>'host'; r:=s->'routes'->host;
    ok:=ok AND (domains='[]' OR EXISTS(SELECT FROM jsonb_array_elements_text(domains) d WHERE host=lower(d) OR right(host,length(d)+1)='.'||lower(d)));
    IF regional THEN
      reg:=r->>'region'; c:=r->'connection';
      ok:=ok AND (r->>'verified')::boolean AND (m->>'region' IS NULL OR m->>'region'=reg) AND c->>'pause_reason' IS NULL
        AND (trusted OR c->>'pool_tier' IS DISTINCT FROM 'trusted' OR nullif(c->>'pool_tenant_name','') IS NULL);
    ELSE
      reg:=coalesce(m->>'region',s->>'default_region'); c:=s->'connection';
      ok:=ok AND (s->'enabled_regions') ? reg AND (s->'verified') ? (host||':'||reg) AND c->>'region'=reg;
    END IF;
    ok:=ok AND c->>'kind' IN ('shared','byo') AND (sim OR c->>'kind'='byo' OR c->>'tenant_state'='ready');
    IF require_dmarc AND c->>'kind'='shared' AND (m->>'kind'='marketing' OR (cost>0 AND (h->>'used')::bigint+cost>=5000)) THEN
      facts:=bulk->host; obs:=facts->'dmarc'; ses:=facts->'ses';
      ok:=ok AND obs->>'status' IN ('none','quarantine','reject') AND (obs->>'checkedAt')::numeric>=extract(epoch FROM clock_timestamp()-interval '48 hours')*1000 AND
        ((ses#>'{DkimAttributes,SigningEnabled}'='true'::jsonb AND ses#>>'{DkimAttributes,Status}'='SUCCESS') IS TRUE OR
          (nullif(obs->>'alignedMailFrom','')=lower(rtrim(ses#>>'{MailFromAttributes,MailFromDomain}','.')) AND ses#>>'{MailFromAttributes,MailFromDomainStatus}'='SUCCESS') IS TRUE);
    END IF;
    IF jsonb_array_length(m->'attachments')>0 THEN
      SELECT count(*)=jsonb_array_length(m->'attachments') AND sum(a.size)<=8388608 AND count(a.cid)=count(DISTINCT a.cid)
        AND ceil((m->>'bodyBytes')::numeric*1.4)+sum(ceil(a.size::numeric/3)*4*1.04+2048)+16384<=16777216 INTO rows_ok
        FROM (SELECT (v->>'size')::int size,v->>'contentId' cid FROM jsonb_array_elements(coalesce(nullif(s->'assets','null'::jsonb),'[]'::jsonb)) v WHERE m->'attachments' ? (v->>'id')) a;
      ok:=ok AND rows_ok;
    END IF;
  END LOOP;
  IF ok IS NOT TRUE THEN
    IF idem IS NOT NULL THEN
      DELETE FROM sending_idempotency i WHERE i.workspace_id=wid AND i.actor_key_id=kid AND i.path=key_admission_decision.path AND i.request_key=idem;
    END IF;
    RETURN s||jsonb_build_object('allowed',false,'invalidMime',invalid_mime,'bulk',bulk);
  END IF;
  RETURN s||jsonb_build_object('allowed',true);
END $$;

-- A content-screen rejection counts against the limit like a send: rejected spam is not a free retry.
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
