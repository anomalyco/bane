SET LOCAL lock_timeout='2s';
-- IMAP download fair use (a throttle, not a fee): bytes of full message bodies handed to an inbox's IMAP clients per
-- UTC day. Defaults 5 GB a day and 30 GB a month per inbox; an operator can override either on inbox_state.
CREATE TABLE inbox_protocol_egress (
  inbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE, day date NOT NULL, bytes bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (inbox_id, day));
ALTER TABLE inbox_state ADD COLUMN egress_daily_bytes bigint CHECK (egress_daily_bytes >= 0),
  ADD COLUMN egress_monthly_bytes bigint CHECK (egress_monthly_bytes >= 0);

-- Authorizes one body download for the protocol password `kid`: true and counted when it fits both caps, false
-- (nothing counted) otherwise. Today's row serializes concurrent downloads of one inbox (upsert with cap, the shape
-- of mail_receive_slot). The first download of a day also drops that inbox's rows older than two months.
CREATE FUNCTION inbox_protocol_download(kid text, size bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE inbox text; d date := (now() AT TIME ZONE 'UTC')::date; dcap bigint; mcap bigint; earlier bigint; ok boolean;
BEGIN
  SELECT p.inbox_id, coalesce(s.egress_daily_bytes, 5000000000), coalesce(s.egress_monthly_bytes, 30000000000) INTO inbox, dcap, mcap
    FROM inbox_app_passwords p LEFT JOIN inbox_state s ON s.inbox_id=p.inbox_id WHERE p.id=kid;
  IF inbox IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT FROM inbox_protocol_egress WHERE inbox_id=inbox AND day=d) THEN
    DELETE FROM inbox_protocol_egress WHERE inbox_id=inbox AND day < d - 62;
  END IF;
  SELECT coalesce(sum(bytes),0) INTO earlier FROM inbox_protocol_egress
    WHERE inbox_id=inbox AND day >= date_trunc('month', d)::date AND day < d;
  INSERT INTO inbox_protocol_egress AS e (inbox_id, day, bytes)
    SELECT inbox, d, size WHERE size <= dcap AND earlier + size <= mcap
    ON CONFLICT (inbox_id, day) DO UPDATE SET bytes=e.bytes+excluded.bytes
    WHERE e.bytes+excluded.bytes <= dcap AND earlier+e.bytes+excluded.bytes <= mcap
    RETURNING true INTO ok;
  RETURN coalesce(ok, false);
END $$;
