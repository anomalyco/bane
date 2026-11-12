SET LOCAL lock_timeout='250ms';
-- Private, bounded wire projection. Never synthesize IMAP headers from normalized API fields.
CREATE TABLE mailgw_previews (
  mid text PRIMARY KEY,
  object_key text NOT NULL, prefix text NOT NULL CHECK(length(prefix)<=2732), complete boolean NOT NULL
);
-- If a writer already owns the hot table, abort rather than queue behind it
-- (subsequent writers would otherwise queue behind the pending DDL).
LOCK TABLE mail_messages IN SHARE ROW EXCLUSIVE MODE NOWAIT;
ALTER TABLE mailgw_previews ADD CONSTRAINT mailgw_previews_message_fk
  FOREIGN KEY (mid) REFERENCES mail_messages(id) ON DELETE CASCADE NOT VALID;
