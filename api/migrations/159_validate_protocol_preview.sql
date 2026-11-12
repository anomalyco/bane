-- Separate transaction: validation does not retain the FK installation lock.
SET LOCAL lock_timeout='250ms';
ALTER TABLE mailgw_previews VALIDATE CONSTRAINT mailgw_previews_message_fk;
