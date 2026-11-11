SET LOCAL lock_timeout='2s';
-- Hosted platform domain (PUBLIC_URL's host): the API passes the running policy {host,owner,reserved,fixtures}.
-- Refuses a send as the platform domain or below it through this workspace's closest claim, unless that claim is an
-- operator release fixture's own e2e* claim, or the workspace is the configured owner, the host is not one of the
-- platform's reserved hosts and, for the root, the claim was adopted by the operator. Mail outside the platform
-- domain, and a NULL policy (an older API during the rollout), are never refused here.
CREATE FUNCTION platform_sender_refused(platform jsonb,wid text,host text,claim text,adopted boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p IS NULL OR NOT (host=p OR right(host,length(p)+1)='.'||p) THEN false
    WHEN right(claim,length(p)+1)='.'||p AND substring(left(claim,length(claim)-length(p)-1) FROM '[^.]+$') ~ (platform->>'fixtures') THEN false
    ELSE NOT coalesce(wid=platform->>'owner' AND (host=p OR substring(left(host,length(host)-length(p)-1) FROM '[^.]+$') !~ (platform->>'reserved'))
      AND (claim<>p OR adopted),false)
  END FROM (SELECT platform->>'host' AS p) policy
$$;

-- Every sender check reads the closest claim here, so the policy applies to admission, campaign reviews, mailbox
-- replies and dispatch alike. A refused route is never verified. The appended argument keeps old callers working.
DROP FUNCTION regional_sender(text,text,boolean);
CREATE FUNCTION regional_sender(wid text,host text,simulated boolean,platform jsonb DEFAULT NULL)
RETURNS TABLE(region text,verified boolean,binding jsonb,connection jsonb,platform_refused boolean)
LANGUAGE sql VOLATILE AS $$
  WITH labels AS (SELECT string_to_array(host,'.') AS a), closest AS MATERIALIZED (
    SELECT dc.workspace_id,dc.name,dc.connection_id,dc.sending_state,platform_sender_refused(platform,wid,host,dc.name,dc.identity ? 'adopted') AS refused
    FROM labels,generate_subscripts(a,1) i
    JOIN domain_claims dc ON true WHERE dc.workspace_id=wid AND dc.name=array_to_string(a[i:cardinality(a)],'.') ORDER BY i LIMIT 1 FOR SHARE OF dc),
  bound AS (SELECT b.domain_id,b.region,b.connection_id,r.generation FROM closest dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id)
    JOIN provider_connection_regions r USING(connection_id,region) FOR SHARE OF b,r)
  SELECT b.region,dc.sending_state IN ('verified','lost') AND NOT dc.refused,jsonb_build_object('domain',b.domain_id,'connection',b.connection_id,'generation',b.generation,'account',c.aws_account_id,'topic',c.feedback_topic_arn),
    CASE WHEN c.id IS NOT NULL THEN to_jsonb(c) END,dc.refused FROM closest dc JOIN bound b ON true
    LEFT JOIN regional_simulated_connections c ON c.id=b.connection_id AND c.region=b.region AND
      (simulated OR (c.feedback_topic_arn LIKE 'arn:aws:sns:'||b.region||':'||c.aws_account_id||':%' AND (c.kind='byo' OR c.pool_state='ready')))
$$;

-- Unchanged from 094 except for the appended policy, passed on to regional_sender.
DROP FUNCTION key_admission_decision(text,text,jsonb,text,text,text,jsonb,jsonb,jsonb,boolean,int,int,int,int,int,numeric,boolean,boolean,boolean,boolean);
CREATE FUNCTION key_admission_decision(wid text,kid text,domains jsonb,path text,idem text,hash text,receipt jsonb,
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
    (cost=0 OR h->>'cap' IS NULL OR ((h->>'used')::bigint+cost<=(h->>'cap')::int AND (marketing=0 OR (h->>'used')::bigint+marketing<=(h->>'marketingCap')::int)));
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
