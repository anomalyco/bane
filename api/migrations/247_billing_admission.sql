SET LOCAL lock_timeout='2s';
-- The billing gate inside the one admission statement. key_admission_decision is 230's version with one appended
-- argument, billable (all recipients of the request), and the billing_gate() decision in both results. The old
-- signature is dropped so a stale caller fails loudly instead of skipping the gate.
DROP FUNCTION key_admission_decision(text,text,jsonb,text,text,text,jsonb,jsonb,jsonb,boolean,int,int,int,int,int,numeric,boolean,boolean,boolean,boolean,jsonb);
CREATE FUNCTION key_admission_decision(wid text,kid text,domains jsonb,path text,idem text,hash text,receipt jsonb,
  wanted jsonb,asset_ids jsonb,sim boolean,cost int,marketing int,first_week int,second_week int,mature int,
  headroom numeric,regional boolean,trusted boolean,require_dmarc boolean,valid_content boolean,platform jsonb DEFAULT NULL,billable int DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE s jsonb; h jsonb; m jsonb; r jsonb; c jsonb; facts jsonb; obs jsonb; ses jsonb; reg text; host text;
  ok boolean; invalid_mime boolean:=false; rows_ok boolean; cap int; bulk jsonb; b jsonb;
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
  -- Billing (Hosted only: BYO and self-hosted have no hosted allowance object). billable counts every recipient, even
  -- when the installation simulates SES (billing_gate prices those only with bill_simulated). Enforced and short: denied.
  IF jsonb_typeof(h)='object' AND billable>0 THEN
    b:=billing_gate(wid,billable,sim);
    IF (b->>'enforced')::boolean AND NOT (b->>'ok')::boolean THEN ok:=false; END IF;
  END IF;
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
    RETURN s||jsonb_build_object('allowed',false,'invalidMime',invalid_mime,'bulk',bulk,'billing',b);
  END IF;
  RETURN s||jsonb_build_object('allowed',true,'billing',b);
END $$;

-- Campaigns wait with waiting_reason 'balance' while an enforced prepaid workspace can't pay for the next recipient.
ALTER TABLE sending_campaigns DROP CONSTRAINT sending_campaigns_waiting_reason_check,
  ADD CONSTRAINT sending_campaigns_waiting_reason_check CHECK (waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota','list_probe','balance')) NOT VALID;
ALTER TABLE sending_campaigns VALIDATE CONSTRAINT sending_campaigns_waiting_reason_check;
