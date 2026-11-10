SET LOCAL lock_timeout='2s';
-- The triggers and indexed baseline commit atomically. No index build or domain backfill
-- under this short writer fence. Keep jobs_ingest_due throughout the old Worker rollout.
CREATE TRIGGER mail_ingest_head_insert AFTER INSERT ON jobs FOR EACH ROW WHEN (NEW.type='mailbox.ingest') EXECUTE FUNCTION mail_ingest_head_change();
CREATE TRIGGER mail_ingest_head_update AFTER UPDATE OF status,workspace_id,type ON jobs FOR EACH ROW WHEN (NEW.type='mailbox.ingest' OR OLD.type='mailbox.ingest') EXECUTE FUNCTION mail_ingest_head_change();
CREATE TRIGGER mail_ingest_head_delete AFTER DELETE ON jobs FOR EACH ROW WHEN (OLD.type='mailbox.ingest') EXECUTE FUNCTION mail_ingest_head_change();
INSERT INTO mail_ingest_turns(workspace_id,served_at,active) SELECT workspace_id,'-infinity',count(*) FROM jobs WHERE type='mailbox.ingest' AND status IN ('pending','running') GROUP BY workspace_id ON CONFLICT(workspace_id) DO UPDATE SET active=excluded.active;
