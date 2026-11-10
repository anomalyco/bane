-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS auth_verification_expiry ON auth_verification(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_assertion_expiry ON oauth_client_assertion(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_access_expiry ON oauth_access_token(expires_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_refresh_expiry ON oauth_refresh_token(expires_at);
