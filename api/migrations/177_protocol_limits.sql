SET LOCAL lock_timeout='2s';
-- Caller holds the mailbox then inbox_state fence. A client append is unverified
-- local mail: it cannot grant the verified-author reply exemption or run routing.
-- The inbox_state row is already the writer fence. This bucket bounds successful
-- client APPENDs independently of SMTP caps and ordinary inbound delivery.
ALTER TABLE inbox_state ADD COLUMN protocol_append_window timestamptz, ADD COLUMN protocol_append_count int NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION mailgw_append(w text,b text,f text,mid text,tid text,client_id text,subj text,sender text,txt text,dt timestamptz,n int,bucket text,k text,mime jsonb,fl text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v bigint; u bigint; s bigint; seen boolean:='\Seen'=ANY(fl); bits int:=0; labels text[]; i int; standard text[]:=ARRAY['\Flagged','\Answered','\Draft','$Forwarded','$Junk','$NotJunk','$MDNSent'];
BEGIN
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 IF n>8388608 THEN RETURN '{"error":"OVERQUOTA"}'; END IF;
 SELECT uid_validity INTO STRICT v FROM inbox_folders WHERE inbox_id=b AND role=f;
 IF f='sent' AND client_id IS NOT NULL THEN SELECT e.uid INTO u FROM inbox_entries e JOIN mail_messages m ON m.id=e.message_id WHERE e.inbox_id=b AND e.role=f AND m.sender_mailbox_id=b AND m.message_id=client_id AND m.created_at>now()-interval '24 hours' LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(1,u))); END IF; END IF;
 SELECT ARRAY(SELECT x FROM unnest(fl) x WHERE NOT x=ANY(standard) AND x NOT IN ('\Seen','\Deleted','unverified','spam','guard-allowed') AND x ~ '^[$A-Za-z0-9_-]{1,64}$') INTO labels;
 FOR i IN 1..7 LOOP IF standard[i]=ANY(fl) THEN bits:=bits|(1<<(i-1)); END IF; END LOOP;
 UPDATE inbox_state SET protocol_append_count=CASE WHEN protocol_append_window=date_trunc('minute',now()) THEN protocol_append_count+1 ELSE 1 END,protocol_append_window=date_trunc('minute',now()) WHERE inbox_id=b AND (protocol_append_window IS DISTINCT FROM date_trunc('minute',now()) OR protocol_append_count<300);IF NOT FOUND THEN RETURN '{"error":"RATE_LIMIT"}'; END IF;
 UPDATE inbox_state st SET messages=messages+1,bytes=bytes+n,modseq=modseq+1 FROM mailboxes box WHERE st.inbox_id=b AND box.id=b AND st.messages<coalesce(box.quota_messages,100000) AND st.bytes+n<=coalesce(box.quota_bytes,1073741824) RETURNING st.modseq INTO s;
 IF NOT FOUND THEN RETURN '{"error":"OVERQUOTA"}'; END IF;
 INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES(tid,w,subj,1,dt);
 INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,subject,from_address,text,message_id,received_at,size_bytes,raw_bucket,raw_key,mime,verdicts) VALUES(mid,w,tid,'inbound','kept',subj,sender,txt,client_id,dt,n,bucket,k,mime,'{"origin":"client-append"}');
 INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,modseq,flags,labels,inbox_seq) VALUES(b,mid,w,tid,'inbound',seen,dt,s,bits,labels,nextval(pg_get_serial_sequence('mailbox_events','seq')));
 INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at) VALUES(b,tid,w,1,(NOT seen)::int,dt,dt);
 u:=inbox_add_entry(b,mid,f,s,seen,dt);IF '\Deleted'=ANY(fl) THEN UPDATE inbox_entries SET deleted=true WHERE inbox_id=b AND role=f AND uid=u; END IF;
 RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(0,u)));
END $$;

SET LOCAL lock_timeout='2s';
CREATE OR REPLACE FUNCTION mailgw_mutate(w text,b text,src text,dst text,op text,uids bigint[],mode text,bits jsonb,labels text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e record; data jsonb; result jsonb; pairs jsonb:='[]'; validity bigint;
BEGIN
 IF op='expunge' THEN PERFORM inbox_lock_ingest(w); END IF;
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT uid_validity INTO STRICT validity FROM inbox_folders WHERE inbox_id=b AND role=coalesce(dst,src);
 FOR e IN SELECT i.uid,i.deleted,i.message_id,l.labels FROM inbox_entries i JOIN mailbox_messages l ON l.mailbox_id=b AND l.message_id=i.message_id WHERE i.inbox_id=b AND i.role=src AND (uids IS NULL OR i.uid=ANY(uids)) AND (op<>'expunge' OR i.deleted) ORDER BY i.uid LOOP
  data:=jsonb_build_object('source',src,'uid',e.uid,'folder',dst);
  IF op='flags' THEN data:=data||bits||jsonb_build_object('addLabels',CASE WHEN mode='remove' THEN ARRAY[]::text[] ELSE labels END,'removeLabels',CASE WHEN mode='replace' THEN ARRAY(SELECT x FROM unnest(e.labels)x WHERE x ~ '^[$a-zA-Z0-9_-]{1,64}$' AND x NOT IN ('unverified','spam','guard-allowed') EXCEPT SELECT unnest(labels)) WHEN mode='remove' THEN labels ELSE ARRAY[]::text[] END); END IF;
  result:=inbox_mutate(w,b,e.message_id,op,data);
  IF result?'error' THEN RAISE EXCEPTION 'Protocol batch refused' USING ERRCODE='22023'; END IF;
  IF result->>'uid' IS NOT NULL THEN pairs:=pairs||jsonb_build_array(jsonb_build_array(e.uid,result->'uid')); END IF;
 END LOOP;
 RETURN jsonb_build_object('pairs',pairs,'validity',validity);
END $$;

CREATE OR REPLACE FUNCTION inbox_protocol_meter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN UPDATE inbox_protocol_periods SET ended_at=clock_timestamp() WHERE inbox_id=OLD.inbox_id AND ended_at IS NULL;
 ELSIF OLD.protocol_passwords=0 AND NEW.protocol_passwords>0 THEN INSERT INTO inbox_protocol_periods VALUES(NEW.workspace_id,NEW.inbox_id,clock_timestamp(),NULL);
 ELSIF OLD.protocol_passwords>0 AND NEW.protocol_passwords=0 THEN UPDATE inbox_protocol_periods SET ended_at=clock_timestamp() WHERE inbox_id=NEW.inbox_id AND ended_at IS NULL;
 END IF;
 IF TG_OP='DELETE' OR NEW.protocol_passwords<OLD.protocol_passwords THEN PERFORM pg_notify('bane_protocol_auth',OLD.inbox_id); END IF; RETURN NULL;
END $$;
