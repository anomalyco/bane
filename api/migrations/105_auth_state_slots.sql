-- Bound sign-in state creation across Node processes and Worker isolates. Each
-- slot outlives Better Auth's ten-minute state. A failed sign-in does not refund it.
CREATE TABLE auth_state_slots(peer text NOT NULL, slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 8),
  expires_at timestamptz NOT NULL, PRIMARY KEY(peer,slot));
CREATE INDEX auth_state_slots_expiry ON auth_state_slots(expires_at);
CREATE FUNCTION reserve_auth_state(peer_hash text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(peer_hash,92481));
  INSERT INTO auth_state_slots(peer,slot,expires_at)
    SELECT peer_hash,n,clock_timestamp()+interval '11 minutes' FROM generate_series(1,8) n
    WHERE NOT EXISTS (SELECT FROM auth_state_slots s WHERE s.peer=peer_hash AND s.slot=n AND s.expires_at>clock_timestamp())
    LIMIT 1 ON CONFLICT(peer,slot) DO UPDATE SET expires_at=excluded.expires_at;
  RETURN FOUND;
END $$;
