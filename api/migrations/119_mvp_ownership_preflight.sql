-- MVP ownership cannot be recovered reliably from old workspace-wide approval records.
DO $$ DECLARE t text; populated boolean; BEGIN
 FOREACH t IN ARRAY ARRAY['mail_ritual_configs','mail_ritual_versions','mail_endpoints','mail_grant_objects','mail_action_attempts','mail_routes'] LOOP
  IF to_regclass(t) IS NOT NULL THEN
   EXECUTE format('SELECT EXISTS(SELECT FROM %I)',t) INTO populated;
   IF populated THEN RAISE EXCEPTION 'MVP_OWNERSHIP_PREFLIGHT: % is not empty',t; END IF;
  END IF;
 END LOOP;
 IF to_regclass('mailbox_webhook_deliveries') IS NOT NULL AND EXISTS(SELECT FROM mailbox_webhook_deliveries WHERE payload ?| ARRAY['ritualAction','grants']) THEN
  RAISE EXCEPTION 'MVP_OWNERSHIP_PREFLIGHT: existing owned deliveries';
 END IF;
END $$;
