SET LOCAL lock_timeout='2s';
-- New rows only; no runtime table scans or rewrites. Password keys are NOT inbound API keys.
CREATE TABLE inbox_app_passwords(id text PRIMARY KEY,inbox_id text NOT NULL REFERENCES inbox_state ON DELETE CASCADE,
 name text NOT NULL,hash text NOT NULL UNIQUE,protocols text[] NOT NULL CHECK(protocols<@ARRAY['imap','smtp'] AND cardinality(protocols)>0),
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE INDEX inbox_app_passwords_active ON inbox_app_passwords(inbox_id) WHERE revoked_at IS NULL;
ALTER TABLE inbox_state ADD COLUMN protocol_daily int NOT NULL DEFAULT 200, ADD COLUMN protocol_monthly int NOT NULL DEFAULT 2000;
-- Preserve chargeable intervals even after an inbox is deleted. No credential material here.
CREATE TABLE inbox_protocol_periods(workspace_id text NOT NULL,inbox_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
CREATE UNIQUE INDEX inbox_protocol_open ON inbox_protocol_periods(inbox_id) WHERE ended_at IS NULL;
CREATE FUNCTION inbox_protocol_meter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN UPDATE inbox_protocol_periods SET ended_at=clock_timestamp() WHERE inbox_id=OLD.inbox_id AND ended_at IS NULL;
 ELSIF OLD.protocol_passwords=0 AND NEW.protocol_passwords>0 THEN INSERT INTO inbox_protocol_periods VALUES(NEW.workspace_id,NEW.inbox_id,clock_timestamp(),NULL);
 ELSIF OLD.protocol_passwords>0 AND NEW.protocol_passwords=0 THEN UPDATE inbox_protocol_periods SET ended_at=clock_timestamp() WHERE inbox_id=NEW.inbox_id AND ended_at IS NULL;
 END IF;
 PERFORM pg_notify('bane_protocol_auth',OLD.inbox_id); RETURN NULL;
END $$;
CREATE TRIGGER protocol_meter AFTER UPDATE OF protocol_passwords ON inbox_state FOR EACH ROW WHEN (OLD.protocol_passwords<>NEW.protocol_passwords) EXECUTE FUNCTION inbox_protocol_meter();
CREATE TRIGGER protocol_end AFTER DELETE ON inbox_state FOR EACH ROW WHEN (OLD.protocol_passwords>0) EXECUTE FUNCTION inbox_protocol_meter();
-- One dollar per distinct inbox that had any enabled interval during this UTC day.
CREATE FUNCTION inbox_protocol_daily_usage(d date) RETURNS TABLE(workspace_id text,inbox_id text,cents int) LANGUAGE sql STABLE AS $$
 SELECT DISTINCT workspace_id,inbox_id,100 FROM inbox_protocol_periods WHERE started_at < ((d+1)::timestamp AT TIME ZONE 'UTC') AND (ended_at IS NULL OR ended_at>(d::timestamp AT TIME ZONE 'UTC'))
$$;
