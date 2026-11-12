SET LOCAL lock_timeout='2s';
-- IMAP/SMTP access is free (a fair-use download throttle, 246, instead of a fee): migration 172's charge path goes.
-- The trigger names (protocol_meter, protocol_end) stay; the function keeps only 177's auth notification, so open
-- sessions still close when a password is revoked or the inbox is deleted.
CREATE OR REPLACE FUNCTION inbox_protocol_meter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.protocol_passwords<OLD.protocol_passwords THEN PERFORM pg_notify('bane_protocol_auth',OLD.inbox_id); END IF;
 RETURN NULL;
END $$;
DROP FUNCTION inbox_protocol_daily_usage(date);
DROP TABLE inbox_protocol_periods;
