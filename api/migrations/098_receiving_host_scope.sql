-- Receiving hosts, part 1 of 3. 054 limited them to the claim's root or reply.<root>, and kept them unique only within
-- a workspace. Hosted receiving now picks the first free of reply., inbound., mail. and so on (or the owner's choice), so
-- any subdomain of the claim may receive except underscore names (Bane's own _bane, _dmarc and DKIM records), and each
-- host is unique across every workspace (part 2 builds that index online; part 3 validates the new CHECK).
-- Safe on a live database: one brief ACCESS EXCLUSIVE lock, retried on lock timeouts, and no table scan under it.
SET LOCAL lock_timeout='2s';

-- Legacy claims may still share a host across workspaces. Instead of stopping the deploy, the claim whose name is the
-- host (else the oldest) keeps it; the others stop routing it and go back to pending with a host_taken issue, which the
-- domain page and GET /v1/domains show until the owner picks another host.
WITH ranked AS (
  SELECT workspace_id,name,receiving_host,
    row_number() OVER (PARTITION BY receiving_host ORDER BY receiving_host=name DESC,created_at,workspace_id,name) AS n
  FROM domain_claims WHERE receiving_host IN (SELECT receiving_host FROM domain_claims WHERE receiving_host IS NOT NULL GROUP BY 1 HAVING count(*)>1)
), released AS (
  UPDATE domain_claims dc SET receiving_host=NULL,receiving_state='pending',receiving_lost_since=NULL,
    identity=CASE WHEN dc.identity IS NOT NULL THEN jsonb_set(dc.identity,'{issue}',jsonb_build_object('code','host_taken','host',r.receiving_host,'blocking',true,'suggestion',NULL,
      'message',r.receiving_host||' already receives mail through another Bane domain. Choose another host for receiving.')) END
  FROM ranked r WHERE r.n>1 AND dc.workspace_id=r.workspace_id AND dc.name=r.name
  RETURNING dc.workspace_id,dc.name
)
UPDATE mailbox_domains m SET status='waiting_for_mx',updated_at=now() FROM released r WHERE m.workspace_id=r.workspace_id AND m.name=r.name;

-- Drop 054's CHECK and add the wider one in a single ALTER (one ACCESS EXCLUSIVE acquisition). NOT VALID skips the
-- scan; part 3 validates under SHARE UPDATE EXCLUSIVE. A short lock_timeout keeps queued reads from piling up behind
-- the lock request; a timeout is retried instead of failing the deploy.
DO $$
DECLARE drops text;
BEGIN
  SELECT string_agg(format('DROP CONSTRAINT %I, ',conname),'') INTO drops FROM pg_constraint
    WHERE conrelid='domain_claims'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%receiving_host%' AND pg_get_constraintdef(oid) LIKE '%reply.%';
  IF EXISTS (SELECT FROM pg_constraint WHERE conrelid='domain_claims'::regclass AND conname='domain_claims_receiving_host_scope') THEN
    IF drops IS NULL THEN RETURN; END IF;
    drops:=drops||'DROP CONSTRAINT domain_claims_receiving_host_scope, ';
  END IF;
  FOR attempt IN 1..10 LOOP
    BEGIN
      EXECUTE 'ALTER TABLE domain_claims '||coalesce(drops,'')||$q$ADD CONSTRAINT domain_claims_receiving_host_scope CHECK (receiving_host IS NULL OR receiving_host = name
        OR (right(receiving_host, length(name) + 1) = '.' || name AND receiving_host !~ '(^|[.])_')) NOT VALID$q$;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      IF attempt=10 THEN RAISE; END IF;
      PERFORM pg_sleep(attempt*0.5);
    END;
  END LOOP;
END $$;
