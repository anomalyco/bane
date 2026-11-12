-- bane:batched
-- New inboxes already seed Drafts. Keyset pages commit independently and replay safely.
WITH page AS MATERIALIZED (SELECT inbox_id FROM inbox_state WHERE inbox_id>coalesce($1,'') ORDER BY inbox_id LIMIT 250 FOR UPDATE),
 added AS (INSERT INTO inbox_folders(inbox_id,role) SELECT inbox_id,'drafts' FROM page ON CONFLICT DO NOTHING)
SELECT max(inbox_id) AS cursor FROM page;
