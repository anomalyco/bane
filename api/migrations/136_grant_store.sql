SET LOCAL lock_timeout='2s';
-- A claim can race revocation. Reclaim before committing any local decision; queued work carries the same ceiling.
ALTER FUNCTION mail_store_incoming(jsonb,jsonb,jsonb,jsonb,boolean,boolean,jsonb) RENAME TO mail_store_ritual_plan;
CREATE FUNCTION mail_store_incoming(msg jsonb,file_items jsonb,refs_json jsonb,envelopes jsonb,authenticated_from boolean,can_create boolean,plan jsonb) RETURNS TABLE(queued_count integer,wait_ms double precision,hold_ms double precision) LANGUAGE plpgsql AS $$
DECLARE gid text;
BEGIN
 FOR gid IN SELECT jsonb_array_elements_text(plan->'grants') LOOP
   PERFORM 1 FROM oauth_consent WHERE id=gid AND scopes @> ARRAY['bane:manage'] FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Ritual grant revoked; reclaim receipt' USING ERRCODE='40001'; END IF;
 END LOOP;
 RETURN QUERY SELECT * FROM mail_store_ritual_plan(msg,file_items,refs_json,envelopes,authenticated_from,can_create,plan);
END $$;

ALTER FUNCTION mail_route_input(text,jsonb,boolean) RENAME TO mail_route_input_unfenced;
CREATE FUNCTION mail_route_input(w text, recipients jsonb,force_read boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE p jsonb; grants jsonb;
BEGIN
 p:=mail_route_input_unfenced(w,recipients,force_read); IF p IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_agg(DISTINCT grant_id) INTO grants FROM mail_grant_objects WHERE workspace_id=w AND kind='route' AND resource IN (SELECT value->>'id' FROM jsonb_each(nullif(p->'exact','null')) UNION SELECT r->>'id' FROM jsonb_each(nullif(p->'hosts','null')) h CROSS JOIN jsonb_array_elements(h.value->'patterns') r);
 RETURN CASE WHEN grants IS NULL THEN p ELSE p||jsonb_build_object('grants',grants) END;
END $$;
