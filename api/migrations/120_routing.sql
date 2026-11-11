SET LOCAL lock_timeout='2s';
CREATE TABLE mail_routing_state(workspace_id text PRIMARY KEY,version integer NOT NULL DEFAULT 0,legacy_base boolean NOT NULL DEFAULT false);
CREATE TABLE mail_routes(id text PRIMARY KEY,workspace_id text NOT NULL,key text,domain_id text NOT NULL REFERENCES mailbox_domains ON DELETE CASCADE,
 match text NOT NULL,destinations jsonb NOT NULL,subaddresses boolean NOT NULL DEFAULT true,enabled boolean NOT NULL DEFAULT true,note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,match),UNIQUE(workspace_id,key));
CREATE INDEX mail_route_host ON mail_routes(workspace_id,domain_id) WHERE position('*' IN match)>0;
CREATE INDEX mail_route_references ON mail_routes USING gin(destinations);
CREATE TABLE mail_routing_plans(workspace_id text NOT NULL,scope text NOT NULL REFERENCES mailbox_domains ON DELETE CASCADE,plan jsonb NOT NULL,PRIMARY KEY(workspace_id,scope));
CREATE TABLE mail_routing_audit(workspace_id text NOT NULL,version integer NOT NULL,resource_id text NOT NULL,before jsonb,after jsonb,actor_type text NOT NULL,actor_id text NOT NULL,request_id text,note text,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,version,resource_id));
CREATE TABLE mail_route_plan_issues(workspace_id text NOT NULL,domain_id text PRIMARY KEY REFERENCES mailbox_domains ON DELETE CASCADE,bytes integer NOT NULL);
CREATE FUNCTION mail_compile_routes(w text,d text,backfill boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE patterns jsonb;
BEGIN
 -- Most literal characters first, then oldest. Address wildcard rules have no route ID.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',route_id,'match',match,'to',destinations) ORDER BY length(replace(match,'*','')) DESC,created_at,coalesce(route_id,owner)),'[]') INTO patterns FROM (
 SELECT id AS route_id,NULL AS owner,match,destinations,created_at FROM mail_routes WHERE workspace_id=w AND domain_id=d AND position('*' IN match)>0 AND enabled
 UNION ALL SELECT NULL,b.id,p,jsonb_build_array(b.id),b.created_at FROM mailboxes b CROSS JOIN jsonb_array_elements_text(b.rules) p WHERE b.workspace_id=w AND b.domain_id=d AND b.expires_at IS NULL AND rules<>'[]') all_patterns;
 -- 256 KiB fits all 64 x 20 typical address rules. Keep a transfer limit for long patterns.
 IF octet_length(patterns::text)>262144 THEN
   IF NOT backfill THEN RAISE EXCEPTION 'Host routing plan exceeds 256 KiB' USING ERRCODE='BR001'; END IF;
   INSERT INTO mail_route_plan_issues VALUES(w,d,octet_length(patterns::text)) ON CONFLICT(domain_id) DO UPDATE SET bytes=excluded.bytes;
   RETURN;
 END IF;
 DELETE FROM mail_route_plan_issues WHERE workspace_id=w AND domain_id=d;
 INSERT INTO mail_routing_plans VALUES(w,d,patterns) ON CONFLICT(workspace_id,scope) DO UPDATE SET plan=excluded.plan;
END $$;
CREATE FUNCTION mail_refresh_patterns() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' AND OLD.rules<>'[]' OR TG_OP<>'DELETE' AND NEW.rules<>'[]' THEN
  IF EXISTS(SELECT FROM mailbox_domains WHERE id=coalesce(NEW.domain_id,OLD.domain_id)) THEN
   PERFORM mail_compile_routes(coalesce(NEW.workspace_id,OLD.workspace_id),coalesce(NEW.domain_id,OLD.domain_id));
  END IF;
 END IF; RETURN NULL;
END $$;
CREATE TRIGGER mail_pattern_change AFTER INSERT OR UPDATE OF rules,expires_at OR DELETE ON mailboxes FOR EACH ROW EXECUTE FUNCTION mail_refresh_patterns();
-- Only an explicit routing edit / junk opt-in creates state. Do the compatibility check once, not for each claim.
CREATE FUNCTION mail_first_routing_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT FROM mail_routing_state WHERE workspace_id=NEW.workspace_id) THEN
   IF EXISTS(SELECT FROM mail_route_plan_issues WHERE workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'Oversize host routing plan' USING ERRCODE='BR001'; END IF;
   NEW.legacy_base:=EXISTS(SELECT FROM mailboxes b WHERE workspace_id=NEW.workspace_id AND rules<>'[]' AND EXISTS(SELECT FROM mailboxes other WHERE other.workspace_id=b.workspace_id AND other.domain_id=b.domain_id AND other.id<>b.id));
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER mail_first_route BEFORE INSERT ON mail_routing_state FOR EACH ROW EXECUTE FUNCTION mail_first_routing_state();
-- One call is one small transaction. Restarting at the beginning after interruption is safe.
CREATE FUNCTION mail_backfill_routes(after_id text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE d record;last_id text;
BEGIN
 FOR d IN SELECT id,workspace_id FROM mailbox_domains WHERE id>after_id ORDER BY id LIMIT 32 LOOP
   last_id:=d.id;
   IF EXISTS(SELECT FROM mailboxes WHERE workspace_id=d.workspace_id AND domain_id=d.id AND rules<>'[]') THEN
     INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(d.workspace_id,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
     IF NOT EXISTS(SELECT FROM mail_routing_plans WHERE workspace_id=d.workspace_id AND scope=d.id) THEN PERFORM mail_compile_routes(d.workspace_id,d.id,true); END IF;
   END IF;
 END LOOP;RETURN last_id;
END $$;

-- The claim and the simulator share these scoped, indexed reads. The state probe gates all other work.
CREATE FUNCTION mail_route_input(w text,recipients jsonb,force_read boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF NOT force_read AND NOT EXISTS(SELECT FROM mail_routing_state WHERE workspace_id=w) THEN RETURN NULL; END IF;
 RETURN (
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
 'hooks',(SELECT jsonb_object_agg(h.id,h.junk) FROM refs JOIN mailbox_webhooks h ON h.workspace_id=w AND h.id=refs.id WHERE NOT h.paused)) FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=w);
END $$;
