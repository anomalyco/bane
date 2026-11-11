SET LOCAL lock_timeout='2s';

CREATE OR REPLACE FUNCTION inbox_view(b mailboxes) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',b.id,'kind','inbox','retention',jsonb_build_object('mode',b.retention_mode),'type',b.create_request->>'type','address',b.address,'domain',split_part(b.address,'@',2),'name',b.display_name,'metadata',b.metadata,'clientId',b.client_id,'createdAt',to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(b.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deleteAfter',to_char(b.delete_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status',CASE WHEN b.delete_after<=now() THEN 'deleting' WHEN b.expires_at<=now() THEN 'expired' ELSE 'active' END,'limits',jsonb_build_object('messages',b.quota_messages,'bytes',b.quota_bytes),'send',jsonb_build_object('enabled',(b.send_limits->>'perDay')::int>0,'perDay',(b.send_limits->>'perDay')::int,'replyOnly',true),'usage',jsonb_build_object('messages',s.messages,'bytes',s.bytes,'held',s.held,'unread',(SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id AND NOT read AND held_reason IS NULL),'lastMessageAt',(SELECT max(received_at) FROM mailbox_messages WHERE mailbox_id=b.id))) FROM inbox_state s WHERE s.inbox_id=b.id AND s.workspace_id=b.workspace_id
$$;

CREATE FUNCTION create_managed_inbox(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE wid text:=p->>'wid'; req jsonb:=p->'input'; bid text:=p->>'id'; actor_id text:=p->>'actor'; d mailbox_domains; existing mailboxes; addr text; local text; host text; used_count integer; expires timestamptz:=now()+make_interval(secs=>(req->>'ttlSeconds')::int); deadline timestamptz:=expires+make_interval(hours=>(req->>'graceHours')::int);
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 SELECT * INTO existing FROM mailboxes WHERE workspace_id=wid AND client_id=req->>'clientId';
 IF FOUND THEN
  IF existing.create_request<>req OR (NOT (p->>'admin')::boolean AND existing.created_by<>actor_id) THEN RETURN jsonb_build_object('error','IDEMPOTENCY_CONFLICT'); END IF;
  IF existing.expires_at<=now() THEN RETURN jsonb_build_object('error','INBOX_GONE'); END IF;
  RETURN jsonb_build_object('inbox',inbox_view(existing),'replay',true);
 END IF;
 INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(wid,'inbox-create:'||wid,date_trunc('minute',now()),1) ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN least(61,b.used+1) ELSE 1 END,window_start=excluded.window_start RETURNING used INTO used_count;
 IF used_count>60 THEN RETURN jsonb_build_object('error','INBOX_CREATE_RATE'); END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM mailboxes WHERE workspace_id=wid AND kind='inbox' LIMIT 1000)s)>=1000 THEN RETURN jsonb_build_object('error','EPHEMERAL_INBOX_LIMIT'); END IF;
 IF req->>'type'='sandbox' THEN
  host:=p->>'sandboxHost';
  INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES('virtual_'||host,wid,'virtual_'||host,host,'sandbox','disabled','store') ON CONFLICT(workspace_id,name) DO NOTHING;
  SELECT * INTO STRICT d FROM mailbox_domains WHERE workspace_id=wid AND name=host AND status='disabled';
 ELSE
 SELECT m.* INTO d FROM mailbox_domains m WHERE m.workspace_id=wid AND m.status IN ('active','waiting_for_mx','provisioning') AND (req->>'domain' IS NULL OR coalesce(m.receiving_host,m.name)=req->>'domain') AND (NOT (p->>'hosted')::boolean OR (m.receiving_host IS NOT NULL AND EXISTS(SELECT FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id AND pc.state='ready' JOIN operation_domains o ON o.workspace_id=dc.workspace_id AND o.name=dc.name WHERE o.id=m.domain_id AND dc.workspace_id=wid AND (dc.sending_state IN ('verified','lost') OR dc.receiving_state<>'off') AND (o.region=pc.region OR (pc.kind='shared' AND m.region='us-east-2' AND m.status='active' AND dc.receiving_state IN ('active','lost')))))) ORDER BY (m.status='active') DESC,m.created_at,m.id LIMIT 1 FOR SHARE OF m;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','RECEIVING_DOMAIN_REQUIRED'); END IF;
 host:=coalesce(d.receiving_host,d.name);
 IF d.status<>'active' THEN RETURN jsonb_build_object('error','RECEIVING_NOT_ACTIVE','domain',host,'domainId',d.domain_id,'mx',host||' MX 10 inbound-smtp.'||d.region||'.amazonaws.com'); END IF;
 END IF;
 IF NOT coalesce((p->>'manageAddress')::boolean,false) AND d.catch_all='create_mailbox' THEN RETURN jsonb_build_object('error','ADMIN_REQUIRED','domain',host); END IF;
 FOR local IN SELECT jsonb_array_elements_text(p->'locals') LOOP
  addr:=local||'@'||host;
  IF local IN ('admin','administrator','postmaster','hostmaster','webmaster','security','abuse','root') THEN RETURN jsonb_build_object('error','ADDRESS_RESERVED'); END IF;
  IF NOT coalesce((p->>'manageAddress')::boolean,false) AND (req->>'localPart' IS NOT NULL OR EXISTS (
    SELECT FROM mail_routes r WHERE r.workspace_id=wid AND r.domain_id=d.id AND r.enabled AND
      (r.match=addr OR position('*' IN r.match)>0 AND addr LIKE replace(replace(replace(replace(r.match,'!','!!'),'%','!%'),'_','!_'),'*','%') ESCAPE '!')
  ) OR EXISTS (SELECT FROM mailboxes m CROSS JOIN LATERAL jsonb_array_elements_text(m.rules) AS r(pattern) WHERE m.workspace_id=wid AND m.domain_id=d.id AND m.expires_at IS NULL AND m.rules<>'[]' AND addr LIKE replace(replace(replace(replace(r.pattern,'!','!!'),'%','!%'),'_','!_'),'*','%') ESCAPE '!')) THEN addr:=NULL; CONTINUE; END IF;
  IF EXISTS(SELECT FROM mail_retired_addresses WHERE workspace_id=wid AND address=addr AND until>now()) THEN IF req->>'localPart' IS NOT NULL THEN RETURN jsonb_build_object('error','ADDRESS_RETIRED','domain',host);END IF;
  ELSIF NOT EXISTS(SELECT FROM mailbox_addresses WHERE workspace_id=wid AND address=addr) THEN EXIT; END IF;
  addr:=NULL;
 END LOOP;
 IF addr IS NULL THEN RETURN jsonb_build_object('error','ADDRESS_TAKEN','domain',host); END IF;
 IF req->>'type'='persistent' THEN expires:=NULL; deadline:=NULL; END IF;
 INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,metadata,kind,retention_mode,expires_at,delete_after,quota_messages,quota_bytes,send_limits,client_id,created_by,create_request)
 VALUES(bid,wid,d.id,addr,req->>'name',req->'metadata','inbox',CASE WHEN req->>'type'='persistent' THEN 'forever' ELSE 'ephemeral' END,expires,deadline,(req#>>'{limits,messages}')::int,(req#>>'{limits,bytes}')::bigint,jsonb_build_object('perDay',CASE WHEN (req#>>'{send,enabled}')::boolean THEN (req#>>'{send,perDay}')::int ELSE 0 END),req->>'clientId',actor_id,req);
 INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES(wid,addr,bid,'primary');
 INSERT INTO inbox_state(inbox_id,workspace_id) VALUES(bid,wid);
 IF p?'key' THEN INSERT INTO mailbox_keys(id,workspace_id,name,hash,prefix,mailbox_ids,permissions,expires_at) VALUES(p#>>'{key,id}',wid,req#>>'{credential,name}',p#>>'{key,hash}',p#>>'{key,prefix}',jsonb_build_array(bid),req#>'{credential,permissions}',deadline); END IF;
 PERFORM inbox_event(wid,bid,'inbox.created');
 SELECT * INTO existing FROM mailboxes WHERE id=bid;
 RETURN jsonb_build_object('inbox',inbox_view(existing),'replay',false);
END $$;

CREATE OR REPLACE FUNCTION inbox_end(wid text,bid text) RETURNS timestamptz LANGUAGE plpgsql AS $$
DECLARE ended timestamptz;
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'ingest'),(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 PERFORM FROM mailboxes WHERE workspace_id=wid AND id=bid FOR NO KEY UPDATE;
 PERFORM FROM inbox_state WHERE inbox_id=bid AND workspace_id=wid FOR UPDATE;
 UPDATE mailboxes SET retention_mode='ephemeral', expires_at=least(expires_at,now()),delete_after=now() WHERE workspace_id=wid AND id=bid AND kind='inbox' RETURNING delete_after INTO ended;
 IF NOT FOUND THEN RETURN NULL; END IF;
 DELETE FROM mailbox_addresses a USING mailboxes b WHERE a.workspace_id=wid AND a.mailbox_id=bid AND b.id=bid AND b.create_request->>'type'<>'sandbox';
 UPDATE mailbox_keys SET expires_at=ended WHERE workspace_id=wid AND mailbox_ids=jsonb_build_array(bid) AND (expires_at IS NOT NULL OR EXISTS(SELECT FROM mailboxes WHERE id=bid AND create_request->>'type'='persistent'));
 RETURN ended;
END $$;


-- Receipt ownership is predicted at claim, then resolved again at commit. Only simulated, non-routable addresses can be retired for delivery.
-- Real hosts always fall back to domain routing. Plus-addresses inherit the base owner's lifetime.
CREATE OR REPLACE FUNCTION inbox_delivery(wid text, recipients jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH owners AS (SELECT r.addr,b.id,b.retention_mode,EXISTS(SELECT FROM mail_retired_addresses t WHERE t.workspace_id=wid AND t.address IN (r.addr,regexp_replace(r.addr,'[+][^@]*@','@')) AND t.until>now() AND t.address LIKE '%.sandbox.invalid') AS retired
 FROM jsonb_array_elements_text(recipients) r(addr) LEFT JOIN LATERAL (SELECT m.id,m.retention_mode FROM mailbox_addresses a JOIN mailboxes m ON m.id=a.mailbox_id AND m.workspace_id=a.workspace_id WHERE a.workspace_id=wid AND (m.delete_after IS NULL OR m.delete_after>statement_timestamp()) AND a.address IN (r.addr,regexp_replace(r.addr,'[+][^@]*@','@')) ORDER BY (a.address=r.addr) DESC LIMIT 1)b ON true)
 SELECT jsonb_build_object('lifecycle',CASE WHEN bool_or(retention_mode='forever') THEN 'kept' WHEN bool_and(coalesce(retention_mode='ephemeral',false) OR retired) AND count(id)>0 THEN 'ephemeral' ELSE 'default' END,'prefixInbox',coalesce(min(id) FILTER(WHERE retention_mode='forever'),min(id) FILTER(WHERE retention_mode='ephemeral')),'drop',coalesce(bool_and(retired),false),'owners',coalesce(jsonb_agg(id),'[]')) FROM owners
$$;


-- Keep claim, membership decisions and delivery snapshots in the existing two wire statements.
SET LOCAL lock_timeout='2s';
CREATE OR REPLACE FUNCTION mail_route_input_unfenced(w text,recipients jsonb,force_read boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF NOT force_read AND NOT EXISTS(SELECT FROM mail_routing_state WHERE workspace_id=w) THEN RETURN NULL; END IF;
 RETURN (
 WITH addresses AS MATERIALIZED (SELECT a FROM jsonb_array_elements_text(recipients) a UNION SELECT regexp_replace(a,'[+][^@]*@','@') FROM jsonb_array_elements_text(recipients) a),
 hosts AS MATERIALIZED (SELECT d.id,coalesce(receiving_host,name) AS host,d.catch_all,p.plan FROM mailbox_domains d LEFT JOIN mail_routing_plans p ON p.workspace_id=w AND p.scope=d.id
 WHERE d.workspace_id=w AND coalesce(receiving_host,name) IN (SELECT split_part(a,'@',2) FROM addresses) AND (d.status='active' OR (d.receiving_host IS NULL AND d.status IN ('waiting_for_mx','provisioning')))),
 exact AS MATERIALIZED (SELECT r.* FROM addresses JOIN mail_routes r ON r.workspace_id=w AND r.match=a JOIN hosts h ON h.id=r.domain_id WHERE enabled),
 owners AS MATERIALIZED (SELECT a.address,b.id,a.kind FROM addresses JOIN mailbox_addresses a ON a.workspace_id=w AND a.address=addresses.a JOIN mailboxes b ON b.workspace_id=w AND b.id=a.mailbox_id JOIN hosts h ON h.id=b.domain_id WHERE b.delete_after IS NULL OR b.delete_after>statement_timestamp()),
 programs AS MATERIALIZED (SELECT programs FROM mail_ritual_configs WHERE workspace_id=w),
 refs(id) AS MATERIALIZED (SELECT value FROM programs,jsonb_each_text(programs.programs->'refs') UNION SELECT id FROM owners UNION SELECT jsonb_array_elements_text(destinations) FROM exact WHERE jsonb_typeof(destinations)='array' UNION SELECT jsonb_array_elements_text(item->'to') FROM hosts,jsonb_array_elements(plan) item WHERE jsonb_typeof(item->'to')='array')
 SELECT jsonb_build_object('programs',(SELECT programs FROM programs),'version',coalesce(s.version,0),'legacy',coalesce(s.legacy_base,true),'hosts',(SELECT jsonb_object_agg(host,jsonb_build_object('default',catch_all,'patterns',coalesce(plan,'[]'))) FROM hosts),
 'exact',(SELECT jsonb_object_agg(match,jsonb_build_object('id',id,'match',match,'to',destinations,'subaddresses',subaddresses)) FROM exact),
 'owners',(SELECT jsonb_object_agg(address,jsonb_build_object('id',id,'public',kind='public')) FROM owners),
 'boxes',(SELECT jsonb_object_agg(b.id,jsonb_build_object('kept',b.retention_mode='forever','dmarc',b.require_dmarc,'created',b.created_at,'expires',b.expires_at,'deleteAfter',b.delete_after)) FROM refs JOIN mailboxes b ON b.workspace_id=w AND b.id=refs.id),
 'hooks',(SELECT jsonb_object_agg(h.id,h.junk) FROM refs JOIN mailbox_webhooks h ON h.workspace_id=w AND h.id=refs.id WHERE NOT h.paused)) FROM (SELECT 1) one LEFT JOIN mail_routing_state s ON s.workspace_id=w);
END $$;
