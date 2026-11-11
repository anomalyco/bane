-- Receipts keep the whole trace up to 4 KiB; a larger one keeps its version and outcome counts.
CREATE FUNCTION mail_routing_trace(plan jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN octet_length(plan::text)<=4096 THEN plan ELSE jsonb_build_object('version',plan->'version','truncated',true,'recipientCount',jsonb_array_length(plan->'recipients'),
  'droppedCount',(SELECT count(*) FROM jsonb_array_elements(plan->'recipients') r WHERE (r->>'dropped')::boolean)) END
$$;
-- Recheck claim-time destinations under the ingest lane. A concurrent delete/expiry/DMARC hold
-- can only reduce delivery; it must never turn an explicit route into an auto-created address.
CREATE FUNCTION mail_apply_route(w text,p jsonb,received timestamptz,dmarc text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH r AS (SELECT item,n FROM jsonb_array_elements(p->'recipients') WITH ORDINALITY r(item,n)), checked AS (
 SELECT item,n,coalesce(b.boxes,'[]') AS boxes,coalesce(h.hooks,'[]') AS hooks FROM r LEFT JOIN LATERAL (
 SELECT jsonb_agg(id ORDER BY ord) AS boxes,bool_or(require_dmarc) AS held FROM jsonb_array_elements_text(item->'inboxes') WITH ORDINALITY ref(k,ord) JOIN mailboxes b ON b.workspace_id=w AND b.id=k AND (b.expires_at IS NULL OR (b.created_at<=received AND b.expires_at>greatest(statement_timestamp(),received)))) b ON true
 LEFT JOIN LATERAL (SELECT jsonb_agg(id ORDER BY ord) AS hooks FROM jsonb_array_elements_text(item->'webhooks') WITH ORDINALITY ref(k,ord) JOIN mailbox_webhooks h ON h.workspace_id=w AND h.id=k AND NOT h.paused AND (h.junk='include' OR NOT (item->>'junk')::boolean)
 WHERE dmarc='PASS' OR (NOT coalesce(b.held,false) AND NOT EXISTS(SELECT FROM mailbox_addresses a JOIN mailboxes m ON m.id=a.mailbox_id AND m.workspace_id=w WHERE a.workspace_id=w AND a.address IN(item->>'address',regexp_replace(item->>'address','[+][^@]*@','@')) AND m.require_dmarc))) h ON true)
 SELECT jsonb_set(p,'{recipients}',coalesce(jsonb_agg(item||jsonb_build_object('inboxes',boxes,'webhooks',hooks,'warnings',CASE WHEN boxes<>item->'inboxes' OR hooks<>item->'webhooks' THEN item->'warnings'||'"Destinations changed between the claim and storage."'::jsonb ELSE item->'warnings' END) ORDER BY n),'[]')) FROM checked
$$;

CREATE FUNCTION mail_store_incoming(msg jsonb, file_items jsonb, refs_json jsonb, envelopes jsonb, authenticated_from boolean, can_create boolean, plan jsonb)
RETURNS TABLE(queued_count integer,wait_ms double precision,hold_ms double precision) LANGUAGE plpgsql VOLATILE AS $$
DECLARE wid text:=msg->>'workspace_id'; received timestamptz:=(msg->>'received_at')::timestamptz; dmarc text:=msg#>>'{verdicts,dmarc}'; is_spam boolean:=(msg->>'spam')::boolean;
started timestamptz:=clock_timestamp(); locked timestamptz;
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'ingest') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 plan:=mail_apply_route(wid,plan,received,dmarc);
 can_create:=can_create AND NOT is_spam AND EXISTS(SELECT FROM jsonb_to_recordset(envelopes) AS v(addr text) JOIN mailbox_domains d ON d.workspace_id=wid AND coalesce(d.receiving_host,d.name)=split_part(addr,'@',2) AND d.catch_all='create_mailbox' WHERE EXISTS(SELECT FROM jsonb_array_elements(plan->'recipients') p WHERE p->>'address'=addr AND p->>'tier'='default') AND NOT EXISTS(SELECT FROM mailbox_addresses a WHERE a.workspace_id=wid AND a.address IN (addr,regexp_replace(addr,'[+][^@]*@','@'))));
 IF can_create THEN INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false; END IF;
 locked:=clock_timestamp();
 WITH delivery AS MATERIALIZED (
    SELECT x.* FROM jsonb_populate_record(NULL::mail_messages,msg::jsonb) x
    JOIN mail_receipts r ON r.workspace_id=x.workspace_id AND r.ses_message_id=x.ses_message_id AND r.status='pending'
    WHERE r.recipients=x.envelope_to FOR UPDATE OF r
  ), extended AS (UPDATE mail_messages old SET envelope_to=x.envelope_to FROM delivery x WHERE old.workspace_id=x.workspace_id AND old.id=x.id RETURNING old.*
  ), input AS MATERIALIZED (SELECT x.* FROM delivery x WHERE NOT EXISTS(SELECT FROM extended)
  ), known AS MATERIALIZED (
    SELECT old.* FROM input x JOIN mail_message_ids i USING(workspace_id,message_id)
    JOIN mail_messages old ON old.id=i.mail_message_id AND old.workspace_id=x.workspace_id AND old.direction='inbound'
    WHERE x.status<>'unparsed' AND old.status<>'unparsed' AND old.from_address=x.from_address AND old.subject=x.subject AND old.text IS NOT DISTINCT FROM x.text AND old.html IS NOT DISTINCT FROM x.html
    AND old.attachment_count=x.attachment_count AND ARRAY(SELECT sha256 FROM mail_attachments WHERE message_id=old.id ORDER BY sha256)=ARRAY(SELECT f->>'sha256' FROM jsonb_array_elements(file_items) f ORDER BY 1)
  ), thread AS (
    INSERT INTO mail_threads AS t(id,workspace_id,message_count,last_message_at)
    SELECT coalesce(parent.thread_id,('thr_'||replace(gen_random_uuid()::text,'-',''))),x.workspace_id,1,x.received_at FROM input x
    LEFT JOIN LATERAL (SELECT coalesce(i.thread_id,provider.thread_id) AS thread_id FROM jsonb_array_elements_text(refs_json::jsonb) WITH ORDINALITY refs(ref,n)
      LEFT JOIN mail_message_ids i ON i.workspace_id=x.workspace_id AND i.message_id=ref
      LEFT JOIN LATERAL (SELECT p.thread_id FROM sending_emails e JOIN mail_messages p ON p.sending_email_id=e.id AND p.workspace_id=e.workspace_id
        WHERE i.thread_id IS NULL AND ref ~ '^[A-Za-z0-9_-]+@(email|[a-z]{2}-[a-z0-9-]+-[0-9]+)[.]amazonses[.]com$'
        AND e.workspace_id=x.workspace_id AND e.provider_id=split_part(ref,'@',1) AND e.region=CASE split_part(split_part(ref,'@',2),'.',1) WHEN 'email' THEN 'us-east-1' ELSE split_part(split_part(ref,'@',2),'.',1) END
        AND ref=e.provider_id||'@'||CASE e.region WHEN 'us-east-1' THEN 'email' ELSE e.region END||'.amazonses.com' LIMIT 1) provider ON true
      WHERE coalesce(i.thread_id,provider.thread_id) IS NOT NULL ORDER BY n LIMIT 1) parent ON true
    WHERE NOT EXISTS(SELECT 1 FROM known) ON CONFLICT(id) DO UPDATE SET message_count=t.message_count+1,last_message_at=greatest(t.last_message_at,excluded.last_message_at) RETURNING id
  ), stored AS (INSERT INTO mail_messages("id","workspace_id","direction","region","ses_message_id","message_id","in_reply_to","references","subject","from_address","from_name","to","cc","bcc","reply_to","envelope_from","envelope_to","sent_at","received_at","text","html","body_truncated","snippet","headers","attachment_count","size_bytes","raw_bucket","raw_key","verdicts","spam","automated","status",thread_id) SELECT x."id",x."workspace_id",x."direction",x."region",x."ses_message_id",x."message_id",x."in_reply_to",x."references",x."subject",x."from_address",x."from_name",x."to",x."cc",x."bcc",x."reply_to",x."envelope_from",x."envelope_to",x."sent_at",x."received_at",x."text",x."html",x."body_truncated",x."snippet",x."headers",x."attachment_count",x."size_bytes",x."raw_bucket",x."raw_key",x."verdicts",x."spam",x."automated",x."status",thread.id FROM input x,thread RETURNING *
  ), stale AS MATERIALIZED (
    SELECT c.id,c.suppression_reason,s.id AS message_id FROM stored s JOIN audience_contacts c ON c.workspace_id=s.workspace_id AND c.email=s.from_address
    WHERE authenticated_from AND NOT s.spam AND c.suppressed AND c.suppression_reason IN ('hard_bounce','soft_bounce','transient','email_validation') AND c.marketing_consent<>'unsubscribed'
      AND s.sent_at IS NOT NULL AND s.sent_at<=s.received_at+interval '5 minutes'
      AND coalesce(c.suppressed_at,c.updated_at)<least(s.sent_at,s.received_at) FOR UPDATE OF c
  ), cleared AS (UPDATE audience_contacts c SET suppressed=false,suppression_reason=NULL,suppressed_at=NULL,updated_at=now() FROM stale
    WHERE c.id=stale.id RETURNING c.id AS contact_id,stale.suppression_reason,stale.message_id
  ), files AS (INSERT INTO mail_attachments(id,workspace_id,message_id,filename,content_type,size_bytes,content_id,disposition,sha256,bucket,storage_key)
    SELECT f.id,s.workspace_id,s.id,f.filename,f."contentType",f."sizeBytes",f."contentId",f.disposition,f.sha256,f.bucket,f."storageKey" FROM stored s CROSS JOIN jsonb_to_recordset(file_items::jsonb) f(id text,filename text,"contentType" text,"sizeBytes" int,"contentId" text,disposition text,sha256 text,bucket text,"storageKey" text)
  ), indexed AS (INSERT INTO mail_message_ids(workspace_id,message_id,mail_message_id,thread_id) SELECT workspace_id,message_id,id,thread_id FROM stored WHERE message_id IS NOT NULL ON CONFLICT DO NOTHING
  ), target AS MATERIALIZED (SELECT * FROM stored UNION ALL SELECT * FROM known UNION ALL SELECT * FROM extended), routes AS MATERIALIZED (
    SELECT addr,base,n,d.id AS domain,d.catch_all,r.valid,o.owner,o.receives,pr.item
    FROM target x CROSS JOIN jsonb_to_recordset(envelopes::jsonb) r(addr text,n int,valid boolean)
    JOIN mailbox_domains d ON d.workspace_id=x.workspace_id AND coalesce(d.receiving_host,d.name)=split_part(addr,'@',2) AND (d.status='active' OR (d.receiving_host IS NULL AND d.status IN ('waiting_for_mx','provisioning')))
    JOIN jsonb_array_elements(plan->'recipients') pr(item) ON pr.item->>'address'=addr AND NOT (pr.item->>'dropped')::boolean
    CROSS JOIN LATERAL (SELECT regexp_replace(addr,'[+][^@]*@','@') AS base) plus
    LEFT JOIN LATERAL (SELECT b.id AS owner,a.kind<>'public' AND (b.expires_at IS NULL OR (b.created_at<=least(x.received_at,received::timestamptz) AND b.expires_at>greatest(statement_timestamp(),least(x.received_at,received::timestamptz)))) AS receives
      FROM mailbox_addresses a JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.workspace_id=x.workspace_id AND (a.address=addr OR (a.address=base AND NOT coalesce((pr.item->>'skipBase')::boolean,false))) AND pr.item->>'tier'='default' ORDER BY (a.address=addr) DESC LIMIT 1) o ON true
  ), misses AS (SELECT * FROM routes WHERE owner IS NULL AND item->>'tier'='default' AND valid AND catch_all='create_mailbox' AND can_create),
  domain_budget AS MATERIALIZED (SELECT domain,least(500-count(created_at),50-count(*) FILTER (WHERE created_at>now()-interval '1 hour')) AS slots
    FROM (SELECT DISTINCT domain FROM misses) d LEFT JOIN LATERAL (SELECT created_at FROM mailboxes b WHERE b.workspace_id=wid AND b.domain_id=d.domain AND b.origin='auto' LIMIT 500) b ON true GROUP BY domain),
  candidates AS (SELECT r.*,row_number() OVER(PARTITION BY domain ORDER BY n) AS rank FROM misses r WHERE NOT EXISTS(SELECT 1 FROM misses earlier WHERE earlier.addr=r.base AND earlier.n<r.n)),
  boxes AS (INSERT INTO mailboxes(id,domain_id,address,workspace_id,origin)
    SELECT 'mbx_'||replace(gen_random_uuid()::text,'-',''),domain,addr,wid,'auto' FROM candidates JOIN domain_budget USING(domain) WHERE rank<=slots ORDER BY n
    LIMIT (CASE WHEN EXISTS(SELECT FROM misses) THEN (SELECT 2000-count(*) FROM (SELECT 1 FROM mailboxes WHERE workspace_id=wid AND origin='auto' LIMIT 2000) used) ELSE 0 END) RETURNING *
  ), addresses AS (INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) SELECT workspace_id,address,id,'primary' FROM boxes),
  resolved AS (SELECT r.addr,CASE WHEN r.owner IS NOT NULL THEN CASE WHEN r.receives THEN r.owner END ELSE coalesce(base.id,exact.id) END AS box
    FROM routes r LEFT JOIN boxes exact ON exact.address=r.addr LEFT JOIN (boxes base JOIN misses earlier ON earlier.addr=base.address) ON base.address=r.base AND earlier.n<r.n WHERE r.item->>'tier'='default'
    UNION ALL SELECT r.addr,ref.id FROM routes r LEFT JOIN LATERAL jsonb_array_elements_text(r.item->'inboxes') ref(id) ON true WHERE r.item->>'tier'<>'default'),
  unrouted AS (INSERT INTO mail_unrouted(workspace_id,message_id,address) SELECT x.workspace_id,x.id,r.addr FROM target x,resolved r WHERE r.box IS NULL OR EXISTS(SELECT FROM routes cap WHERE cap.addr=r.addr AND cap.item @> '{"limited":true}') ON CONFLICT DO NOTHING),
  added AS (INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,labels)
    SELECT DISTINCT r.box,x.id,x.workspace_id,x.thread_id,'inbound',false,x.received_at,array_remove(ARRAY[CASE WHEN b.require_dmarc THEN 'unverified' END,CASE WHEN is_spam THEN 'spam' END],NULL)
    FROM target x CROSS JOIN resolved r LEFT JOIN mailboxes b ON b.id=r.box AND (dmarc IS DISTINCT FROM 'PASS') WHERE r.box IS NOT NULL ON CONFLICT DO NOTHING RETURNING *),
  summaries AS (INSERT INTO mailbox_threads AS t(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at,spam,labels)
    SELECT a.mailbox_id,x.thread_id,x.workspace_id,1,1,x.received_at,x.received_at,x.spam,CASE WHEN x.spam THEN ARRAY['spam'] ELSE ARRAY[]::text[] END FROM target x JOIN added a ON a.message_id=x.id ORDER BY a.mailbox_id
    ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET message_count=t.message_count+1,unread_count=t.unread_count+1,last_message_at=greatest(t.last_message_at,excluded.last_message_at),last_inbound_at=greatest(t.last_inbound_at,excluded.last_inbound_at),archived=false RETURNING mailbox_id),
  done AS (UPDATE mail_receipts SET status='processed',processed_at=now(),error=NULL,routing=mail_routing_trace(plan) WHERE workspace_id=wid AND ses_message_id=(msg->>'ses_message_id') AND EXISTS(SELECT FROM delivery)),
  items AS MATERIALIZED (SELECT workspace_id,'message.stored' AS type,NULL::text AS mailbox_id,thread_id,id AS message_id,jsonb_strip_nulls(jsonb_build_object('contactId',c.contact_id,'clearedSuppressionReason',c.suppression_reason)) AS data,1 AS ord FROM stored s LEFT JOIN cleared c ON c.message_id=s.id
    UNION ALL SELECT workspace_id,'address.created',id,NULL,NULL,'{"origin":"auto"}'::jsonb,2 FROM boxes
    UNION ALL SELECT x.workspace_id,CASE WHEN is_spam THEN 'message.junk' ELSE 'message.received' END,a.mailbox_id,x.thread_id,x.id,jsonb_build_object('spam',x.spam,'automated',x.automated,'dmarc',dmarc::text),3
    FROM target x JOIN added a ON a.message_id=x.id JOIN summaries s ON s.mailbox_id=a.mailbox_id WHERE NOT ('unverified'=ANY(a.labels)) UNION ALL SELECT x.workspace_id,CASE WHEN is_spam THEN 'message.junk' ELSE 'message.received' END,NULL,x.thread_id,x.id,'{}'::jsonb,3 FROM target x
    WHERE EXISTS(SELECT FROM routes WHERE jsonb_array_length(item->'webhooks')>0) AND NOT EXISTS(SELECT FROM added WHERE NOT ('unverified'=ANY(labels)))), lanes AS (
    INSERT INTO mailbox_write_lanes(workspace_id,lane) SELECT DISTINCT workspace_id,'events' FROM items ORDER BY workspace_id
    ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane RETURNING workspace_id
  ), events AS (INSERT INTO mailbox_events(workspace_id,type,mailbox_id,thread_id,message_id,data)
    SELECT workspace_id,type,mailbox_id,thread_id,message_id,data FROM items JOIN lanes USING(workspace_id) ORDER BY workspace_id,ord RETURNING *
  ), subscribed AS (SELECT e.workspace_id,e.seq,e.type,h.id FROM events e
    CROSS JOIN LATERAL (SELECT id,event_types,mailbox_ids,junk,format,include FROM mailbox_webhooks WHERE workspace_id=e.workspace_id AND NOT paused AND event_types<>'[]' ORDER BY id LIMIT 32) h
    WHERE (e.mailbox_id IS NOT NULL OR e.type NOT IN ('message.received','message.junk')) AND (h.event_types ? e.type OR e.type='message.junk' AND h.event_types ? 'message.received') AND (NOT is_spam OR h.junk='include' OR (e.type='message.stored' AND h.format='bane' AND h.include='[]')) AND (h.mailbox_ids IS NULL OR (e.type<>'message.stored' AND h.mailbox_ids ? e.mailbox_id))),
  routed AS (SELECT DISTINCT ON (ref.id) ref.id,e.seq,e.workspace_id,r.addr,r.item->>'route' AS route FROM routes r CROSS JOIN jsonb_array_elements_text(r.item->'webhooks') ref(id)
    JOIN events e ON e.type IN ('message.received','message.junk') ORDER BY ref.id,EXISTS(SELECT FROM subscribed s WHERE s.id=ref.id AND s.seq=e.seq) DESC,(r.item->'inboxes' ? e.mailbox_id) DESC NULLS LAST,e.seq,r.n),
  subscriptions AS (SELECT workspace_id,seq,jsonb_agg(hook) AS hooks FROM (
    SELECT s.workspace_id,s.seq,to_jsonb(s.id) AS hook FROM subscribed s WHERE NOT EXISTS(SELECT FROM routed r WHERE r.id=s.id AND s.type IN ('message.received','message.junk'))
    UNION ALL SELECT workspace_id,seq,jsonb_build_object('id',id,'recipient',addr,'route',route) FROM routed) h GROUP BY workspace_id,seq),
  queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.fanout',workspace_id,jsonb_object_agg(seq::text,hooks) FROM subscriptions GROUP BY workspace_id RETURNING 1),
  owned_files AS (DELETE FROM mail_candidate_uploads u USING stored s WHERE u.batch=split_part(file_items->0->>'storageKey','/',5) AND u.workspace_id=s.workspace_id AND u.message_id=s.id AND u.keys[1]=file_items->0->>'storageKey')
  SELECT count(*)::int INTO queued_count FROM queued;
 wait_ms:=extract(epoch FROM locked-started)*1000; hold_ms:=extract(epoch FROM clock_timestamp()-locked)*1000; RETURN NEXT;
END $$;
