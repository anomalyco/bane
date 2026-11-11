SET LOCAL lock_timeout='2s';
-- Actions use their deterministic delivery primary key; the public source event ID stays in payload.
ALTER TABLE mailbox_webhook_deliveries ALTER COLUMN event_seq DROP NOT NULL;
