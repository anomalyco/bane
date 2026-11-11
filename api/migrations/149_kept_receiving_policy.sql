SET LOCAL lock_timeout='2s';

-- A connection's sending template_version is not proof of the customer's installed
-- receiving policy. Operators record the verified stack output for this exact binding.
-- No existing BYO role is enrolled by migration or by a workspace request.
CREATE TABLE mail_kept_policy_v1 (
 connection_id text PRIMARY KEY REFERENCES provider_connections(id) ON DELETE CASCADE,
 role_arn text NOT NULL, region text NOT NULL, bucket text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now()
);

ALTER FUNCTION create_managed_inbox(jsonb) RENAME TO create_managed_inbox_checked;
CREATE FUNCTION create_managed_inbox(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
 IF p#>>'{input,type}'='persistent' AND (p->>'hosted')::boolean AND EXISTS (
  SELECT FROM provider_connections c WHERE c.workspace_id=p->>'wid' AND c.kind='byo'
   AND NOT EXISTS (SELECT FROM mail_kept_policy_v1 k JOIN mailbox_regions r ON r.workspace_id=c.workspace_id AND r.region=k.region AND r.bucket=k.bucket AND r.account_id=c.aws_account_id
     WHERE k.connection_id=c.id AND k.role_arn=c.role_arn AND k.region=c.region)
 ) THEN RETURN '{"error":"BYO_KEPT_POLICY_REQUIRED"}'; END IF;
 RETURN create_managed_inbox_checked(p);
END $$;
