SET LOCAL lock_timeout='2s';
-- Caller holds the mailbox then inbox_state fence. A client append is unverified
-- local mail: it cannot grant the verified-author reply exemption or run routing.
CREATE FUNCTION mailgw_append(w text,b text,f text,mid text,tid text,client_id text,subj text,sender text,txt text,dt timestamptz,n int,bucket text,k text,mime jsonb,fl text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v bigint; u bigint; s bigint; seen boolean:='\Seen'=ANY(fl); bits int:=0; labels text[]; i int; standard text[]:=ARRAY['\Flagged','\Answered','\Draft','$Forwarded','$Junk','$NotJunk','$MDNSent'];
BEGIN
 PERFORM FROM inbox_state WHERE inbox_id=b AND workspace_id=w FOR UPDATE; IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT uid_validity INTO STRICT v FROM inbox_folders WHERE inbox_id=b AND role=f;
 IF f='sent' AND client_id IS NOT NULL THEN SELECT e.uid INTO u FROM inbox_entries e JOIN mail_messages m ON m.id=e.message_id WHERE e.inbox_id=b AND e.role=f AND m.sender_mailbox_id=b AND m.message_id=client_id AND m.created_at>now()-interval '24 hours' LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(1,u))); END IF; END IF;
 SELECT ARRAY(SELECT x FROM unnest(fl) x WHERE NOT x=ANY(standard) AND x NOT IN ('\Seen','\Deleted','unverified','spam','guard-allowed') AND x ~ '^[$A-Za-z0-9_-]{1,64}$') INTO labels;
 FOR i IN 1..7 LOOP IF standard[i]=ANY(fl) THEN bits:=bits|(1<<(i-1)); END IF; END LOOP;
 UPDATE inbox_state st SET messages=messages+1,bytes=bytes+n,modseq=modseq+1 FROM mailboxes box WHERE st.inbox_id=b AND box.id=b AND (box.quota_messages IS NULL OR st.messages<box.quota_messages) AND (box.quota_bytes IS NULL OR st.bytes+n<=box.quota_bytes) RETURNING st.modseq INTO s;
 IF NOT FOUND THEN RETURN '{"error":"OVERQUOTA"}'; END IF;
 INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES(tid,w,subj,1,dt);
 INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,subject,from_address,text,message_id,received_at,size_bytes,raw_bucket,raw_key,mime) VALUES(mid,w,tid,'inbound','kept',subj,sender,txt,client_id,dt,n,bucket,k,mime);
 INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,modseq,flags,labels,inbox_seq) VALUES(b,mid,w,tid,'inbound',seen,dt,s,bits,labels,nextval(pg_get_serial_sequence('mailbox_events','seq')));
 INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at) VALUES(b,tid,w,1,(NOT seen)::int,dt,dt);
 u:=inbox_add_entry(b,mid,f,s,seen,dt);IF '\Deleted'=ANY(fl) THEN UPDATE inbox_entries SET deleted=true WHERE inbox_id=b AND role=f AND uid=u; END IF;
 RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(0,u)));
END $$;
