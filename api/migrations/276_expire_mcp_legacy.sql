SET LOCAL lock_timeout='2s';
INSERT INTO bane_expired_approvals(id,user_id,client_id,name,scopes,created_at,updated_at)
SELECT 'legacy_'||c.id,c.user_id,c.client_id,k.name,c.scopes,c.created_at,c.updated_at
FROM oauth_consent c JOIN oauth_client k USING(client_id) WHERE c.user_id IS NOT NULL
ON CONFLICT(id) DO NOTHING;
UPDATE oauth_consent SET retired_at=now() WHERE retired_at IS NULL;
UPDATE oauth_client SET disabled=true WHERE disabled IS DISTINCT FROM true;
UPDATE oauth_access_token SET revoked=coalesce(revoked,now()),expires_at=least(expires_at,now());
UPDATE oauth_refresh_token SET revoked=coalesce(revoked,now()),expires_at=least(expires_at,now()),rotation_replay_response=NULL;
UPDATE agent_tokens t SET revoked_at=now() WHERE revoked_at IS NULL AND NOT EXISTS(SELECT FROM bane_resource_grants g WHERE g.id=t.grant_id);
-- What a retired approval created (API keys, inbox keys, gateway app passwords,
-- routes, endpoints, webhooks) keeps working as an ordinary workspace object:
-- owners and admins still list and revoke each one in the dashboard. Record the
-- detached rows first, then delete them with the ownership triggers off, so the
-- triggers that would disable, pause or recompile them do not fire.
CREATE TABLE IF NOT EXISTS bane_retired_grant_objects(grant_id text NOT NULL,workspace_id text NOT NULL,kind text NOT NULL,resource text NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(grant_id,workspace_id,kind,resource));
INSERT INTO bane_retired_grant_objects(grant_id,workspace_id,kind,resource)
SELECT o.grant_id,o.workspace_id,o.kind,o.resource FROM mail_grant_objects o
WHERE NOT EXISTS(SELECT FROM bane_resource_grants g WHERE g.grant_key=o.grant_id) ON CONFLICT DO NOTHING;
ALTER TABLE mail_grant_objects DISABLE TRIGGER USER;
DELETE FROM mail_grant_objects o WHERE NOT EXISTS(SELECT FROM bane_resource_grants g WHERE g.grant_key=o.grant_id);
ALTER TABLE mail_grant_objects ENABLE TRIGGER USER;
