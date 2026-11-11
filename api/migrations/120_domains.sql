SET LOCAL lock_timeout='2s';
ALTER TABLE mailbox_domains ALTER catch_all SET DEFAULT 'store';
