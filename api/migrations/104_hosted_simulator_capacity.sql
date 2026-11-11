-- Keep the original accounting rule for old envelopes: a later suppression
-- must refund only what admission actually charged. Both changes are metadata
-- only; no scan/rewrite of retained customer mail at deploy time.
SET LOCAL lock_timeout='2s';
ALTER TABLE sending_emails ADD COLUMN charge_simulator boolean NOT NULL DEFAULT false;
ALTER TABLE sending_emails ALTER COLUMN charge_simulator SET DEFAULT true;

CREATE OR REPLACE FUNCTION hosted_charge_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO hosted_usage_hourly AS u
    SELECT n.workspace_id,date_trunc('hour',n.created_at,'UTC'),sum(jsonb_array_length(n.to_addresses||n.cc_addresses||n.bcc_addresses))
    FROM new_mail n LEFT JOIN provider_connections pc USING (workspace_id) WHERE NOT n.simulated AND hosted_charged(n.status,n.provider_id)
    AND ((n.feedback_topic_arn IS NULL AND pc.kind='shared') OR n.feedback_topic_arn IN (SELECT feedback_topic_arn FROM provider_pool_regions))
    GROUP BY 1,2 ORDER BY 1,2 ON CONFLICT (workspace_id,hour) DO UPDATE SET recipients=u.recipients+excluded.recipients;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hosted_adjust_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT CASE WHEN NEW.charge_simulator THEN jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses) ELSE e.cost END INTO n
    FROM hosted_real_envelopes e WHERE e.workspace_id=NEW.workspace_id AND e.id=NEW.id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO hosted_usage_hourly AS u SELECT NEW.workspace_id,h,sum(delta) FROM (VALUES
    (date_trunc('hour',OLD.created_at,'UTC'),-n*hosted_charged(OLD.status,OLD.provider_id)::int),
    (date_trunc('hour',NEW.created_at,'UTC'), n*hosted_charged(NEW.status,NEW.provider_id)::int)) d(h,delta)
    WHERE h >= date_trunc('hour',now(),'UTC')-interval '23 hours' GROUP BY h HAVING sum(delta)<>0 ORDER BY h
    ON CONFLICT (workspace_id,hour) DO UPDATE SET recipients=u.recipients+excluded.recipients;
  RETURN NULL;
END $$;
