-- bane:no-transaction
-- Receiving hosts, part 2 of 3: one receiving host routes for exactly one claim, across every workspace. Built online
-- (no write lock); part 1 already released legacy duplicates. A failed build leaves an invalid index that the migrator
-- drops and rebuilds on the next run.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS domain_claims_receiving_host ON domain_claims(receiving_host) WHERE receiving_host IS NOT NULL;
