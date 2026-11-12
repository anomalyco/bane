SET LOCAL lock_timeout='2s';
-- Usage meters. Statement triggers on the inserts that already run (admission, campaign release, mailbox and SMTP
-- sends, the ingest store), so metering adds no round trip: one upsert per (workspace, hour, meter) per statement.
-- Lock order for writers: admission lock or mail_receive_windows → mail rows → billing_usage_hourly → mail_storage_days.

-- Sends: every recipient (simulator addresses included) of a charged row. Hosted (shared pool) rows meter 'send';
-- BYO rows meter 'byo_send' ($0, reported). Installation-simulated rows count only with bill_simulated.
CREATE FUNCTION billing_meter_sends() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
  SELECT n.workspace_id, date_trunc('hour',now(),'UTC'),
         CASE WHEN (n.feedback_topic_arn IS NULL AND pc.kind='shared')
                OR EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=n.feedback_topic_arn)
              THEN 'send' ELSE 'byo_send' END,
         1, sum(jsonb_array_length(n.to_addresses||n.cc_addresses||n.bcc_addresses))
  FROM new_mail n
  CROSS JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id=n.workspace_id ORDER BY kind LIMIT 1) pc
  CROSS JOIN (SELECT bill_simulated FROM billing_config WHERE singleton) cfg
  WHERE (NOT n.simulated OR cfg.bill_simulated) AND hosted_charged(n.status,n.provider_id,n.error_code)
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  RETURN NULL;
END $$;
CREATE TRIGGER billing_meter_sends AFTER INSERT ON sending_emails REFERENCING NEW TABLE AS new_mail
  FOR EACH STATEMENT EXECUTE FUNCTION billing_meter_sends();

-- A charged ↔ uncharged transition (a pre-SES rejection refunded, or a later charge) at any age lands in the
-- current hour, so a settled hour is never reopened and the settler prices it with the next run.
CREATE FUNCTION billing_adjust_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; m text;
BEGIN
  IF NEW.simulated AND NOT (SELECT bill_simulated FROM billing_config WHERE singleton) THEN RETURN NULL; END IF;
  d := (hosted_charged(NEW.status,NEW.provider_id,NEW.error_code)::int - hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)::int)
       * jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses);
  SELECT CASE WHEN (NEW.feedback_topic_arn IS NULL AND kind='shared') OR EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=NEW.feedback_topic_arn)
         THEN 'send' ELSE 'byo_send' END INTO m FROM provider_connections WHERE workspace_id=NEW.workspace_id ORDER BY kind LIMIT 1;
  IF d=0 OR m IS NULL THEN RETURN NULL; END IF;
  INSERT INTO billing_usage_hourly AS u VALUES (NEW.workspace_id,date_trunc('hour',now(),'UTC'),m,1,d,0)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  RETURN NULL;
END $$;
CREATE TRIGGER billing_adjust_sends AFTER UPDATE OF status,provider_id,error_code ON sending_emails FOR EACH ROW
  WHEN (hosted_charged(OLD.status,OLD.provider_id,OLD.error_code) <> hosted_charged(NEW.status,NEW.provider_id,NEW.error_code))
  EXECUTE FUNCTION billing_adjust_sends();

-- Received bytes per (workspace, UTC day), and the rolling sum of bytes on days older than 90 days (advanced daily by
-- billing_storage_day, decremented on delete). Storage is billed on aged_bytes beyond the free 1 GB.
CREATE TABLE mail_storage_days (workspace_id text NOT NULL, day date NOT NULL, bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day));
CREATE INDEX mail_storage_days_day ON mail_storage_days (day);
CREATE TABLE mail_storage_aged (workspace_id text PRIMARY KEY, aged_bytes bigint NOT NULL DEFAULT 0, aged_through date NOT NULL);
CREATE INDEX mail_storage_aged_billable ON mail_storage_aged (workspace_id) WHERE aged_bytes > 1000000000;

-- Receives (one per message with an SES message ID: spam included; IMAP APPEND, sandbox, simulated and outbound
-- copies excluded), Omen evaluations (verdicts.omenCalls) and stored bytes, in the ingest store statement.
CREATE FUNCTION billing_meter_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
  SELECT n.workspace_id, date_trunc('hour',now(),'UTC'), m.meter, 1, sum(m.q)
  FROM new_rows n
  LEFT JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id=n.workspace_id ORDER BY kind LIMIT 1) pc ON true
  CROSS JOIN LATERAL (VALUES (CASE WHEN pc.kind='byo' THEN 'byo_receive' ELSE 'receive' END, 1::bigint),
                             ('omen', coalesce((n.verdicts->>'omenCalls')::bigint,0))) m(meter,q)
  WHERE n.direction='inbound' AND n.ses_message_id IS NOT NULL AND m.q>0
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  INSERT INTO mail_storage_days AS d (workspace_id,day,bytes)
  SELECT workspace_id,(received_at AT TIME ZONE 'UTC')::date,sum(coalesce(size_bytes,0)) FROM new_rows
  WHERE direction='inbound' GROUP BY 1,2 ORDER BY 1,2
  ON CONFLICT (workspace_id,day) DO UPDATE SET bytes=d.bytes+excluded.bytes;
  RETURN NULL;
END $$;
CREATE TRIGGER billing_meter_mail AFTER INSERT ON mail_messages REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION billing_meter_mail();

-- Deleting received mail stops its storage: the day's bytes go down, and so does the aged sum when the day has aged.
CREATE FUNCTION billing_unmeter_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mail_storage_days d SET bytes=greatest(0,d.bytes-g.bytes)
  FROM (SELECT workspace_id,(received_at AT TIME ZONE 'UTC')::date AS day,sum(coalesce(size_bytes,0)) AS bytes
        FROM old_rows WHERE direction='inbound' GROUP BY 1,2 ORDER BY 1,2) g
  WHERE d.workspace_id=g.workspace_id AND d.day=g.day;
  UPDATE mail_storage_aged a SET aged_bytes=greatest(0,a.aged_bytes-s.bytes)
  FROM (SELECT o.workspace_id,sum(coalesce(o.size_bytes,0)) AS bytes FROM old_rows o
        JOIN mail_storage_aged x ON x.workspace_id=o.workspace_id AND (o.received_at AT TIME ZONE 'UTC')::date<=x.aged_through
        WHERE o.direction='inbound' GROUP BY 1 ORDER BY 1) s
  WHERE a.workspace_id=s.workspace_id;
  RETURN NULL;
END $$;
CREATE TRIGGER billing_unmeter_mail AFTER DELETE ON mail_messages REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION billing_unmeter_mail();

-- Backfill (production is small; above 1M inbound rows this belongs in a batched script instead).
INSERT INTO mail_storage_days (workspace_id,day,bytes)
SELECT workspace_id, (received_at AT TIME ZONE 'UTC')::date, sum(coalesce(size_bytes,0))
FROM mail_messages WHERE direction='inbound'
GROUP BY 1,2;
