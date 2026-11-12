INSERT INTO bane_expired_approvals(id,user_id,client_id,name,scopes,created_at,updated_at)
SELECT 'legacy_'||c.id,c.user_id,c.client_id,k.name,c.scopes,c.created_at,c.updated_at
FROM oauth_consent c JOIN oauth_client k USING(client_id) WHERE c.user_id IS NOT NULL
ON CONFLICT(id) DO NOTHING;
UPDATE oauth_consent SET retired_at=now() WHERE retired_at IS NULL;
UPDATE oauth_client SET disabled=true WHERE disabled IS DISTINCT FROM true;
UPDATE oauth_access_token SET revoked=coalesce(revoked,now()),expires_at=least(expires_at,now());
UPDATE oauth_refresh_token SET revoked=coalesce(revoked,now()),expires_at=least(expires_at,now()),rotation_replay_response=NULL;
UPDATE agent_tokens t SET revoked_at=now() WHERE revoked_at IS NULL AND NOT EXISTS(SELECT FROM bane_resource_grants g WHERE g.id=t.grant_id);
-- Ownership delete triggers disable the concrete API keys, mailbox keys, routes
-- and endpoints. Leave independently created keys alone.
DELETE FROM mail_grant_objects o WHERE NOT EXISTS(SELECT FROM bane_resource_grants g WHERE g.grant_key=o.grant_id);
