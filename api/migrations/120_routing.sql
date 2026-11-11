-- No existing domain is rewritten. A workspace with no routing state still uses the six-argument store.
ALTER TABLE mailbox_domains ALTER catch_all SET DEFAULT 'store';
ALTER TABLE mail_receipts ADD routing jsonb;
ALTER TABLE mailboxes ADD key text, ADD CONSTRAINT mailboxes_key UNIQUE(workspace_id,key);
ALTER TABLE mailbox_webhooks ADD key text, ADD CONSTRAINT mailbox_webhooks_key UNIQUE(workspace_id,key), ADD name text,
 ADD format text NOT NULL DEFAULT 'bane' CHECK(format IN ('bane','inbound')),
 ADD junk text NOT NULL DEFAULT 'skip' CHECK(junk IN ('skip','include')),
 ADD include jsonb NOT NULL DEFAULT '[]', ADD timeout_seconds smallint NOT NULL DEFAULT 5 CHECK(timeout_seconds BETWEEN 1 AND 30),
 ADD retry_attempts smallint NOT NULL DEFAULT 9 CHECK(retry_attempts BETWEEN 0 AND 10); -- 9 retries keeps today's 10 attempts.
ALTER TABLE mailbox_webhook_deliveries ADD routed boolean NOT NULL DEFAULT false, ADD format text NOT NULL DEFAULT 'bane';
CREATE UNIQUE INDEX mailbox_hook_once_per_routed_message ON mailbox_webhook_deliveries(workspace_id,webhook_id,(payload->>'messageId')) WHERE routed;
CREATE TABLE mail_routing_state(workspace_id text PRIMARY KEY,version integer NOT NULL DEFAULT 0,legacy_base boolean NOT NULL DEFAULT false);
-- One-time usage check, not a live development query: conservatively protect workspaces with a
-- wildcard owner and a competing plus base on its host. No receipt bodies or historical scans.
INSERT INTO mail_routing_state(workspace_id,legacy_base)
 SELECT DISTINCT b.workspace_id,true FROM mailboxes b WHERE b.rules<>'[]' AND EXISTS
 (SELECT FROM mailboxes other WHERE other.workspace_id=b.workspace_id AND other.domain_id=b.domain_id AND other.id<>b.id);
CREATE TABLE mail_routes(id text PRIMARY KEY,workspace_id text NOT NULL,key text,domain_id text NOT NULL REFERENCES mailbox_domains ON DELETE CASCADE,
 match text NOT NULL,destinations jsonb NOT NULL,subaddresses boolean NOT NULL DEFAULT true,enabled boolean NOT NULL DEFAULT true,note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,match),UNIQUE(workspace_id,key));
CREATE INDEX mail_route_host ON mail_routes(workspace_id,domain_id) WHERE position('*' IN match)>0;
CREATE INDEX mail_route_references ON mail_routes USING gin(destinations);
CREATE TABLE mail_routing_plans(workspace_id text NOT NULL,scope text NOT NULL REFERENCES mailbox_domains ON DELETE CASCADE,plan jsonb NOT NULL,PRIMARY KEY(workspace_id,scope));
CREATE TABLE mail_routing_audit(workspace_id text NOT NULL,version integer NOT NULL,resource_id text NOT NULL,before jsonb,after jsonb,actor_type text NOT NULL,actor_id text NOT NULL,request_id text,note text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,version,resource_id));
CREATE FUNCTION mail_compile_routes(w text,d text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE patterns jsonb;
BEGIN
 -- Most literal characters first, then oldest. Address wildcard rules have no route ID.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',route_id,'match',match,'to',destinations) ORDER BY length(replace(match,'*','')) DESC,created_at,coalesce(route_id,owner)),'[]') INTO patterns FROM (
 SELECT id AS route_id,NULL AS owner,match,destinations,created_at FROM mail_routes WHERE workspace_id=w AND domain_id=d AND position('*' IN match)>0 AND enabled
 UNION ALL SELECT NULL,b.id,p,jsonb_build_array(b.id),b.created_at FROM mailboxes b CROSS JOIN jsonb_array_elements_text(b.rules) p WHERE b.workspace_id=w AND b.domain_id=d AND b.expires_at IS NULL AND rules<>'[]') all_patterns;
 IF octet_length(patterns::text)>65536 THEN RAISE EXCEPTION 'Host routing plan exceeds 64 KiB' USING ERRCODE='54000'; END IF;
 INSERT INTO mail_routing_plans VALUES(w,d,patterns) ON CONFLICT(workspace_id,scope) DO UPDATE SET plan=excluded.plan;
END $$;
CREATE FUNCTION mail_refresh_patterns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.rules<>'[]' OR TG_OP<>'DELETE' AND NEW.rules<>'[]' THEN
  PERFORM mail_compile_routes(coalesce(NEW.workspace_id,OLD.workspace_id),coalesce(NEW.domain_id,OLD.domain_id));
 END IF; RETURN NULL;
END $$;
CREATE TRIGGER mail_pattern_change AFTER INSERT OR UPDATE OF rules,expires_at OR DELETE ON mailboxes FOR EACH ROW EXECUTE FUNCTION mail_refresh_patterns();
SELECT mail_compile_routes(workspace_id,domain_id) FROM (SELECT DISTINCT workspace_id,domain_id FROM mailboxes WHERE rules<>'[]') d;

-- The claim and the simulator share these scoped, indexed reads. The state probe gates all other work.
CREATE FUNCTION mail_route_input(w text,recipients jsonb,force_read boolean DEFAULT false) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN force_read OR EXISTS(SELECT FROM mail_routing_state WHERE workspace_id=w) THEN (
 WITH addresses AS MATERIALIZED (SELECT a FROM jsonb_array_elements_text(recipients) a UNION SELECT regexp_replace(a,'[+][^@]*@','@') FROM jsonb_array_elements_text(recipients) a),
 hosts AS MATERIALIZED (SELECT d.id,coalesce(receiving_host,name) AS host,d.catch_all,p.plan FROM mailbox_domains d LEFT JOIN mail_routing_plans p ON p.workspace_id=w AND p.scope=d.id
 WHERE d.workspace_id=w AND coalesce(receiving_host,name) IN (SELECT split_part(a,'@',2) FROM addresses) AND (d.status='active' OR (d.receiving_host IS NULL AND d.status IN ('waiting_for_mx','provisioning')))),
 exact AS MATERIALIZED (SELECT r.* FROM addresses JOIN mail_routes r ON r.workspace_id=w AND r.match=a JOIN hosts h ON h.id=r.domain_id WHERE enabled),
 owners AS MATERIALIZED (SELECT a.address,b.id,a.kind FROM addresses JOIN mailbox_addresses a ON a.workspace_id=w AND a.address=addresses.a JOIN mailboxes b ON b.workspace_id=w AND b.id=a.mailbox_id JOIN hosts h ON h.id=b.domain_id),
 refs AS MATERIALIZED (SELECT id FROM owners UNION SELECT jsonb_array_elements_text(destinations) FROM exact WHERE jsonb_typeof(destinations)='array' UNION SELECT jsonb_array_elements_text(item->'to') FROM hosts,jsonb_array_elements(plan) item WHERE jsonb_typeof(item->'to')='array')
 SELECT jsonb_build_object('version',coalesce(s.version,0),'legacy',coalesce(s.legacy_base,true),'hosts',(SELECT jsonb_object_agg(host,jsonb_build_object('default',catch_all,'patterns',coalesce(plan,'[]'))) FROM hosts),
 'exact',(SELECT jsonb_object_agg(match,jsonb_build_object('id',id,'match',match,'to',destinations,'subaddresses',subaddresses)) FROM exact),
 'owners',(SELECT jsonb_object_agg(address,jsonb_build_object('id',id,'public',kind='public')) FROM owners),
 'boxes',(SELECT jsonb_object_agg(b.id,jsonb_build_object('dmarc',b.require_dmarc,'created',b.created_at,'expires',b.expires_at)) FROM refs JOIN mailboxes b ON b.workspace_id=w AND b.id=refs.id),
 'hooks',(SELECT jsonb_object_agg(h.id,h.junk) FROM refs JOIN mailbox_webhooks h ON h.workspace_id=w AND h.id=refs.id WHERE NOT h.paused)) FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=w) END
$$;
