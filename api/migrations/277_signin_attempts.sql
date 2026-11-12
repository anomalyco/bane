SET LOCAL lock_timeout='2s';
-- Verified sign-ins, refused or admitted, one row per subject, so an operator can bind a person by subject
-- (scripts/list-signin-attempts.ts, scripts/cutover-fresh-start.ts --owner-sub). Email and name are
-- shown to the operator only; they never admit or link anyone. Rows older than 30 days are pruned.
CREATE TABLE bane_signin_attempts (
  issuer text COLLATE "C" NOT NULL,
  subject text COLLATE "C" NOT NULL,
  acr text,
  provider text,
  provider_hd text,
  email text,
  name text,
  outcome text NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX bane_signin_attempts_last ON bane_signin_attempts(last_at);
-- Hosted staff status comes from the sign-in's provider identity (a Google Workspace domain), never from
-- an address. It is decided per sign-in and read by workspace creation.
ALTER TABLE bane_sessions ADD COLUMN staff boolean NOT NULL DEFAULT false;
