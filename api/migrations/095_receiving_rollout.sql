SET LOCAL lock_timeout='2s';
-- Carry forward only existing, bound receiving authority; no pending, unowned, send-only
-- or account-scoped claim gets new rights. The rollout grace is finite even if DNS is down.
WITH credited AS (UPDATE domain_claims dc SET receiving_proved_at=now(),receiving_identity_at=now()
  WHERE dc.receiving_host IS NOT NULL AND dc.receiving_state IN ('active','lost') AND dc.claim_scope<>'account'
    AND dc.connection_id IS NOT NULL AND (dc.identity->>'proven'='true' OR dc.ever_proven)
    AND (dc.identity#>>'{ses,VerificationStatus}'='SUCCESS' OR EXISTS(SELECT FROM domain_sending_bindings b JOIN mailbox_domains m ON m.workspace_id=b.workspace_id AND m.domain_id=b.domain_id WHERE b.workspace_id=dc.workspace_id AND b.connection_id=dc.connection_id AND b.name=dc.name AND b.region<>'us-east-2' AND m.region='us-east-2' AND m.status='active' AND m.receiving_host=dc.receiving_host))
    AND dc.identity->>'adopted' IS NULL
  RETURNING workspace_id,connection_id,token,name)
INSERT INTO jobs(id,type,workspace_id,payload,available_at) SELECT 'domain.verify:'||c.token,'domain.verify',c.workspace_id,
  jsonb_build_object('domainId',b.domain_id,'token',c.token), now()+row_number() OVER(ORDER BY c.workspace_id,c.name,c.token)*interval '2 seconds'
  FROM credited c JOIN domain_sending_bindings b USING(workspace_id,connection_id,name)
ON CONFLICT(id) DO UPDATE SET status='pending',available_at=excluded.available_at,attempts=0,lease_until=NULL,last_error=NULL,payload=excluded.payload WHERE jobs.status<>'running';
