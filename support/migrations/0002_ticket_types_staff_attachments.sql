-- Typed tickets with a structured part per type, the screenshots they carry, and staff closing them.
ALTER TABLE tickets ADD COLUMN type TEXT NOT NULL DEFAULT 'other' CHECK (type IN ('billing', 'bug', 'deliverability', 'account', 'abuse_report', 'feature_request', 'other'));
ALTER TABLE tickets ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE tickets ADD COLUMN details TEXT NOT NULL DEFAULT '{}';      -- JSON: topic; a bug's reproSteps, affected, requestIds, errorCodes, expected, actual; a feature's useCase
ALTER TABLE tickets ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';  -- JSON: attachment IDs (the objects live in the uploads bucket)
ALTER TABLE tickets ADD COLUMN resolved_at INTEGER;
ALTER TABLE tickets ADD COLUMN resolved_by TEXT;                        -- the operator's user ID
ALTER TABLE tickets ADD COLUMN resolution TEXT;
CREATE INDEX tickets_type_status ON tickets (type, status, created_at);

-- Bane's staff sign-in tokens are single use.
CREATE TABLE staff_tokens_used (
  jti TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
