-- Private, bounded wire projection. Never synthesize IMAP headers from normalized API fields.
CREATE TABLE mailgw_previews (
  mid text PRIMARY KEY REFERENCES mail_messages(id) ON DELETE CASCADE,
  object_key text NOT NULL, prefix text NOT NULL CHECK(length(prefix)<=2732), complete boolean NOT NULL
);
