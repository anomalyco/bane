SET LOCAL lock_timeout='2s';
-- Platform operators are Bane users (bane_users, migration 270), named by issuer subject when granted
-- (scripts/set-operator.ts). The rows' user IDs are the same: 270 copied auth_user into bane_users.
ALTER TABLE platform_operators DROP CONSTRAINT platform_operators_user_id_fkey,
  ADD CONSTRAINT platform_operators_user_id_fkey FOREIGN KEY (user_id) REFERENCES bane_users(id) ON DELETE CASCADE;
