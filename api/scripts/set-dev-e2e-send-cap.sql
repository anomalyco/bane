-- Manual dev fixture setup, not a migration. Supply its workspace_id via psql -v.
WITH changed AS (
  UPDATE workspaces w SET send_cap_override = 500
  WHERE w.id = :'workspace_id' AND w.send_cap_override IS NULL AND NOT w.exempt_hosted_quotas
    AND EXISTS (SELECT FROM provider_connections c WHERE c.workspace_id = w.id AND c.kind = 'shared')
    AND 2 = (SELECT count(*) FROM domain_claims d WHERE d.workspace_id = w.id
             AND d.name IN ('e2e.bane.mx', 'e2e-va.bane.mx') AND d.sending_state = 'verified')
  RETURNING w.id
)
INSERT INTO hosted_operator_audit (workspace_id, action, details)
SELECT id, 'set-dev-e2e-send-cap', '{"old":null,"new":500,"reason":"Scheduled and deploy E2E campaign capacity"}'::jsonb
FROM changed RETURNING workspace_id, details;
