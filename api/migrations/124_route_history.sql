-- The manifest holds identities only. Audit bodies stay delta-encoded. Page a historical config
-- with one indexed forward probe per ID: its first subsequent before-image, or the unchanged live row.
CREATE TABLE mail_routing_versions(workspace_id text NOT NULL,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 route_ids text[] NOT NULL,changed_ids text[] NOT NULL,actor_type text NOT NULL,actor_id text NOT NULL,note text,PRIMARY KEY(workspace_id,version));
CREATE INDEX mail_routing_version_age ON mail_routing_versions(created_at);
CREATE INDEX mail_routing_resource_version ON mail_routing_audit(workspace_id,resource_id,version);
ALTER TABLE mail_routing_audit ADD FOREIGN KEY(workspace_id,version) REFERENCES mail_routing_versions ON DELETE CASCADE;
CREATE FUNCTION mail_prune_route_versions() RETURNS integer LANGUAGE sql VOLATILE AS $$
 WITH expired AS (SELECT workspace_id,version FROM mail_routing_versions WHERE created_at<now()-interval '1 year' ORDER BY created_at LIMIT 8 FOR UPDATE SKIP LOCKED),
 gone AS (DELETE FROM mail_routing_versions v USING expired e WHERE (v.workspace_id,v.version)=(e.workspace_id,e.version) RETURNING 1) SELECT count(*)::int FROM gone
$$;
