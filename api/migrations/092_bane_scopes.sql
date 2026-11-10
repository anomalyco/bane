SET LOCAL lock_timeout='1s';

-- Rewrite exact scope tokens only. Preserve order, unknown scopes, NULLs and the
-- original workspace/member ceiling embedded in a consent reference.
CREATE OR REPLACE FUNCTION pg_temp.bane_scopes(s text[]) RETURNS text[] LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT array_replace(array_replace(array_replace(array_replace(s,
    'opensend:read','bane:read'),'opensend:send','bane:send'),'opensend:manage','bane:manage'),'opensend:live','bane:live')
$$;
CREATE OR REPLACE FUNCTION pg_temp.bane_reference(r text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN r ~ '^mcp_(v2_)?[0-9a-f-]{36}\|' THEN split_part(r,'|',1) || '|' ||
    array_to_string(pg_temp.bane_scopes(string_to_array(split_part(r,'|',2),' ')), ' ') ||
    substring(r FROM length(split_part(r,'|',1))+length(split_part(r,'|',2))+2) ELSE r END
$$;

UPDATE oauth_client SET scopes=pg_temp.bane_scopes(scopes), client_credentials_scopes=pg_temp.bane_scopes(client_credentials_scopes)
  WHERE scopes <> pg_temp.bane_scopes(scopes) OR client_credentials_scopes <> pg_temp.bane_scopes(client_credentials_scopes);
UPDATE oauth_resource SET allowed_scopes=pg_temp.bane_scopes(allowed_scopes) WHERE allowed_scopes <> pg_temp.bane_scopes(allowed_scopes);
UPDATE oauth_consent SET scopes=pg_temp.bane_scopes(scopes), reference_id=pg_temp.bane_reference(reference_id)
  WHERE scopes <> pg_temp.bane_scopes(scopes) OR reference_id <> pg_temp.bane_reference(reference_id);
UPDATE oauth_access_token SET scopes=pg_temp.bane_scopes(scopes), reference_id=pg_temp.bane_reference(reference_id)
  WHERE scopes <> pg_temp.bane_scopes(scopes) OR reference_id <> pg_temp.bane_reference(reference_id);
UPDATE oauth_refresh_token SET scopes=pg_temp.bane_scopes(scopes), reference_id=pg_temp.bane_reference(reference_id)
  WHERE scopes <> pg_temp.bane_scopes(scopes) OR reference_id <> pg_temp.bane_reference(reference_id);
