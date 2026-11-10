-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_domains_receiving_lookup ON mailbox_domains(receiving_host,region);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_domains_name_lookup ON mailbox_domains(name,region);
CREATE INDEX CONCURRENTLY IF NOT EXISTS domain_claims_receiving_lookup ON domain_claims(receiving_host) WHERE claim_scope<>'account';
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_ingest_workspace_head ON jobs(workspace_id,(CASE WHEN status='running' THEN lease_until ELSE available_at END),id) WHERE type='mailbox.ingest' AND status IN ('pending','running');
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_ingest_turn_order ON mail_ingest_turns(served_at,workspace_id) WHERE active>0;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_webhooks_active ON mailbox_webhooks(workspace_id,id) WHERE NOT paused;
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_events_prune ON mailbox_events(created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_delivery_prune ON mailbox_webhook_deliveries(created_at) WHERE status IN ('failed','delivered','paused');
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_delivery_resume ON mailbox_webhook_deliveries(workspace_id,webhook_id,id) WHERE status='paused';
