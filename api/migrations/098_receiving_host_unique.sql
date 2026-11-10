-- Receiving hosts. 054 limited them to the claim's root or reply.<root>, and kept them unique only within a workspace.
-- Hosted receiving now picks the first free of reply., inbound., mail. and so on (or the owner's choice), so allow any
-- subdomain of the claim except underscore names (Bane's own _bane, _dmarc and DKIM records), and make each host unique
-- across every workspace. Overlapping claims are refused separately, so no existing row should collide.
SET LOCAL lock_timeout='1s';
DO $$
DECLARE duplicates int; c text;
BEGIN
  SELECT count(*) INTO duplicates FROM (SELECT 1 FROM domain_claims WHERE receiving_host IS NOT NULL GROUP BY receiving_host HAVING count(*) > 1) d;
  IF duplicates > 0 THEN
    RAISE EXCEPTION 'RECEIVING_HOST_DUPLICATES: % receiving hosts are routed by more than one claim. Resolve them before this migration.', duplicates;
  END IF;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'domain_claims'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%receiving_host%' AND pg_get_constraintdef(oid) LIKE '%reply.%' LOOP
    EXECUTE format('ALTER TABLE domain_claims DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE domain_claims ADD CONSTRAINT domain_claims_receiving_host_scope CHECK (receiving_host IS NULL OR receiving_host = name
  OR (right(receiving_host, length(name) + 1) = '.' || name AND receiving_host !~ '(^|[.])_'));
CREATE UNIQUE INDEX domain_claims_receiving_host ON domain_claims(receiving_host) WHERE receiving_host IS NOT NULL;
