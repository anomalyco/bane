SET LOCAL lock_timeout='2s';
-- Feedback status ranks, enforced in the database for every Worker version. sending.ts ranks a
-- validation-suppressed recipient (SES Auto Validation drops it before sending) below every outcome
-- SES reports for mail it did send: delivered, bounced, rejected, rendering failed, complained.
-- A Worker deployed before this migration still embeds the old table, where suppressed tied with
-- bounced and outranked delivered, so during a deploy it could durably restore 'suppressed' over a
-- delivery or hard bounce the new version had already committed, or skip a delivery for a
-- suppressed email. Deploys run migrations first; these triggers hold the new ranking for any
-- caller from then on, and migration 154 repairs rows written before them.
-- Both triggers only add functions and triggers: no table rewrite, no backfill under this lock.

-- EMAIL_VALIDATION_SUPPRESSED explains a validation-suppressed status only: it keeps an earlier
-- error code (an acceptance_unknown dispatch) and leaves with the status.
CREATE OR REPLACE FUNCTION sending_feedback_rank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='suppressed' AND NEW.suppression_reason='email_validation'
    AND OLD.status IN ('delivered','bounced','complained','rejected','rendering_failed','canceled','simulated') THEN
    NEW.status:=OLD.status; NEW.error_code:=OLD.error_code; NEW.suppression_reason:=OLD.suppression_reason;
  ELSIF NEW.error_code='EMAIL_VALIDATION_SUPPRESSED' AND OLD.error_code IS DISTINCT FROM 'EMAIL_VALIDATION_SUPPRESSED'
    AND (NEW.status<>'suppressed' OR OLD.error_code IS NOT NULL) THEN
    NEW.error_code:=OLD.error_code;
  ELSIF NEW.error_code='EMAIL_VALIDATION_SUPPRESSED' AND NEW.status<>'suppressed' THEN
    NEW.error_code:=NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER sending_feedback_rank_guard BEFORE UPDATE ON sending_emails FOR EACH ROW
  WHEN (OLD.status='suppressed' OR NEW.status='suppressed' OR NEW.error_code='EMAIL_VALIDATION_SUPPRESSED')
  EXECUTE FUNCTION sending_feedback_rank_guard();

-- The old table skips a delivery for a validation-suppressed email (5 < 6) without updating the
-- row, so no UPDATE trigger sees it: apply it when its event is stored. Feedback statements already
-- hold these email rows; the lock is taken in id order like every other multi-email writer.
CREATE OR REPLACE FUNCTION sending_feedback_delivery_upgrade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH targets AS (
    SELECT e.id FROM sending_emails e JOIN new_events n ON n.workspace_id=e.workspace_id AND n.email_id=e.id
    WHERE n.type='delivery' AND e.status='suppressed' AND e.suppression_reason='email_validation'
    ORDER BY e.id FOR UPDATE OF e
  ) UPDATE sending_emails e SET status='delivered',suppression_reason=NULL,updated_at=clock_timestamp() FROM targets t WHERE e.id=t.id;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER sending_feedback_delivery_upgrade AFTER INSERT ON sending_email_events
  REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION sending_feedback_delivery_upgrade();

-- One repair page of rows written before the triggers, derived from stored events: a
-- validation-suppressed email takes its highest outcome event (complained, then bounced, rejected or
-- rendering failed, then delivered); a stale EMAIL_VALIDATION_SUPPRESSED on any other status is
-- cleared. Keyset pages over the primary key; idempotent, so a restart replays pages harmlessly.
-- Returns the next cursor, NULL after the last page. only_workspace scopes it (tests, operators).
CREATE OR REPLACE FUNCTION repair_feedback_status(cursor_key text, only_workspace text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
DECLARE last_id text;
BEGIN
  SELECT max(id) INTO last_id FROM (SELECT id FROM sending_emails WHERE id>coalesce(cursor_key,'') ORDER BY id LIMIT 10000) page;
  IF last_id IS NULL THEN RETURN NULL; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT e.id,e.workspace_id FROM sending_emails e
    WHERE e.id>coalesce(cursor_key,'') AND e.id<=last_id AND (only_workspace IS NULL OR e.workspace_id=only_workspace)
      AND ((e.status='suppressed' AND e.suppression_reason='email_validation') OR (e.status<>'suppressed' AND e.error_code='EMAIL_VALIDATION_SUPPRESSED'))
    ORDER BY e.id FOR UPDATE OF e
  ), outcome AS (
    SELECT DISTINCT ON (c.id) c.id,CASE v.type WHEN 'complaint' THEN 'complained' WHEN 'bounce' THEN 'bounced' WHEN 'reject' THEN 'rejected'
      WHEN 'rendering_failure' THEN 'rendering_failed' ELSE 'delivered' END AS status
    FROM candidates c JOIN sending_email_events v ON v.workspace_id=c.workspace_id AND v.email_id=c.id
    WHERE v.type IN ('complaint','bounce','reject','rendering_failure','delivery')
    ORDER BY c.id,CASE v.type WHEN 'complaint' THEN 3 WHEN 'delivery' THEN 1 ELSE 2 END DESC,v.created_at DESC,v.id
  )
  UPDATE sending_emails e SET
    status=CASE WHEN e.status='suppressed' THEN o.status ELSE e.status END,
    suppression_reason=CASE WHEN e.status='suppressed' THEN NULL ELSE e.suppression_reason END,
    error_code=NULLIF(e.error_code,'EMAIL_VALIDATION_SUPPRESSED'),updated_at=clock_timestamp()
  FROM candidates c LEFT JOIN outcome o USING (id)
  WHERE e.id=c.id AND (e.status<>'suppressed' OR o.status IS NOT NULL);
  RETURN last_id;
END $$;
