-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_quota_sponsor ON workspaces(quota_sponsor) WHERE quota_sponsor IS NOT NULL;
