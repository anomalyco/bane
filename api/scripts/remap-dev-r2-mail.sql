-- Operator only; deliberately outside migrations/. Do not run until object and writer fences are verified.
-- psql -X -v ON_ERROR_STOP=1 -v direction=forward -v apply=false -f scripts/remap-dev-r2-mail.sql
-- direction=reverse restores old logical names; copy any post-cutover object deltas before rollback.
-- Refuse collisions: with writers fenced, every target value must be attributable to this batch.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
SELECT :'direction' IN ('forward','reverse') AND :'apply' IN ('true','false') AS valid \gset
\if :valid
\else
  DO $$ BEGIN RAISE EXCEPTION 'Expected direction=forward|reverse and apply=true|false'; END $$;
\endif
-- These are R2 location columns, not physical object keys, S3 pointers, signed notifications or idempotency keys.
LOCK TABLE provider_pool_regions IN SHARE MODE;
LOCK TABLE mail_messages,mail_attachments,mail_candidate_uploads IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM provider_pool_regions WHERE aws_account_id='905840579680' AND region='us-east-2')
    OR EXISTS (SELECT FROM provider_pool_regions WHERE aws_account_id IS DISTINCT FROM '905840579680')
    THEN RAISE EXCEPTION 'Not the dedicated dev installation'; END IF;
END $$;
SELECT CASE :'direction' WHEN 'forward' THEN 'r2:bane-dev-mail' ELSE 'r2:nightmail-dev-mail' END AS src,
       CASE :'direction' WHEN 'forward' THEN 'r2:nightmail-dev-mail' ELSE 'r2:bane-dev-mail' END AS dst \gset
SELECT NOT EXISTS (SELECT FROM mail_messages WHERE raw_bucket=:'dst' UNION ALL
                   SELECT FROM mail_attachments WHERE bucket=:'dst' UNION ALL
                   SELECT FROM mail_candidate_uploads WHERE bucket=:'dst') AS clear \gset
\if :clear
\else
  DO $$ BEGIN RAISE EXCEPTION 'Mixed destination references: reconcile before remapping'; END $$;
\endif
UPDATE mail_messages SET raw_bucket=:'dst' WHERE raw_bucket=:'src';
UPDATE mail_attachments SET bucket=:'dst' WHERE bucket=:'src';
UPDATE mail_candidate_uploads SET bucket=:'dst' WHERE bucket=:'src';
\if :apply
  COMMIT;
\else
  ROLLBACK;
\endif
