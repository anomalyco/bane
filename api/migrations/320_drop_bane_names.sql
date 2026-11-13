-- Bane → Nightmail cutover (renumber to the next free number when this merges): the pre-rename names stop working.
-- The bane_* views that kept an earlier release running during the 308 deploy go, and every domain claim now shows,
-- and is proven only by, its _nightmail ownership record (our own domains republished theirs before the cutover).
DROP VIEW IF EXISTS bane_users, bane_sessions, bane_oidc_identities, bane_signin_attempts, bane_login_flows,
  bane_resource_grants, bane_dpop_proofs, bane_expired_approvals, bane_retired_grant_objects, bane_migrations;
UPDATE domain_claims SET proof_label = 'nightmail' WHERE proof_label <> 'nightmail';
ALTER TABLE domain_claims DROP CONSTRAINT domain_claims_proof_label_check,
  ADD CONSTRAINT domain_claims_proof_label_check CHECK (proof_label = 'nightmail');
