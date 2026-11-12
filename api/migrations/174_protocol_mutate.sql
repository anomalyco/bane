SET LOCAL lock_timeout='2s';
CREATE FUNCTION mailgw_mutate(w text,b text,src text,dst text,op text,uids bigint[],mode text,bits jsonb,labels text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e record; data jsonb; result jsonb; pairs jsonb:='[]'; validity bigint;
BEGIN
 IF op='expunge' THEN PERFORM inbox_lock_ingest(w); END IF;
 PERFORM FROM inbox_state WHERE workspace_id=w AND inbox_id=b FOR UPDATE;
 SELECT uid_validity INTO STRICT validity FROM inbox_folders WHERE inbox_id=b AND role=coalesce(dst,src);
 FOR e IN SELECT i.uid,i.deleted,i.message_id,l.labels FROM inbox_entries i JOIN mailbox_messages l ON l.mailbox_id=b AND l.message_id=i.message_id WHERE i.inbox_id=b AND i.role=src AND (uids IS NULL OR i.uid=ANY(uids)) AND (op<>'expunge' OR i.deleted) ORDER BY i.uid LOOP
  data:=jsonb_build_object('source',src,'uid',e.uid,'folder',dst);
  IF op='flags' THEN data:=data||bits||jsonb_build_object('addLabels',CASE WHEN mode='remove' THEN ARRAY[]::text[] ELSE labels END,'removeLabels',CASE WHEN mode='replace' THEN ARRAY(SELECT unnest(e.labels) EXCEPT SELECT unnest(labels)) WHEN mode='remove' THEN labels ELSE ARRAY[]::text[] END); END IF;
  result:=inbox_mutate(w,b,e.message_id,op,data);
  IF result?'error' THEN RAISE EXCEPTION 'Protocol batch refused' USING ERRCODE='22023'; END IF;
  IF result->>'uid' IS NOT NULL THEN pairs:=pairs||jsonb_build_array(jsonb_build_array(e.uid,result->'uid')); END IF;
 END LOOP;
 RETURN jsonb_build_object('pairs',pairs,'validity',validity);
END $$;
