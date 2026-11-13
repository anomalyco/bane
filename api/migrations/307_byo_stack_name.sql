-- A BYO connection's CloudFormation stack, which is also its IAM role's name. Connections made before the Nightmail
-- rename keep Bane-<id>; new ones get the name chosen when they are created (BYO_STACK_PREFIX), so a later switch never
-- renames a stack its owner has already launched.
ALTER TABLE provider_connections ADD COLUMN stack_name text CHECK (stack_name ~ '^(Nightmail|Bane)-[0-9a-z]{20}$');
UPDATE provider_connections SET stack_name = 'Bane-' || right(id, 20) WHERE kind = 'byo';
