-- Only manual API work is charged here; normal message delivery and retries never touch this row.
CREATE TABLE mailbox_manual_delivery_budget(workspace_id text PRIMARY KEY,hour timestamptz NOT NULL,used integer NOT NULL);
