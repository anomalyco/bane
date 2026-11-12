SET LOCAL lock_timeout='2s';
-- Hosted production starts fresh at the OIDC cutover (scripts/cutover-fresh-start.ts): there is no bulk
-- carry-over. A claim is inserted by an operator (self-host upgrades) or by the cutover bootstrap, which
-- pre-assigns one person to a kept workspace. A claim adopts its user on the first sign-in only when the ID
-- token came from the pinned issuer, asserts the byte-identical verified address, carries the required
-- authentication context when the claim names one, and the user has no linked subject yet. Each claim is
-- consumed once and audited.
ALTER TABLE bane_legacy_claims
  ADD COLUMN source text NOT NULL DEFAULT 'operator' CHECK (source IN ('operator','bootstrap')),
  ADD COLUMN required_acr text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS bane_legacy_claim_audit(user_id text NOT NULL,issuer text NOT NULL,subject text NOT NULL,source text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,claimed_at));

DROP FUNCTION claim_bane_legacy_user(text,text,text,boolean);
-- Called only after ID-token verification. The DELETE serializes two subjects
-- racing for the same legacy user; a conflicting insert rolls the delete back.
CREATE FUNCTION claim_bane_legacy_user(p_issuer text, p_subject text, p_email text, p_verified boolean, p_acr text)
RETURNS text LANGUAGE sql VOLATILE AS $$
  WITH claimed AS (
    DELETE FROM bane_legacy_claims a USING bane_users u
    WHERE p_verified IS TRUE AND a.issuer = p_issuer AND a.email = p_email
      AND (a.required_acr IS NULL OR a.required_acr = p_acr)
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
