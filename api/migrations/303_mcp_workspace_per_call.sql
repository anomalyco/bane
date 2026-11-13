SET LOCAL lock_timeout='2s';
-- MCP tools act in the workspace each call names (src/mcp.ts), checked against the person's membership and role there
-- on every call. An approval (one per account and client) no longer belongs to one workspace: workspace_id is now the
-- connection's default workspace for calls that name none (setDefaultWorkspace, Settings), and may be empty. Receiving
-- tools follow the role instead of a checkbox: an owner or admin, with the bane:manage scope. The receiving column is no
-- longer read (dropped in a later release, once no running build reads it).
--
-- What an approval created stays tied to it in the workspace it was created in (mail_grant_objects.workspace_id): it is
-- active while the approval is, and its person is an owner or admin there with manage. That is the same rule as before
-- for every approval, except one whose receiving consent was turned off: its receiving objects were held, and would come
-- back under the role rule. Hold them for good instead: delete their ownership rows, which pauses the endpoints and
-- protocol passwords, disables the routes and revokes the inbox keys, as removing the approval does. (Ritual parts such
-- an approval saved are owned in mail_ritual_configs, not here: they follow the role rule like every other approval's.)
DELETE FROM mail_grant_objects o USING bane_resource_grants g
  WHERE g.grant_key = o.grant_id AND NOT g.receiving AND o.kind IN ('endpoint', 'route', 'key', 'protocol');

CREATE OR REPLACE FUNCTION mail_management_grant(w text,gid text,policy jsonb,needs_receiving boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  -- Same rule as externalMcpGrant: the approval is active, and its subject (admitted, and on self-hosted installations
  -- allowlisted) is an owner or admin of w with manage. Receiving needs nothing more. The address is not an input.
  SELECT EXISTS(SELECT FROM bane_resource_grants g
    JOIN bane_oidc_identities i USING(issuer,subject) JOIN bane_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.user_id=i.user_id AND m.workspace_id=w
    WHERE g.grant_key=gid AND g.issuer=policy->>'issuer' AND g.expires_at>now() AND NOT g.revoked
    AND (coalesce((policy->>'hosted')::boolean,false) OR coalesce(policy->'subjects','[]'::jsonb) ? i.subject)
    AND m.role IN ('owner','admin') AND 'manage'=ANY(g.permissions) FOR SHARE OF g,i,u,m);
$$;
-- The account service's consent behind the newest token (its access tokens' jti is <consent>.<random>), and the
-- consents revoked in Bane. Revoking in Bane blocks the tokens of the consents it had; a new sign-in at the account
-- service (a new consent) brings the approval back, so a client with a fixed client_id (a metadata document, such as
-- OpenCode's) can be connected again.
ALTER TABLE bane_resource_grants ADD COLUMN issuer_grant text, ADD COLUMN revoked_issuer_grants text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN bane_resource_grants.workspace_id IS 'The MCP connection''s default workspace for tool calls that name none; empty: the person''s only workspace, else their last-used one.';
