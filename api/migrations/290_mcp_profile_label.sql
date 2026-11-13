SET LOCAL lock_timeout='2s';
-- The label an MCP client entry carries in its URL (`/mcp?profile=work`), so two entries of one client (a personal
-- and a work account) are easy to tell apart in Settings. Display only: it never selects or authorizes anything.
ALTER TABLE bane_resource_grants ADD COLUMN profile text CHECK (char_length(profile) BETWEEN 1 AND 40);
