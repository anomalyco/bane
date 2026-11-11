SET LOCAL lock_timeout='2s';
ALTER TABLE mail_receipts ADD routing jsonb;
