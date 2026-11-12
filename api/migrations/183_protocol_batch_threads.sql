SET LOCAL lock_timeout='2s';
-- The gateway sends large protocol mutations ("mark all read", "empty Trash") in batches
-- of at most 1,000 UIDs, one statement each. Refreshing a message's thread after every
-- entry made a batch cost entries x thread size (a 50k-message thread: 50M rows per batch).
-- Refresh each touched thread once per batch instead: the same transaction and the same
-- final thread state; held messages stay excluded as inbox_mutate excludes them.
CREATE OR REPLACE FUNCTION mailgw_mutate(w text,b text,src text,dst text,op text,uids bigint[],mode text,bits jsonb,labels text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e record; data jsonb; result jsonb; pairs jsonb:='[]'; validity bigint; threads text[]:='{}'; prior text;
BEGIN
 IF op='expunge' THEN PERFORM inbox_lock_ingest(w); END IF;
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT uid_validity INTO STRICT validity FROM inbox_folders WHERE inbox_id=b AND role=coalesce(dst,src);
 FOR e IN SELECT i.uid,i.deleted,i.message_id,l.labels,l.thread_id,l.held_reason FROM inbox_entries i JOIN mailbox_messages l ON l.mailbox_id=b AND l.message_id=i.message_id WHERE i.inbox_id=b AND i.role=src AND (uids IS NULL OR i.uid=ANY(uids)) AND (op<>'expunge' OR i.deleted) ORDER BY i.uid LOOP
  data:=jsonb_build_object('source',src,'uid',e.uid,'folder',dst);
  IF op='flags' THEN data:=data||bits||jsonb_build_object('addLabels',CASE WHEN mode='remove' THEN ARRAY[]::text[] ELSE labels END,'removeLabels',CASE WHEN mode='replace' THEN ARRAY(SELECT x FROM unnest(e.labels)x WHERE x ~ '^[$a-zA-Z0-9_-]{1,64}$' AND x NOT IN ('unverified','spam','guard-allowed') EXCEPT SELECT unnest(labels)) WHEN mode='remove' THEN labels ELSE ARRAY[]::text[] END); END IF;
  result:=inbox_mutate(w,b,e.message_id,op,data,false);
  IF result?'error' THEN RAISE EXCEPTION 'Protocol batch refused' USING ERRCODE='22023'; END IF;
  IF e.held_reason IS NULL AND e.thread_id IS NOT NULL AND NOT e.thread_id=ANY(threads) THEN threads:=threads||e.thread_id; END IF;
  IF result->>'uid' IS NOT NULL THEN pairs:=pairs||jsonb_build_array(jsonb_build_array(e.uid,result->'uid')); END IF;
 END LOOP;
 -- Thread summaries are written under the folder writer's marker (140, 148), as inbox_mutate does.
 prior:=current_setting('bane.inbox_writer',true);
 PERFORM set_config('bane.inbox_writer','folders',true);
 PERFORM inbox_refresh_thread(b,t) FROM unnest(threads) t;
 PERFORM set_config('bane.inbox_writer',coalesce(prior,''),true);
 RETURN jsonb_build_object('pairs',pairs,'validity',validity);
END $$;

-- A signed write can queue behind revocation/deletion after its caller resolved
-- the password. Reauthorize in a fresh snapshot while holding the writer fence.
CREATE FUNCTION mailgw_write_allowed(w text,b text,k text,policy jsonb,ingest boolean) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
 IF ingest THEN PERFORM inbox_lock_ingest(w); END IF;
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT FROM inbox_app_passwords p WHERE p.id=k AND p.inbox_id=b AND p.revoked_at IS NULL
   AND 'imap'=ANY(p.protocols) AND NOT EXISTS(SELECT FROM mail_grant_objects g WHERE g.kind='protocol'
   AND g.workspace_id=w AND g.resource=k AND NOT mail_receiving_grant(w,g.grant_id,policy)));
END $$;
