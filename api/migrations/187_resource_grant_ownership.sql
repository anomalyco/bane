-- A derived API key keeps its originating approval. Historical object rows
-- retain their IDs and cannot authorize through a retired grant.
ALTER TABLE bane_resource_grants ADD COLUMN grant_key text GENERATED ALWAYS AS (substr(id,5)) STORED UNIQUE;
ALTER TABLE bane_resource_grants ADD COLUMN receiving boolean NOT NULL DEFAULT false;
ALTER TABLE mail_grant_objects DROP CONSTRAINT mail_grant_objects_grant_id_fkey,
  ADD CONSTRAINT mail_grant_objects_resource_grant_fkey FOREIGN KEY(grant_id) REFERENCES bane_resource_grants(grant_key) ON DELETE CASCADE NOT VALID;
CREATE OR REPLACE FUNCTION mail_management_grant(w text,gid text,policy jsonb,needs_receiving boolean) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS(SELECT FROM bane_resource_grants g
    JOIN bane_oidc_identities i USING(issuer,subject) JOIN workspace_members m ON m.user_id=i.user_id AND m.workspace_id=g.workspace_id
    WHERE g.grant_key=gid AND g.workspace_id=w AND g.issuer=policy->>'issuer' AND g.expires_at>now() AND NOT g.revoked
    AND m.role IN ('owner','admin') AND 'manage'=ANY(g.permissions) AND (NOT needs_receiving OR g.receiving) FOR SHARE OF g,i,m);
$$;
