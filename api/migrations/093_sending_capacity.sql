SET LOCAL lock_timeout='2s';
CREATE FUNCTION job_class(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE
  WHEN t IN ('operation.webhook','mailbox.webhook','mailbox.fanout') THEN 'hook' WHEN starts_with(t,'campaign.') THEN 'campaign'
  WHEN t='mailbox.ingest' THEN 'ingest' WHEN t IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery') THEN 'feedback'
  WHEN t IN ('operation.publish','operation.publishBatch') THEN 'publish' ELSE 'other' END $$;
CREATE INDEX jobs_ready_page ON jobs(job_class(type),(CASE WHEN status='running' THEN lease_until ELSE available_at END),id) WHERE status IN ('pending','running');
CREATE INDEX jobs_expired_page ON jobs(lease_until,id) WHERE status='running';
CREATE INDEX sending_interrupted_page ON sending_emails(attempt_started_at,id) WHERE status='attempting';
CREATE INDEX mail_thread_send_guard ON mail_messages(sender_mailbox_id,thread_id,created_at) WHERE direction='outbound';

-- Backfill and install the triggers under the same write fence. Counters never lead a
-- committed admission/refund. Stripe by a stable envelope hash to avoid serializing
-- every dispatch outcome for one workspace on one row. Admissions already serialize.
LOCK TABLE sending_emails IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE sending_stream_depth(workspace_id text NOT NULL,stripe int NOT NULL,marketing boolean NOT NULL,n bigint NOT NULL,PRIMARY KEY(workspace_id,stripe,marketing));
INSERT INTO sending_stream_depth SELECT workspace_id,hashtext(id)&15,coalesce(snapshot->>'kind'='marketing',false),count(*) FROM sending_emails
 WHERE review_id IS NULL AND status IN ('queued','attempting') GROUP BY 1,2,3;
CREATE FUNCTION adjust_stream_depth() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cols text:='workspace_id, hashtext(id)&15 AS stripe, coalesce(snapshot->>''kind''=''marketing'',false) AS marketing';
  pending text:=' WHERE review_id IS NULL AND status IN (''queued'',''attempting'')';
BEGIN
  -- Deterministic lock order across mixed batches. Leasing or claiming without a
  -- depth change cancels out before any write. Only fixed, internal SQL fragments.
  EXECUTE 'INSERT INTO sending_stream_depth SELECT workspace_id,stripe,marketing,sum(delta) FROM ('||concat_ws(' UNION ALL ',
    CASE WHEN TG_OP<>'DELETE' THEN 'SELECT '||cols||',1 AS delta FROM new_mail'||pending END,
    CASE WHEN TG_OP<>'INSERT' THEN 'SELECT '||cols||',-1 AS delta FROM old_mail'||pending END)||
    ') d GROUP BY 1,2,3 HAVING sum(delta)<>0 ORDER BY 1,2,3 ON CONFLICT(workspace_id,stripe,marketing) DO UPDATE SET n=sending_stream_depth.n+excluded.n';
  RETURN NULL;
END $$;
CREATE TRIGGER sending_depth_insert AFTER INSERT ON sending_emails REFERENCING NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION adjust_stream_depth();
CREATE TRIGGER sending_depth_delete AFTER DELETE ON sending_emails REFERENCING OLD TABLE AS old_mail FOR EACH STATEMENT EXECUTE FUNCTION adjust_stream_depth();
CREATE TRIGGER sending_depth_update AFTER UPDATE ON sending_emails REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION adjust_stream_depth();
CREATE OR REPLACE FUNCTION direct_pending_load(wid text,incoming int,marketing int) RETURNS TABLE(total int,projected int) LANGUAGE sql STABLE AS $$
  SELECT n,CASE WHEN EXISTS(SELECT FROM provider_connections WHERE workspace_id=wid AND kind='shared') THEN greatest(
    CASE WHEN incoming>marketing THEN n-m+incoming-marketing END,CASE WHEN marketing>0 THEN m+marketing END) ELSE n+incoming END
  FROM (SELECT coalesce(sum(n),0)::int n,coalesce(sum(n) FILTER(WHERE d.marketing),0)::int m FROM sending_stream_depth d WHERE workspace_id=wid) s
$$;

ALTER TABLE sending_emails ADD COLUMN attachment_failures smallint NOT NULL DEFAULT 0;
CREATE INDEX sending_attachment_repair ON sending_emails(updated_at,id) WHERE status='rejected' AND error_code='ATTACHMENT_STORAGE_UNAVAILABLE';
-- A reservation is deliberately not visible as sending_attachments until PUT succeeds.
CREATE TABLE sending_upload_reservations(id text PRIMARY KEY,workspace_id text NOT NULL,storage_key text NOT NULL,size bigint NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '1 hour');
CREATE INDEX sending_upload_expiry ON sending_upload_reservations(expires_at);
LOCK TABLE sending_attachments IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE sending_asset_usage(workspace_id text PRIMARY KEY,bytes bigint NOT NULL);
INSERT INTO sending_asset_usage SELECT workspace_id,sum(size) FROM sending_attachments GROUP BY 1;
CREATE FUNCTION sending_asset_delta() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN UPDATE sending_asset_usage SET bytes=bytes-OLD.size WHERE workspace_id=OLD.workspace_id; END IF;
  IF TG_OP<>'DELETE' THEN INSERT INTO sending_asset_usage VALUES(NEW.workspace_id,NEW.size) ON CONFLICT(workspace_id) DO UPDATE SET bytes=sending_asset_usage.bytes+excluded.bytes; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER asset_usage AFTER INSERT OR DELETE OR UPDATE OF workspace_id,size ON sending_attachments FOR EACH ROW EXECUTE FUNCTION sending_asset_delta();
CREATE TRIGGER reservation_usage AFTER INSERT OR DELETE ON sending_upload_reservations FOR EACH ROW EXECUTE FUNCTION sending_asset_delta();

-- Only tracked outbound mail creates projection work. Upsert rather than ignore a
-- conflict: a transition racing consumption waits and re-inserts after the delete.
CREATE TABLE mail_outbound_sync(id text PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,due timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX mail_outbound_sync_ready ON mail_outbound_sync(due,id);
INSERT INTO mail_outbound_sync(id) SELECT id FROM mail_messages WHERE direction='outbound' AND sending_email_id IS NOT NULL AND status IN ('queued','attempting','accepted','sent','delayed','acceptance_unknown');
CREATE FUNCTION mark_outbound_sync() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME='mail_messages' THEN INSERT INTO mail_outbound_sync(id) VALUES(NEW.id) ON CONFLICT(id) DO UPDATE SET due=mail_outbound_sync.due;
  ELSE INSERT INTO mail_outbound_sync(id) SELECT id FROM mail_messages WHERE workspace_id=NEW.workspace_id AND sending_email_id=NEW.id AND direction='outbound'
    ON CONFLICT(id) DO UPDATE SET due=mail_outbound_sync.due; END IF; RETURN NULL;
END $$;
CREATE TRIGGER new_outbound_sync AFTER INSERT ON mail_messages FOR EACH ROW WHEN(NEW.direction='outbound' AND NEW.sending_email_id IS NOT NULL) EXECUTE FUNCTION mark_outbound_sync();
CREATE TRIGGER changed_outbound_sync AFTER UPDATE OF status,provider_id ON sending_emails FOR EACH ROW WHEN(NEW.status IS DISTINCT FROM OLD.status OR NEW.provider_id IS DISTINCT FROM OLD.provider_id) EXECUTE FUNCTION mark_outbound_sync();

CREATE OR REPLACE FUNCTION regional_sender(wid text,host text,simulated boolean) RETURNS TABLE(region text,verified boolean,binding jsonb,connection jsonb)
LANGUAGE sql VOLATILE AS $$
  WITH labels AS (SELECT string_to_array(host,'.') AS a), closest AS MATERIALIZED (
    SELECT dc.workspace_id,dc.name,dc.connection_id,dc.sending_state FROM labels,generate_subscripts(a,1) i
    JOIN domain_claims dc ON true WHERE dc.workspace_id=wid AND dc.name=array_to_string(a[i:cardinality(a)],'.') ORDER BY i LIMIT 1 FOR SHARE OF dc),
  bound AS (SELECT b.domain_id,b.region,b.connection_id,r.generation FROM closest dc JOIN domain_sending_bindings b USING(workspace_id,name,connection_id)
    JOIN provider_connection_regions r USING(connection_id,region) FOR SHARE OF b,r)
  SELECT b.region,dc.sending_state IN ('verified','lost'),jsonb_build_object('domain',b.domain_id,'connection',b.connection_id,'generation',b.generation,'account',c.aws_account_id,'topic',c.feedback_topic_arn),
    CASE WHEN c.id IS NOT NULL THEN to_jsonb(c) END FROM closest dc JOIN bound b ON true
    LEFT JOIN regional_simulated_connections c ON c.id=b.connection_id AND c.region=b.region AND
      (simulated OR (c.feedback_topic_arn LIKE 'arn:aws:sns:'||b.region||':'||c.aws_account_id||':%' AND (c.kind='byo' OR c.pool_state='ready')))
$$;

-- Fixed-minute attempt budgets, not billable usage: a definitive denial does not
-- refund abuse headroom. The workspace row serializes its domain checks across shards.
CREATE TABLE hosted_burst_windows(workspace_id text NOT NULL,scope text NOT NULL,minute timestamptz NOT NULL,used int NOT NULL,PRIMARY KEY(workspace_id,scope));
CREATE FUNCTION hosted_burst_ok(wid text,domain_key text,cost int) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE cap int; tenant int; dom int; tick timestamptz:=date_trunc('minute',statement_timestamp());
BEGIN
  IF cost=0 THEN RETURN true; END IF;
  SELECT CASE WHEN created_at>now()-interval '7 days' THEN 50 WHEN created_at>now()-interval '14 days' THEN 100 ELSE 500 END INTO cap
    FROM hosted_admission_policy WHERE workspace_id=wid AND NOT exempt_hosted_quotas;
  IF NOT FOUND THEN RETURN true; END IF;
  INSERT INTO hosted_burst_windows VALUES(wid,'',tick,0) ON CONFLICT DO NOTHING;
  SELECT CASE WHEN minute=tick THEN used ELSE 0 END INTO tenant FROM hosted_burst_windows WHERE workspace_id=wid AND scope='' FOR UPDATE;
  SELECT used INTO dom FROM hosted_burst_windows WHERE workspace_id=wid AND scope=domain_key AND minute=tick;
  IF tenant+cost>cap OR coalesce(dom,0)+cost>greatest(50,cap/2) THEN RETURN false; END IF;
  UPDATE hosted_burst_windows SET used=tenant+cost,minute=tick WHERE workspace_id=wid AND scope='';
  INSERT INTO hosted_burst_windows VALUES(wid,domain_key,tick,coalesce(dom,0)+cost) ON CONFLICT(workspace_id,scope) DO UPDATE SET minute=tick,used=excluded.used;
  RETURN true;
END $$;
