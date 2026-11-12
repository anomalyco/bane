SET LOCAL lock_timeout='2s';
-- Existing users carry over on their first OIDC sign-in, without an operator step.
-- A pre-approved claim adopts the legacy user (same ID, so the same workspaces,
-- roles, keys and data) only when ALL of these hold at sign-in:
--   * the legacy user signed in with Google only, and its address is verified;
--   * the ID token came from this installation's issuer with acr exactly
--     urn:anomaly:acr:google, and asserts that address verified, byte for byte;
--   * the legacy user has no linked subject yet (each claim is consumed once;
--     a second subject with the same address is refused afterwards).
-- Verified addresses are unique (244), so a claim can match one user at most.
-- Operator claims keep their pinned issuer and work without Google.
ALTER TABLE bane_legacy_claims ALTER COLUMN issuer DROP NOT NULL,
  ADD COLUMN source text NOT NULL DEFAULT 'operator' CHECK (source IN ('operator','google')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CHECK ((source = 'google') = (issuer IS NULL));
CREATE TABLE IF NOT EXISTS bane_legacy_claim_audit(user_id text NOT NULL,issuer text NOT NULL,subject text NOT NULL,source text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,claimed_at));

INSERT INTO bane_legacy_claims(user_id,issuer,email,source)
SELECT u.id,NULL,u.email,'google' FROM bane_users u
WHERE u.email_verified AND u.email IS NOT NULL
  AND NOT EXISTS(SELECT FROM bane_oidc_identities i WHERE i.user_id=u.id)
  AND EXISTS(SELECT FROM auth_account a WHERE a.user_id=u.id AND a.provider_id='google')
  AND NOT EXISTS(SELECT FROM auth_account a WHERE a.user_id=u.id AND a.provider_id<>'google')
ON CONFLICT DO NOTHING;

DROP FUNCTION claim_bane_legacy_user(text,text,text,boolean);
-- Called only after ID-token verification. The DELETE serializes two subjects
-- racing for the same legacy user; a conflicting insert rolls the delete back.
CREATE FUNCTION claim_bane_legacy_user(p_issuer text, p_subject text, p_email text, p_verified boolean, p_acr text)
RETURNS text LANGUAGE sql VOLATILE AS $$
  WITH claimed AS (
    DELETE FROM bane_legacy_claims a USING bane_users u
    WHERE p_verified IS TRUE AND a.email = p_email
      AND (a.issuer = p_issuer OR (a.issuer IS NULL AND a.source = 'google' AND p_acr = 'urn:anomaly:acr:google'))
      AND u.id = a.user_id AND u.email_verified AND u.email COLLATE "C" = a.email
      AND NOT EXISTS (SELECT FROM bane_oidc_identities i WHERE i.user_id = a.user_id)
    RETURNING a.user_id, a.source
  ), linked AS (
    INSERT INTO bane_oidc_identities (issuer, subject, user_id)
    SELECT p_issuer, p_subject, user_id FROM claimed RETURNING user_id
  ), audited AS (
    INSERT INTO bane_legacy_claim_audit(user_id,issuer,subject,source)
    SELECT l.user_id, p_issuer, p_subject, c.source FROM linked l JOIN claimed c USING (user_id) RETURNING user_id
  ) SELECT user_id FROM audited;
$$;
