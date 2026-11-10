SET LOCAL lock_timeout='1s';
ALTER TABLE provider_connections DROP CONSTRAINT provider_connections_requested_account_check,
  ADD CONSTRAINT provider_connections_requested_account_check CHECK (requested_account ~ '^[0-9]{12}$');
