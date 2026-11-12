-- bane:batched
-- Repairs feedback statuses written before migration 153 (see repair_feedback_status), one committed page at a time.
SELECT repair_feedback_status($1) AS cursor;
