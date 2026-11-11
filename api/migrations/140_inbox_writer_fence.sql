SET LOCAL lock_timeout='2s';

-- Install BEFORE 141 starts filing deliveries, not after 142 finishes its last page.
-- Neither a fresh store invocation nor a repeat of 142 can reconstruct a missed
-- mutation on an already filed membership. Don't treat an unguarded preview as live-ready.
DO $$ BEGIN
 IF to_regclass('inbox_entries') IS NOT NULL THEN
  RAISE EXCEPTION 'Unfenced preview schema: reconcile offline before enabling folder sync';
 END IF;
END $$;

CREATE FUNCTION inbox_guard_legacy_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('bane.inbox_writer',true) IS DISTINCT FROM 'folders'
    AND EXISTS(SELECT FROM inbox_state WHERE inbox_id=NEW.mailbox_id) THEN
  RAISE EXCEPTION 'Inbox writer has changed; retry on the current API' USING ERRCODE='40001';
 END IF;
 RETURN NEW;
END $$;

-- Fail atomically instead of acquiring inbox_state out of order from a legacy
-- transaction already holding a membership or thread lock. Plain addresses and
-- new deliveries updating the summary as they increment its count are unaffected.
CREATE TRIGGER inbox_guard_legacy_read BEFORE UPDATE OF read ON mailbox_messages
 FOR EACH ROW WHEN (OLD.read IS DISTINCT FROM NEW.read) EXECUTE FUNCTION inbox_guard_legacy_write();
CREATE TRIGGER inbox_guard_legacy_thread BEFORE UPDATE OF archived,starred,spam,trashed_at,labels ON mailbox_threads
 FOR EACH ROW WHEN (NEW.message_count=OLD.message_count AND
  (OLD.archived,OLD.starred,OLD.spam,OLD.trashed_at,OLD.labels) IS DISTINCT FROM
  (NEW.archived,NEW.starred,NEW.spam,NEW.trashed_at,NEW.labels)) EXECUTE FUNCTION inbox_guard_legacy_write();
