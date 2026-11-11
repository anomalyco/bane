SET LOCAL lock_timeout='2s';
-- Owned by the future app-password issuer/revoker, not a customer-toggleable
-- billing flag. Temporary and permanent inboxes are equally eligible. Existing
-- inboxes have no IMAP/SMTP app passwords and incur no protocol charge.
ALTER TABLE inbox_state ADD COLUMN protocol_passwords integer NOT NULL DEFAULT 0,
 ADD CONSTRAINT inbox_protocol_password_count CHECK(protocol_passwords>=0) NOT VALID;
CREATE FUNCTION inbox_wake_protocol() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- Identical hints coalesce in PostgreSQL and are only delivered on commit.
 -- A disconnected listener catches up via the durable MODSEQ / vanished rows.
 PERFORM pg_notify('bane_inbox_changed',NEW.inbox_id); RETURN NULL;
END $$;
CREATE TRIGGER inbox_wake_protocol AFTER UPDATE OF modseq ON inbox_state FOR EACH ROW
 WHEN (NEW.protocol_passwords>0 AND NEW.modseq<>OLD.modseq) EXECUTE FUNCTION inbox_wake_protocol();
