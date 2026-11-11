SET LOCAL lock_timeout='2s';
-- Called inside the existing claim and store statements. A positive decision locks the identity
-- and policy rows until that statement commits; the store must recheck a claim's decision.
CREATE FUNCTION mail_management_grant(w text,gid text,policy jsonb,needs_receiving boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT FROM oauth_consent c JOIN oauth_client k USING(client_id)
  JOIN oauth_client_resource cr USING(client_id) JOIN oauth_resource r ON r.identifier=cr.resource_id
  JOIN auth_user u ON u.id=c.user_id JOIN auth_account a ON a.user_id=u.id AND a.provider_id='google' AND a.account_id<>''
  JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=w AND m.role IN ('owner','admin')
  WHERE c.id=gid AND r.identifier=$3->>'resource' AND c.resources=ARRAY[r.identifier]
  AND (NOT needs_receiving OR right(c.reference_id,10)='|receiving')
  AND regexp_replace(c.reference_id,'\|receiving$','') ~ '^mcp_(v2_)?[0-9a-f-]{36}\|[^|]+(\|[A-Za-z0-9_.-]+)?$'
  AND coalesce(nullif(split_part(regexp_replace(c.reference_id,'\|receiving$',''),'|',3),''),'default')=w
  AND string_to_array(split_part(c.reference_id,'|',2),' ') <@ ARRAY['bane:read','bane:send','bane:manage','bane:live','opensend:read','opensend:send','opensend:manage','opensend:live','offline_access']
  AND string_to_array(split_part(c.reference_id,'|',2),' ') && ARRAY['bane:manage','opensend:manage'] AND c.scopes && ARRAY['bane:manage','opensend:manage']
  AND NOT coalesce(k.disabled,false) AND NOT coalesce(r.disabled,false)
  AND (k.scopes IS NULL OR k.scopes && ARRAY['bane:manage','opensend:manage']) AND (r.allowed_scopes IS NULL OR r.allowed_scopes && ARRAY['bane:manage','opensend:manage'])
  AND (starts_with(c.reference_id,'mcp_v2_') OR (string_to_array(split_part(c.reference_id,'|',2),' ') && ARRAY['bane:live','opensend:live'] AND c.scopes && ARRAY['bane:live','opensend:live'] AND (k.scopes IS NULL OR k.scopes && ARRAY['bane:live','opensend:live']) AND (r.allowed_scopes IS NULL OR r.allowed_scopes && ARRAY['bane:live','opensend:live'])))
  AND u.email_verified AND u.email<>'' AND (($3->>'hosted')::boolean OR $3->'emails' ? lower(u.email) OR $3->'domains' ? nullif(lower(u.google_hosted_domain),'')) FOR SHARE);
$$;
CREATE FUNCTION mail_receiving_grant(w text,gid text,policy jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT mail_management_grant(w,gid,policy,true);
$$;

-- An independent key has no owner. Only derived keys enter the locking OAuth check.
CREATE FUNCTION mail_key_grant_allows(w text,kid text,object_kind text,policy jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT NOT EXISTS(SELECT FROM mail_grant_objects g WHERE g.workspace_id=w AND g.resource=kid AND g.kind=object_kind
   AND NOT mail_management_grant(w,g.grant_id,policy,object_kind='key'));
$$;

ALTER FUNCTION mail_store_incoming(jsonb,jsonb,jsonb,jsonb,boolean,boolean,jsonb) RENAME TO mail_store_ritual_plan;
CREATE FUNCTION mail_store_incoming(msg jsonb,file_items jsonb,refs_json jsonb,envelopes jsonb,authenticated_from boolean,can_create boolean,plan jsonb,policy jsonb DEFAULT NULL) RETURNS TABLE(queued_count integer,wait_ms double precision,hold_ms double precision) LANGUAGE plpgsql AS $$
DECLARE gid text;
BEGIN
 FOR gid IN SELECT jsonb_array_elements_text(plan->'grants') LOOP
   IF NOT mail_receiving_grant(msg->>'workspace_id',gid,policy) THEN RAISE EXCEPTION 'Grant changed; reclaim receipt' USING ERRCODE='40001'; END IF;
 END LOOP;
 RETURN QUERY SELECT * FROM mail_store_ritual_plan(msg,file_items,refs_json,envelopes,authenticated_from,can_create,plan);
END $$;

ALTER FUNCTION mail_route_input(text,jsonb,boolean) RENAME TO mail_route_input_unfenced;
CREATE FUNCTION mail_route_input(w text, recipients jsonb,force_read boolean DEFAULT false,policy jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p jsonb; route_owners jsonb; live jsonb;
BEGIN
 p:=mail_route_input_unfenced(w,recipients,force_read); IF p IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_object_agg(resource,ids) INTO route_owners FROM (SELECT resource,jsonb_agg(grant_id) AS ids FROM mail_grant_objects WHERE workspace_id=w AND kind='route' AND resource IN (SELECT value->>'id' FROM jsonb_each(nullif(p->'exact','null')) UNION SELECT r->>'id' FROM jsonb_each(nullif(p->'hosts','null')) h CROSS JOIN jsonb_array_elements(h.value->'patterns') r) GROUP BY resource) owners;
 SELECT jsonb_agg(gid) INTO live FROM (SELECT jsonb_array_elements_text(value) AS gid FROM jsonb_each(route_owners) UNION SELECT value FROM jsonb_each_text(p#>'{programs,owners}') WHERE value IS NOT NULL) deps WHERE mail_receiving_grant(w,gid,policy);
 RETURN p||jsonb_strip_nulls(jsonb_build_object('routeOwners',route_owners,'grants',live));
END $$;
