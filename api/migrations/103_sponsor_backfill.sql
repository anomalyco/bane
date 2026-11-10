-- Separate transaction: the fast ADD COLUMN's ACCESS EXCLUSIVE lock is gone.
SET LOCAL lock_timeout='2s';
UPDATE workspaces w SET quota_sponsor=m.user_id FROM (
  SELECT DISTINCT ON (workspace_id) workspace_id,user_id FROM workspace_members
  WHERE role='owner' ORDER BY workspace_id,created_at,id
) m WHERE w.id=m.workspace_id AND w.quota_sponsor IS NULL;
