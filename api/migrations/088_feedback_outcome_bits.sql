SET LOCAL lock_timeout='1s';
-- Keep SES bounce notifications observable without charging soft bounces as hard.
-- Local terminal notifications share the existing email.rejected webhook subscription,
-- but are not evidence that SES rejected the mail (or even that SES was called).
CREATE OR REPLACE FUNCTION record_email_event_outcomes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH bits AS (
    SELECT n.workspace_id, n.data->>'emailId' AS email_id,
      bit_or(CASE n.type WHEN 'email.sent' THEN 1 WHEN 'email.delivered' THEN 3
        WHEN 'email.bounced' THEN CASE WHEN n.data->>'bounceSubType'='EmailValidationSuppressed' THEN 0
          WHEN n.data->>'bounceType'='Permanent' THEN 5 ELSE 129 END
        WHEN 'email.complained' THEN 9 WHEN 'email.delivery_delayed' THEN 129 WHEN 'email.opened' THEN 16
        WHEN 'email.clicked' THEN 32 WHEN 'email.rejected' THEN CASE WHEN n.data->>'status' IN ('suppressed','canceled','acceptance_unknown') THEN 0 ELSE 64 END
        WHEN 'email.rendering_failed' THEN 64 ELSE 0 END) AS bits
    FROM new_events n WHERE n.data ? 'emailId' GROUP BY 1,2
  ), targets AS (
    SELECT e.id,b.bits::smallint AS bits FROM sending_emails e JOIN bits b ON e.id=b.email_id AND e.workspace_id=b.workspace_id
    WHERE b.bits<>0 AND (e.event_outcomes | b.bits::smallint)<>e.event_outcomes ORDER BY e.id FOR UPDATE OF e
  ) UPDATE sending_emails e SET event_outcomes=e.event_outcomes | t.bits FROM targets t WHERE e.id=t.id;
  RETURN NULL;
END $$;
