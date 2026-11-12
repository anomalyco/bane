SET LOCAL lock_timeout='250ms';
-- Keep both writes in the ingest statement. Delivery can be dropped, deduped,
-- or stored without an object; only project the exact object that survived.
CREATE FUNCTION mail_store_incoming(msg jsonb, file_items jsonb, refs_json jsonb, envelopes jsonb,
  authenticated_from boolean, can_create boolean, plan jsonb, policy jsonb, prefix text, complete boolean)
RETURNS TABLE(queued_count integer,wait_ms double precision,hold_ms double precision) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY SELECT * FROM mail_store_incoming(msg,file_items,refs_json,envelopes,authenticated_from,can_create,plan,policy);
  IF prefix IS NOT NULL THEN
    INSERT INTO mailgw_previews SELECT id,raw_key,prefix,complete FROM mail_messages
      WHERE id=msg->>'id' AND raw_key=msg->>'raw_key' AND lifecycle='kept' ON CONFLICT(mid) DO NOTHING;
  END IF;
END $$;
