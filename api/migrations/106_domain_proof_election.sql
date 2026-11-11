SET LOCAL lock_timeout='2s';
-- Keep a superseded claim as a tombstone for the existing tag-checked SES
-- cleanup worker. It has no authority and cannot win a later observation.
ALTER TABLE domain_claims ADD COLUMN superseded boolean NOT NULL DEFAULT false,
  ADD COLUMN dns_first boolean NOT NULL DEFAULT false;
UPDATE domain_claims SET ever_proven=true WHERE NOT ever_proven AND
  (sending_state IN ('verified','lost') OR receiving_state IN ('active','lost') OR identity ? 'adopted');
DROP INDEX domain_claims_exclusive_name;
CREATE UNIQUE INDEX domain_claims_proven_name ON domain_claims(name) WHERE ever_proven AND claim_scope<>'account';
CREATE FUNCTION domain_names_overlap(a text,b text) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT right('.'||a,length(b)+1)='.'||b OR right('.'||b,length(a)+1)='.'||a
$$;
CREATE OR REPLACE FUNCTION exclusive_domain_overlap(wid text,host text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT FROM domain_claims dc WHERE dc.workspace_id<>wid AND dc.claim_scope<>'account'
    AND dc.ever_proven AND domain_names_overlap(dc.name,host))
$$;
CREATE OR REPLACE FUNCTION domain_claim_expired(dc domain_claims) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT dc.superseded OR (NOT dc.ever_proven AND dc.created_at <= now()-interval '72 hours')
$$;
CREATE FUNCTION elect_domain_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.claim_scope='account' THEN RETURN NEW; END IF;
  IF NEW.sending_state IN ('verified','lost') OR NEW.receiving_state IN ('active','lost') OR jsonb_typeof(NEW.identity->'adopted')='object' THEN NEW.ever_proven:=true; END IF;
  IF NEW.superseded AND NEW.ever_proven THEN RAISE EXCEPTION 'Domain claim was superseded' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND (NOT NEW.ever_proven OR (OLD.ever_proven AND OLD.claim_scope<>'account')) THEN RETURN NEW; END IF;
  IF NOT NEW.ever_proven THEN
    -- reserve_* already holds the namespace lock and checks proven overlap.
    NEW.dns_first:=EXISTS(SELECT FROM domain_claims WHERE name=NEW.name AND workspace_id<>NEW.workspace_id AND claim_scope<>'account');
    RETURN NEW;
  END IF;
  -- Same lock and namespace as both reserve functions and imported TXT upgrades.
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(NEW.name FROM '[^.]+\.[^.]+$'),84912));
  IF exclusive_domain_overlap(NEW.workspace_id,NEW.name) THEN RAISE EXCEPTION 'Domain ownership conflict' USING ERRCODE='23514'; END IF;
  IF NEW.ever_proven THEN
    UPDATE domain_claims SET superseded=true WHERE workspace_id<>NEW.workspace_id AND claim_scope<>'account'
      AND NOT ever_proven AND NOT superseded AND domain_names_overlap(name,NEW.name);
  END IF;
  RETURN NEW;
END $$;
-- Runs after remember_domain_proof. A stale verifier, import upgrade or old
-- writer cannot bypass the same election that protects new reservations.
CREATE TRIGGER z_elect_domain_proof BEFORE INSERT OR UPDATE ON domain_claims FOR EACH ROW EXECUTE FUNCTION elect_domain_proof();
