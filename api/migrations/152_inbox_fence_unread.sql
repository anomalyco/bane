SET LOCAL lock_timeout='2s';

-- A pre-folder Worker's conversation PATCH {read:false} could leave read unchanged and then
-- recount unread_count with its own rule, which counts held mail. Fence that column too. New
-- deliveries still pass: they change message_count in the same update.
CREATE OR REPLACE TRIGGER inbox_guard_legacy_thread BEFORE UPDATE OF archived,starred,spam,trashed_at,labels,unread_count ON mailbox_threads
 FOR EACH ROW WHEN (NEW.message_count=OLD.message_count AND
  (OLD.archived,OLD.starred,OLD.spam,OLD.trashed_at,OLD.labels,OLD.unread_count) IS DISTINCT FROM
  (NEW.archived,NEW.starred,NEW.spam,NEW.trashed_at,NEW.labels,NEW.unread_count)) EXECUTE FUNCTION inbox_guard_legacy_write();
