-- Two gateway tasks and both replacements can be LISTENing during a roll.
-- The operator provisions this role; installations without a gateway do not need it.
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'bane_mailgw_listen') THEN
    ALTER ROLE bane_mailgw_listen CONNECTION LIMIT 4;
  END IF;
END $$;
