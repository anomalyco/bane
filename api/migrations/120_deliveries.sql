SET LOCAL lock_timeout='2s';
ALTER TABLE mailbox_webhook_deliveries ADD routed boolean NOT NULL DEFAULT false, ADD format text NOT NULL DEFAULT 'bane', ADD last_redelivery_at timestamptz;
