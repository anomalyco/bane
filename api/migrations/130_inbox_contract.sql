SET LOCAL lock_timeout='2s';

CREATE OR REPLACE FUNCTION inbox_view(b mailboxes) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',b.id,'kind','inbox','type',b.create_request->>'type','address',b.address,'domain',split_part(b.address,'@',2),'name',b.display_name,'metadata',b.metadata,'clientId',b.client_id,'createdAt',to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(b.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deleteAfter',to_char(b.delete_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status',CASE WHEN b.delete_after<=now() THEN 'deleting' WHEN b.expires_at<=now() THEN 'expired' ELSE 'active' END,'limits',jsonb_build_object('messages',b.quota_messages,'bytes',b.quota_bytes),'send',jsonb_build_object('enabled',(b.send_limits->>'perDay')::int>0,'perDay',(b.send_limits->>'perDay')::int,'replyOnly',true),'usage',jsonb_build_object('messages',s.messages,'bytes',s.bytes,'held',s.held,'unread',(SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id AND NOT read AND held_reason IS NULL),'lastMessageAt',(SELECT max(received_at) FROM mailbox_messages WHERE mailbox_id=b.id))) FROM inbox_state s WHERE s.inbox_id=b.id AND s.workspace_id=b.workspace_id
$$;

CREATE OR REPLACE FUNCTION create_ephemeral_inbox(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
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
 IF (SELECT count(*) FROM (SELECT 1 FROM mailboxes WHERE workspace_id=wid AND retention_mode='ephemeral' LIMIT 1000)s)>=1000 THEN RETURN jsonb_build_object('error','EPHEMERAL_INBOX_LIMIT'); END IF;
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
 INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,metadata,kind,retention_mode,expires_at,delete_after,quota_messages,quota_bytes,send_limits,client_id,created_by,create_request)
 VALUES(bid,wid,d.id,addr,req->>'name',req->'metadata','inbox','ephemeral',expires,deadline,(req#>>'{limits,messages}')::int,(req#>>'{limits,bytes}')::bigint,jsonb_build_object('perDay',CASE WHEN (req#>>'{send,enabled}')::boolean THEN (req#>>'{send,perDay}')::int ELSE 0 END),req->>'clientId',actor_id,req);
 INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES(wid,addr,bid,'primary');
 INSERT INTO inbox_state(inbox_id,workspace_id) VALUES(bid,wid);
 IF p?'key' THEN INSERT INTO mailbox_keys(id,workspace_id,name,hash,prefix,mailbox_ids,permissions,expires_at) VALUES(p#>>'{key,id}',wid,req#>>'{credential,name}',p#>>'{key,hash}',p#>>'{key,prefix}',jsonb_build_array(bid),req#>'{credential,permissions}',deadline); END IF;
 PERFORM inbox_event(wid,bid,'inbox.created');
 SELECT * INTO existing FROM mailboxes WHERE id=bid;
 RETURN jsonb_build_object('inbox',inbox_view(existing),'replay',false);
END $$;
