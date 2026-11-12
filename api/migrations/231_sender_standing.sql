SET LOCAL lock_timeout='2s';
-- Sender standing (docs/sending-limits.md): one row per Hosted workspace with its score, daily limit and ladder step,
-- written by the ten-minute standing job (src/standing.ts). Admission reads the stored limit in its existing
-- statement, so the score now sets the limit instead of the connection's age.
CREATE TABLE sender_standing (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- seed: existed before this migration (the first run starts the score at its target, not at 65).
  phase text NOT NULL DEFAULT 'calibrating' CHECK (phase IN ('seed','calibrating','graded')),
  first_recipients int NOT NULL DEFAULT 0,
  calibrated_at timestamptz,
  score numeric(5,2), day_score numeric(5,2), score_day date,
  target numeric(5,2) NOT NULL DEFAULT 60, quality numeric(5,2) NOT NULL DEFAULT 60, volume double precision NOT NULL DEFAULT 0,
  factors jsonb NOT NULL DEFAULT '[]',
  band_limit int NOT NULL DEFAULT 100,
  daily_limit int NOT NULL DEFAULT 100 CHECK (daily_limit > 0),
  step text NOT NULL DEFAULT 'ok' CHECK (step IN ('ok','notice','warn','restrict','pause')),
  reasons jsonb NOT NULL DEFAULT '[]',
  since timestamptz NOT NULL DEFAULT now(),
  clear_since timestamptz,
  pause_kind text CHECK (pause_kind IN ('bounce','full')),
  -- An operator's marketing hold, independent of the ladder.
  marketing_hold boolean NOT NULL DEFAULT false,
  -- An owner's release of a restrict: marketing at release_percent of its allowance until release_until.
  release_until timestamptz, release_percent smallint CHECK (release_percent BETWEEN 1 AND 100),
  last_release_at timestamptz, last_self_resume_at timestamptz,
  -- A second strike within 90 days caps the limit at strike_percent until strike_until.
  strikes jsonb NOT NULL DEFAULT '[]', strike_until timestamptz,
  watch boolean NOT NULL DEFAULT false,
  notified jsonb NOT NULL DEFAULT '{}',
  evidence_at timestamptz, computed_at timestamptz,
  version int NOT NULL DEFAULT 1,
  sequence bigint NOT NULL DEFAULT 0
);
CREATE INDEX sender_standing_queue ON sender_standing(step, since) WHERE step<>'ok';

-- Daily evidence (counted from mail while it is retained, then frozen) and the published score for the card.
CREATE TABLE sender_score_daily (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, day date NOT NULL,
  emails int NOT NULL DEFAULT 0, accepted int NOT NULL DEFAULT 0, delivered int NOT NULL DEFAULT 0,
  bounced int NOT NULL DEFAULT 0, first_sends int NOT NULL DEFAULT 0, first_bounced int NOT NULL DEFAULT 0,
  complained int NOT NULL DEFAULT 0, screened int NOT NULL DEFAULT 0, rejected int NOT NULL DEFAULT 0, suppressed int NOT NULL DEFAULT 0,
  marketing_delivered int NOT NULL DEFAULT 0, unsubscribed int NOT NULL DEFAULT 0, clicked int NOT NULL DEFAULT 0,
  score numeric(5,2), quality numeric(5,2), target numeric(5,2), daily_limit int, step text,
  PRIMARY KEY (workspace_id, day)
);

-- Every change of standing: ladder steps, limit bands, quarantines, releases, operator actions and AWS tenant status.
-- Feeds account.standing.changed, owner emails and the operator timeline. sequence is per workspace and monotonic.
CREATE TABLE standing_events (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, sequence bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(), kind text NOT NULL,
  from_step text, to_step text, reasons jsonb NOT NULL DEFAULT '[]', actor jsonb NOT NULL, details jsonb NOT NULL DEFAULT '{}',
  UNIQUE (workspace_id, sequence)
);
CREATE INDEX standing_events_page ON standing_events(workspace_id, at DESC, id DESC);

-- Platform operators: Anomaly staff, never a workspace role. Granted only by scripts/set-operator.ts.
CREATE TABLE platform_operators (
  user_id text PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('operator','operator:read')),
  granted_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL
);
-- The operator API audits who, through what, why, the ticket and the before/after, in the mutation's transaction.
ALTER TABLE hosted_operator_audit ADD COLUMN operator_id text, ADD COLUMN via text, ADD COLUMN reason text, ADD COLUMN ticket_ref text,
  ADD COLUMN request_id text, ADD COLUMN before jsonb, ADD COLUMN after jsonb;
CREATE INDEX hosted_operator_audit_page ON hosted_operator_audit(workspace_id, at DESC);
CREATE INDEX hosted_operator_audit_operator ON hosted_operator_audit(operator_id, at DESC) WHERE operator_id IS NOT NULL;
CREATE TABLE operator_idempotency (operator_id text NOT NULL, key text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (operator_id, key));

-- An operator limit override can expire (then the score's limit applies again).
ALTER TABLE workspaces ADD COLUMN send_cap_override_expires_at timestamptz;

-- Campaign list probes: the first min(500, 10%) recipients (at least 100) go out, then release waits for their
-- feedback. A probe with too many bounces or complaints quarantines the campaign (paused, LIST_QUALITY).
ALTER TABLE sending_campaigns ADD COLUMN probe_wait_until timestamptz, ADD COLUMN probe_cleared_at timestamptz, ADD COLUMN quarantines smallint NOT NULL DEFAULT 0;
ALTER TABLE sending_campaigns DROP CONSTRAINT sending_campaigns_waiting_reason_check,
  ADD CHECK (waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota','list_probe'));

-- Health evidence split by stream, so a bounce-only problem can hold marketing and keep transactional mail flowing.
ALTER TABLE hosted_health_hourly ADD COLUMN marketing_accepted bigint NOT NULL DEFAULT 0, ADD COLUMN marketing_bounces bigint NOT NULL DEFAULT 0, ADD COLUMN marketing_complaints bigint NOT NULL DEFAULT 0;
ALTER TABLE hosted_health_credits ADD COLUMN marketing_accepted int NOT NULL DEFAULT 0, ADD COLUMN marketing_bounces int NOT NULL DEFAULT 0, ADD COLUMN marketing_complaints int NOT NULL DEFAULT 0;
CREATE OR REPLACE VIEW hosted_real_envelopes AS SELECT e.id,e.workspace_id,e.created_at,e.status,e.provider_id,
  hosted_real_cost(e.to_addresses || e.cc_addresses || e.bcc_addresses) AS cost,
  coalesce(e.snapshot->>'kind'='marketing' OR e.campaign_id IS NOT NULL,false) AS marketing
  FROM sending_emails e LEFT JOIN provider_connections pc USING(workspace_id)
  WHERE NOT e.simulated AND ((e.feedback_topic_arn IS NULL AND pc.kind='shared') OR EXISTS
    (SELECT FROM provider_feedback_history h WHERE h.topic_arn=e.feedback_topic_arn AND h.kind='shared'));
CREATE OR REPLACE VIEW hosted_health_projection AS WITH latest AS (
  SELECT v.workspace_id,v.email_id,coalesce(pc.resumed_at,'-infinity') AS epoch,e.cost,
    CASE WHEN v.type IN ('accepted','send') THEN 'accepted' ELSE v.type END kind,
    coalesce(h.hash,'') AS dest,max(v.created_at) AS at,bool_or(e.marketing) AS marketing
    FROM sending_email_events v JOIN hosted_real_envelopes e ON e.workspace_id=v.workspace_id AND e.id=v.email_id
    JOIN provider_connections pc ON pc.workspace_id=v.workspace_id AND pc.kind='shared'
    LEFT JOIN LATERAL unnest(v.recipient_hashes) h(hash) ON v.type IN ('bounce','complaint')
    WHERE NOT v.simulated AND e.cost>0 AND e.status<>'suppressed' AND v.created_at>coalesce(pc.resumed_at,'-infinity')
      AND v.created_at>=date_trunc('hour',now(),'UTC')-interval '47 hours'
      AND (v.type IN ('accepted','send','complaint') OR (v.type='bounce' AND v.data->>'bounceType'='Permanent'))
      AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes)>0)
    GROUP BY 1,2,3,4,5,6
), ranked AS (
  SELECT *,row_number() OVER (PARTITION BY workspace_id,email_id,kind ORDER BY (dest<>'') DESC,at DESC,dest) AS pos,
    max(at) FILTER(WHERE dest='') OVER (PARTITION BY workspace_id,email_id,kind) AS unknown_at FROM latest
), counted AS (SELECT workspace_id,email_id,epoch,date_trunc('hour',CASE WHEN pos=1 THEN greatest(at,unknown_at) ELSE at END,'UTC') AS hour,
  coalesce(sum(cost) FILTER(WHERE kind='accepted'),0)::int AS accepted,count(*) FILTER(WHERE kind='bounce')::int AS bounces,
  count(*) FILTER(WHERE kind='complaint')::int AS complaints,bool_or(marketing) AS marketing
  FROM ranked WHERE dest<>'' OR pos=1 GROUP BY 1,2,3,4)
SELECT workspace_id,email_id,epoch,hour,accepted,bounces,complaints,
  CASE WHEN marketing THEN accepted ELSE 0 END AS marketing_accepted,CASE WHEN marketing THEN bounces ELSE 0 END AS marketing_bounces,
  CASE WHEN marketing THEN complaints ELSE 0 END AS marketing_complaints FROM counted;
CREATE OR REPLACE FUNCTION hosted_refresh_health(wid text,eid text) RETURNS void LANGUAGE sql AS $$
  WITH wanted AS MATERIALIZED (SELECT * FROM hosted_health_projection WHERE workspace_id=wid AND email_id=eid),
  old AS MATERIALIZED (SELECT * FROM hosted_health_credits WHERE workspace_id=wid AND email_id=eid),
  removed AS (DELETE FROM hosted_health_credits c WHERE c.workspace_id=wid AND c.email_id=eid
    AND NOT EXISTS (SELECT FROM wanted w WHERE (w.epoch,w.hour)=(c.epoch,c.hour)) RETURNING c.*),
  changed AS (INSERT INTO hosted_health_credits AS c SELECT * FROM wanted ON CONFLICT(workspace_id,email_id,epoch,hour) DO UPDATE
    SET accepted=excluded.accepted,bounces=excluded.bounces,complaints=excluded.complaints,
      marketing_accepted=excluded.marketing_accepted,marketing_bounces=excluded.marketing_bounces,marketing_complaints=excluded.marketing_complaints
    WHERE (c.accepted,c.bounces,c.complaints,c.marketing_accepted,c.marketing_bounces,c.marketing_complaints)
      <>(excluded.accepted,excluded.bounces,excluded.complaints,excluded.marketing_accepted,excluded.marketing_bounces,excluded.marketing_complaints) RETURNING *),
  deltas AS (SELECT epoch,hour,-accepted AS a,-bounces AS b,-complaints AS c,-marketing_accepted AS ma,-marketing_bounces AS mb,-marketing_complaints AS mc FROM removed UNION ALL
    SELECT n.epoch,n.hour,n.accepted-coalesce(o.accepted,0),n.bounces-coalesce(o.bounces,0),n.complaints-coalesce(o.complaints,0),
      n.marketing_accepted-coalesce(o.marketing_accepted,0),n.marketing_bounces-coalesce(o.marketing_bounces,0),n.marketing_complaints-coalesce(o.marketing_complaints,0)
    FROM changed n LEFT JOIN old o USING(epoch,hour))
  INSERT INTO hosted_health_hourly AS totals(workspace_id,epoch,hour,accepted,bounces,complaints,marketing_accepted,marketing_bounces,marketing_complaints)
    SELECT wid,epoch,hour,a,b,c,ma,mb,mc FROM deltas ORDER BY epoch,hour
  ON CONFLICT(workspace_id,epoch,hour) DO UPDATE SET accepted=totals.accepted+excluded.accepted,bounces=totals.bounces+excluded.bounces,complaints=totals.complaints+excluded.complaints,
    marketing_accepted=totals.marketing_accepted+excluded.marketing_accepted,marketing_bounces=totals.marketing_bounces+excluded.marketing_bounces,
    marketing_complaints=totals.marketing_complaints+excluded.marketing_complaints
$$;
-- Split the last two days' evidence (what the projection still covers), so the first ladder run sees the streams.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM provider_connections WHERE kind='shared') THEN
    UPDATE hosted_health_credits c SET marketing_accepted=p.marketing_accepted,marketing_bounces=p.marketing_bounces,marketing_complaints=p.marketing_complaints
      FROM hosted_health_projection p WHERE (p.workspace_id,p.email_id,p.epoch,p.hour)=(c.workspace_id,c.email_id,c.epoch,c.hour)
        AND (p.marketing_accepted,p.marketing_bounces,p.marketing_complaints)<>(0,0,0);
    UPDATE hosted_health_hourly h SET marketing_accepted=s.ma,marketing_bounces=s.mb,marketing_complaints=s.mc FROM (
      SELECT workspace_id,epoch,hour,sum(marketing_accepted) ma,sum(marketing_bounces) mb,sum(marketing_complaints) mc FROM hosted_health_credits
      GROUP BY 1,2,3 HAVING sum(marketing_accepted)+sum(marketing_bounces)+sum(marketing_complaints)>0) s
      WHERE (h.workspace_id,h.epoch,h.hour)=(s.workspace_id,s.epoch,s.hour);
  END IF;
END $$;

-- The limit before any resume restore: an active operator override, nothing when exempt, else the standing's limit
-- (first_week for a workspace the standing job has not seen yet). A resume stores restore_cap from it (src/states.ts).
CREATE OR REPLACE FUNCTION hosted_base_cap(wid text,first_week int,second_week int,mature int) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce(CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN w.send_cap_override END,
    CASE WHEN NOT w.exempt_hosted_quotas THEN coalesce(s.daily_limit,first_week) END)
  FROM workspaces w LEFT JOIN sender_standing s ON s.workspace_id=w.id WHERE w.id=wid
$$;
-- Admission reads the stored limit. Unchanged from 230 otherwise: the age-tier arguments are kept for the running
-- Workers (first_week is the limit of a workspace the standing job has not seen yet); an expired operator override no
-- longer applies; the standing adds the marketing hold, the owner's release share and a strike cap. The marketing
-- reserve is max(100, headroom% of the limit), so a small sender always keeps 100 a day for receipts and resets.
-- A resume's restore_cap applies to the base, operator overrides included (as in 230). A marketing hold placed by
-- the hourly check before this shipped (provider_connections.marketing_held_at) still holds until the standing job
-- turns it into a restrict.
CREATE OR REPLACE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,s.step,coalesce(s.marketing_hold,false) AS operator_hold,
     CASE WHEN s.release_until>now() THEN s.release_percent END AS release_percent,
     CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN p.send_cap_override END AS override,
     CASE WHEN NOT p.exempt_hosted_quotas AND (p.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) THEN w.quota_sponsor END AS sponsor,
     hosted_base_cap(wid,first_week,second_week,mature) AS full_cap
   FROM hosted_admission_policy_read p JOIN workspaces w ON w.id=p.workspace_id LEFT JOIN sender_standing s ON s.workspace_id=p.workspace_id
   WHERE p.workspace_id=wid
 ), capped AS (
   SELECT p.*,CASE WHEN p.full_cap IS NOT NULL AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN p.restore_until END AS restored_until,
     CASE WHEN p.full_cap IS NOT NULL AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN least(p.full_cap,p.restore_cap) ELSE p.full_cap END AS cap FROM policy p
 ), siblings AS (
   SELECT wid AS id UNION ALL SELECT w.id FROM workspaces w WHERE w.id<>wid AND w.quota_sponsor=(SELECT sponsor FROM capped)
     AND (w.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) AND NOT w.exempt_hosted_quotas
 ), hours AS (
   SELECT h.hour,sum(h.recipients) AS recipients FROM siblings s JOIN hosted_usage_hourly h ON h.workspace_id=s.id
   WHERE incoming>0 AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND h.recipients>0 GROUP BY h.hour
 ), usage AS (SELECT hour,sum(recipients) OVER(ORDER BY hour DESC) AS running FROM hours)
 SELECT jsonb_build_object('cap',p.cap,'marketingCap',m.cap,'used',u.used,'resetAt',u.reset,
   'nextChangeAt',least(p.restored_until,coalesce(u.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours')),
   'pauseReason',p.pause_reason,'pendingCapOverride',p.pending_cap_override,'exemptHostedQuotas',p.exempt_hosted_quotas,
   'nextCap',CASE WHEN p.restored_until IS NOT NULL AND p.full_cap>p.cap THEN p.full_cap END,'nextCapAt',CASE WHEN p.restored_until IS NOT NULL AND p.full_cap>p.cap THEN p.restored_until END,
   'marketingHeld',coalesce((p.step IN ('restrict','pause') AND p.release_percent IS NULL) OR p.operator_hold,false) OR p.marketing_held_at IS NOT NULL,
   'marketingHoldReason',CASE WHEN NOT coalesce((p.step IN ('restrict','pause') AND p.release_percent IS NULL) OR p.operator_hold,false) THEN p.marketing_hold_reason END,'step',coalesce(p.step,'ok'))
 FROM capped p CROSS JOIN LATERAL (SELECT CASE WHEN p.cap IS NOT NULL THEN
     (greatest(0,p.cap-CASE WHEN p.override IS NULL THEN greatest(least(100,p.cap),ceil(p.cap*headroom/100)::int) ELSE ceil(p.cap*headroom/100)::int END)
       *coalesce(p.release_percent,100)/100) END AS cap) m CROSS JOIN LATERAL (
   SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
     max(hour) FILTER(WHERE running+least(incoming,p.cap)>p.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS reset FROM usage) u
$$;

-- The one hold test admission (above), campaign launch and dispatch share (230 defined it for the connection's own
-- hold): the standing's restrict or pause unless an owner released it, an operator's hold, or a hold from before the
-- standing shipped.
CREATE OR REPLACE FUNCTION hosted_marketing_held(wid text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT pc.marketing_held_at IS NOT NULL OR coalesce(s.marketing_hold OR (s.step IN ('restrict','pause') AND NOT coalesce(s.release_until>now() AND s.release_percent IS NOT NULL,false)),false)
    FROM provider_connections pc LEFT JOIN sender_standing s ON s.workspace_id=pc.workspace_id WHERE pc.workspace_id=wid AND pc.kind='shared'),false)
$$;
-- Bursts follow the limit too: clamp(limit ÷ 20, 50, 500) a minute per workspace, half that per domain.
CREATE OR REPLACE FUNCTION hosted_minute_cap(wid text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT greatest(least(500,greatest(50,coalesce(CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN w.send_cap_override END,s.daily_limit,100)/20)),
    ceil(CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN w.send_cap_override END/1440.0)::int)
  FROM workspaces w JOIN provider_connections c ON c.workspace_id=w.id AND c.kind='shared' LEFT JOIN sender_standing s ON s.workspace_id=w.id
  WHERE w.id=wid
$$;
-- Unchanged from 101 except that an expired operator override no longer keeps the workspace out of its sponsor's window.
CREATE OR REPLACE FUNCTION hosted_burst_ok(wid text,domain_key text,cost int) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE cap int; tenant int; dom int; sponsor text; tick timestamptz:=date_trunc('minute',statement_timestamp());
BEGIN
 IF cost=0 THEN RETURN true; END IF;
 SELECT hosted_minute_cap(wid), CASE WHEN p.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now() THEN w.quota_sponsor END INTO cap,sponsor
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
-- The age tiers are retired. A running Worker still calls this hourly; it no longer has anything to cache.
CREATE OR REPLACE FUNCTION refresh_hosted_minute_tiers() RETURNS void LANGUAGE sql AS $$ SELECT $$;

-- Existing Hosted workspaces keep the limit they have until the first standing run grades them from their mail.
INSERT INTO sender_standing(workspace_id,phase,daily_limit,band_limit)
  SELECT c.workspace_id,'seed',t.cap,t.cap FROM provider_connections c CROSS JOIN LATERAL (
    SELECT CASE hosted_history_tier(c.workspace_id) WHEN 3 THEN 10000 WHEN 2 THEN 1000 ELSE 100 END AS cap) t
  WHERE c.kind='shared' ON CONFLICT DO NOTHING;

-- A campaign already releasing when this ships never stops for a probe it did not start with.
UPDATE sending_campaigns SET probe_cleared_at=now() WHERE expanded>0 AND probe_cleared_at IS NULL;
