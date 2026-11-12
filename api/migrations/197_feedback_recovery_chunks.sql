-- Full recovery bodies stay durable until an operator resolves them. Parent + chunks commit together.
ALTER TABLE operation_feedback_failures ADD COLUMN payload_chunk_count integer NOT NULL DEFAULT 0 CHECK (payload_chunk_count >= 0);
CREATE TABLE operation_feedback_failure_chunks (
  failure_id text NOT NULL REFERENCES operation_feedback_failures(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  payload text NOT NULL,
  PRIMARY KEY (failure_id, ordinal)
);
