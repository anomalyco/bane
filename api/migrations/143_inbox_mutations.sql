SET LOCAL lock_timeout='2s';

-- Recompute a single conversation only, under the inbox lock. Copies are not new
-- messages and cannot inflate unread or message counts in the conversation view.
CREATE FUNCTION inbox_refresh_thread(bid text,tid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 UPDATE mailbox_threads t SET message_count=a.n,unread_count=a.unread,archived=a.archive,
  starred=a.starred,spam=a.junk,trashed_at=CASE WHEN a.trash THEN coalesce(t.trashed_at,now()) END,
  last_message_at=coalesce(a.last_at,t.last_message_at),last_inbound_at=a.last_in
 FROM (SELECT count(*) n,count(*) FILTER(WHERE NOT m.read) unread,bool_or((m.flags&1)>0) starred,
  bool_and('archive'=ANY(e.roles) AND NOT 'inbox'=ANY(e.roles)) archive,
  bool_and('junk'=ANY(e.roles)) junk,bool_and('trash'=ANY(e.roles)) trash,
  max(m.received_at) last_at,max(m.received_at) FILTER(WHERE m.direction='inbound') last_in
  FROM mailbox_messages m CROSS JOIN LATERAL (SELECT ARRAY(SELECT role FROM inbox_entries WHERE inbox_id=bid AND message_id=m.message_id) roles)e
  WHERE m.mailbox_id=bid AND m.thread_id=tid AND m.held_reason IS NULL)a
 WHERE t.mailbox_id=bid AND t.thread_id=tid AND a.n>0;
 IF NOT FOUND THEN DELETE FROM mailbox_threads WHERE mailbox_id=bid AND thread_id=tid; END IF;
END $$;

-- Existing thread UI/API and the protocol share the same writer. Do not acquire the
-- summary row before inbox_state: ingest takes those locks in the opposite order.
CREATE FUNCTION inbox_patch_thread(wid text,bid text,tid text,p jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE m record; e record; changes jsonb; dest text; newest text;
BEGIN
 PERFORM FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.workspace_id=wid AND s.inbox_id=bid AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) FOR UPDATE OF s;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM mailbox_threads WHERE mailbox_id=bid AND thread_id=tid) THEN RETURN false; END IF;
 SELECT message_id INTO newest FROM mailbox_messages WHERE mailbox_id=bid AND thread_id=tid AND direction='inbound' AND held_reason IS NULL ORDER BY received_at DESC,message_id LIMIT 1;
 FOR m IN SELECT message_id,direction FROM mailbox_messages WHERE mailbox_id=bid AND thread_id=tid AND held_reason IS NULL ORDER BY message_id LOOP
  changes:=jsonb_strip_nulls(jsonb_build_object('read',CASE WHEN p->>'read'='true' OR newest=m.message_id THEN p->'read' END,'flagged',p->'starred','addLabels',p->'addLabels','removeLabels',p->'removeLabels'));
  IF changes<>'{}' AND inbox_mutate(wid,bid,m.message_id,'flags',changes,false) ? 'error' THEN RAISE EXCEPTION 'Invalid thread flag or label change' USING ERRCODE='22023'; END IF;
  FOR e IN SELECT role,uid FROM inbox_entries WHERE inbox_id=bid AND message_id=m.message_id ORDER BY role,uid LOOP
    dest:=CASE WHEN p->>'trashed'='true' THEN 'trash' WHEN p->>'spam'='true' THEN 'junk' WHEN p->>'archived'='true' THEN 'archive'
      WHEN e.role='trash' AND p->>'trashed'='false' OR e.role='junk' AND p->>'spam'='false' OR e.role='archive' AND p->>'archived'='false' THEN CASE WHEN m.direction='outbound' THEN 'sent' ELSE 'inbox' END END;
    IF e.role<>dest THEN PERFORM inbox_mutate(wid,bid,m.message_id,'move',jsonb_build_object('source',e.role,'uid',e.uid,'folder',dest),false); END IF;
  END LOOP;
 END LOOP;
 PERFORM inbox_refresh_thread(bid,tid);
 UPDATE mailbox_threads SET labels=ARRAY(SELECT DISTINCT label FROM unnest(labels||ARRAY(SELECT jsonb_array_elements_text(p->'addLabels'))) label WHERE NOT coalesce(p->'removeLabels' ? label,false) LIMIT 50) WHERE mailbox_id=bid AND thread_id=tid;
 RETURN true;
END $$;

CREATE FUNCTION inbox_mutate(wid text,bid text,mid text,op text,p jsonb,refresh boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m mailbox_messages; ent inbox_entries; stamp bigint; source text:=p->>'source'; dest text:=p->>'folder';
 seen boolean; bits int; bit_names text[]:=ARRAY['flagged','answered','draft','forwarded','junk','notJunk','mdnSent']; i int; allocated bigint; gone boolean:=false; keywords text[];
BEGIN
 PERFORM FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.workspace_id=wid AND s.inbox_id=bid AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) FOR UPDATE OF s;
 IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT * INTO m FROM mailbox_messages WHERE workspace_id=wid AND mailbox_id=bid AND message_id=mid;
 IF NOT FOUND THEN RETURN '{"error":"MESSAGE_GONE"}'; END IF;
 IF m.modseq>(p->>'ifModseq')::bigint THEN RETURN '{"error":"MODIFIED"}'; END IF;
 IF op IN ('move','copy','expunge') OR p?'deleted' THEN
  SELECT * INTO ent FROM inbox_entries WHERE inbox_id=bid AND message_id=mid AND (source IS NULL OR role=source) AND (p->>'uid' IS NULL OR uid=(p->>'uid')::bigint) ORDER BY role,uid LIMIT 1;
  IF NOT FOUND THEN RETURN '{"error":"MESSAGE_GONE"}'; END IF;
  IF EXISTS(SELECT FROM inbox_entries WHERE inbox_id=bid AND message_id=mid AND (source IS NULL OR role=source) AND (p->>'uid' IS NULL OR uid=(p->>'uid')::bigint) AND (role,uid)<>(ent.role,ent.uid)) THEN RETURN '{"error":"AMBIGUOUS_ENTRY"}'; END IF;
 END IF;
 seen:=coalesce((p->>'read')::boolean,m.read); bits:=m.flags;
 FOR i IN 1..array_length(bit_names,1) LOOP
  IF p?bit_names[i] THEN bits:=CASE WHEN (p->>bit_names[i])::boolean THEN bits|(1<<(i-1)) ELSE bits&(~(1<<(i-1))) END; END IF;
 END LOOP;
 keywords:=m.labels;
 IF p?'addLabels' OR p?'removeLabels' THEN
  SELECT ARRAY(SELECT DISTINCT lbl FROM unnest(m.labels||ARRAY(SELECT value FROM jsonb_array_elements_text(p->'addLabels') WHERE value NOT IN ('unverified','spam','guard-allowed'))) lbl WHERE NOT coalesce(p->'removeLabels' ? lbl,false) OR lbl IN ('unverified','spam','guard-allowed') ORDER BY lbl) INTO keywords;
  IF cardinality(keywords)>64 THEN RETURN '{"error":"LABEL_LIMIT"}'; END IF;
 END IF;
 UPDATE inbox_state SET modseq=modseq+1 WHERE inbox_id=bid RETURNING modseq INTO stamp;
 IF op='flags' THEN
  UPDATE inbox_folders f SET highest_modseq=stamp,unseen=f.unseen+ CASE WHEN m.read=seen THEN 0 WHEN seen THEN -a.n ELSE a.n END
   FROM (SELECT role,count(*)::int n FROM inbox_entries WHERE inbox_id=bid AND message_id=mid AND (m.read<>seen OR bits<>m.flags OR keywords<>m.labels OR NOT p?'deleted' OR (role,uid)=(ent.role,ent.uid)) GROUP BY role)a
   WHERE f.inbox_id=bid AND f.role=a.role;
  UPDATE inbox_entries SET modseq=stamp,deleted=CASE WHEN (role,uid)=(ent.role,ent.uid) THEN coalesce((p->>'deleted')::boolean,deleted) ELSE deleted END
   WHERE inbox_id=bid AND message_id=mid AND (m.read<>seen OR bits<>m.flags OR keywords<>m.labels OR NOT p?'deleted' OR (role,uid)=(ent.role,ent.uid));
 ELSE
  IF op IN ('move','copy') THEN
   allocated:=inbox_add_entry(bid,mid,dest,stamp,seen,ent.internal_date);
   IF ent.deleted THEN UPDATE inbox_entries SET deleted=true WHERE inbox_id=bid AND role=dest AND uid=allocated; END IF;
  END IF;
  IF op IN ('move','expunge') THEN
   DELETE FROM inbox_entries WHERE inbox_id=bid AND (role,uid)=(ent.role,ent.uid);
   INSERT INTO inbox_vanished(inbox_id,role,uid,message_id,modseq) VALUES(bid,ent.role,ent.uid,mid,stamp);
   UPDATE inbox_folders SET highest_modseq=stamp,total=total-1,unseen=unseen-(NOT m.read)::int WHERE inbox_id=bid AND role=ent.role;
   IF op='expunge' AND NOT EXISTS(SELECT FROM inbox_entries WHERE inbox_id=bid AND message_id=mid) THEN
    DELETE FROM mailbox_messages WHERE mailbox_id=bid AND message_id=mid;
    UPDATE inbox_state SET messages=greatest(messages-1,0),bytes=greatest(bytes-coalesce((SELECT size_bytes FROM mail_messages WHERE id=mid),0),0) WHERE inbox_id=bid;
    INSERT INTO mail_gc_candidates(workspace_id,message_id) VALUES(wid,mid) ON CONFLICT DO NOTHING; gone:=true;
   END IF;
  END IF;
 END IF;
 IF NOT gone THEN UPDATE mailbox_messages SET modseq=stamp,flags=bits,read=seen,
   labels=keywords
   WHERE mailbox_id=bid AND message_id=mid; END IF;
 IF refresh AND m.held_reason IS NULL THEN PERFORM inbox_refresh_thread(bid,m.thread_id); END IF;
 RETURN jsonb_build_object('id',mid,'read',seen,'modseq',stamp::text,'uid',allocated,'removed',gone);
END $$;

CREATE FUNCTION inbox_expunge_folder(wid text,bid text,folder text,only_uids bigint[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e record; n int:=0;
BEGIN
 PERFORM FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.workspace_id=wid AND s.inbox_id=bid AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) FOR UPDATE OF s;
 IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 FOR e IN SELECT uid,message_id FROM inbox_entries WHERE inbox_id=bid AND role=folder AND deleted AND (only_uids IS NULL OR uid=ANY(only_uids)) ORDER BY uid LIMIT 501 LOOP
  IF n=500 THEN RETURN jsonb_build_object('expunged',n,'hasMore',true); END IF;
  PERFORM inbox_mutate(wid,bid,e.message_id,'expunge',jsonb_build_object('source',folder,'uid',e.uid)); n:=n+1;
 END LOOP;
 RETURN jsonb_build_object('expunged',n,'hasMore',false);
END $$;

-- Expunge history is sync metadata, not retained mail. Keep a durable floor: a
-- disconnected client must resync, never silently miss a removal after pruning.
CREATE FUNCTION inbox_prune_vanished() RETURNS int LANGUAGE plpgsql AS $$
DECLARE bid text; n int;
BEGIN
 SELECT inbox_id INTO bid FROM inbox_vanished WHERE vanished_at<now()-interval '30 days' ORDER BY vanished_at LIMIT 1;
 IF bid IS NULL THEN RETURN 0; END IF;
 PERFORM FROM inbox_state WHERE inbox_id=bid FOR UPDATE;
 WITH page AS (SELECT role,uid FROM inbox_vanished WHERE inbox_id=bid AND vanished_at<now()-interval '30 days' ORDER BY modseq LIMIT 1000),
 gone AS (DELETE FROM inbox_vanished v USING page p WHERE v.inbox_id=bid AND (v.role,v.uid)=(p.role,p.uid) RETURNING modseq),
 floor AS (UPDATE inbox_state SET changes_floor=greatest(changes_floor,(SELECT max(modseq) FROM gone)) WHERE inbox_id=bid)
 SELECT count(*) INTO n FROM gone;
 RETURN n;
END $$;
