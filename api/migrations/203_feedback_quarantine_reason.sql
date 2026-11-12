-- Why a row sits in the feedback quarantine. SES_FEEDBACK_QUARANTINED: a verified callback the
-- ingestion statement refused deterministically (migration 087). FEEDBACK_UNTAGGED: an item found
-- without a tag on the legacy feedback queue after the queue consumer started requiring tags; it is
-- never ingested automatically and waits for scripts/replay-feedback-quarantine.ts.
ALTER TABLE operation_feedback_failures ADD COLUMN reason text NOT NULL DEFAULT 'SES_FEEDBACK_QUARANTINED';
CREATE INDEX operation_feedback_failures_untagged ON operation_feedback_failures(created_at) WHERE reason = 'FEEDBACK_UNTAGGED';
