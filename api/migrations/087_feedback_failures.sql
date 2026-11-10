SET LOCAL lock_timeout='1s';
-- Operator-only dead letters. JSON text preserves diagnostics PostgreSQL JSONB cannot represent.
CREATE TABLE operation_feedback_failures (id text PRIMARY KEY, payload text NOT NULL, workspace_id text, topic_arn text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX operation_feedback_failures_age ON operation_feedback_failures(created_at);
