-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_budget_held_due ON mail_receipts(budget_retry_at,workspace_id,ses_message_id) WHERE status='held';
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_verification_expiry ON auth_verification(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_assertion_expiry ON oauth_client_assertion(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_access_expiry ON oauth_access_token(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_refresh_expiry ON oauth_refresh_token(expires_at);
