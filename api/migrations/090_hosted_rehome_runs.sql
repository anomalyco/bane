CREATE TABLE hosted_rehome_runs (
  run_id text PRIMARY KEY, inputs jsonb NOT NULL, plan_sha256 text NOT NULL,
  post_sha256 text, applied_at timestamptz NOT NULL DEFAULT now(), restored_at timestamptz, finalized_at timestamptz
);
CREATE TABLE hosted_rehome_images (
  run_id text REFERENCES hosted_rehome_runs ON DELETE CASCADE, relation text, chunk bigint,
  before_image jsonb NOT NULL, PRIMARY KEY(run_id,relation,chunk)
);
