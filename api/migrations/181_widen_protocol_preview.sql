SET LOCAL lock_timeout='250ms';
-- The cache is bounded per message, not a protocol limit on header length.
ALTER TABLE mailgw_previews DROP CONSTRAINT mailgw_previews_prefix_check,
  ADD CHECK (octet_length(prefix)<=21848) NOT VALID;
