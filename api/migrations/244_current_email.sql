-- Providers can omit email, or return an unverified address. Only verified
-- ownership is unique. Fail the migration on ambiguous verified legacy rows.
ALTER TABLE bane_users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE bane_users DROP CONSTRAINT bane_users_email_key;
CREATE UNIQUE INDEX bane_users_verified_address ON bane_users(lower(email)) WHERE email_verified;
