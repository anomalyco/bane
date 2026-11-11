-- Receiving hosts, part 3 of 3: check existing rows against part 1's CHECK. VALIDATE takes SHARE UPDATE EXCLUSIVE, which
-- doesn't block reads or writes, and runs in its own transaction after part 1 committed (so no ACCESS EXCLUSIVE is held
-- during the scan).
SET LOCAL lock_timeout='1min';
ALTER TABLE domain_claims VALIDATE CONSTRAINT domain_claims_receiving_host_scope;
