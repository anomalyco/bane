SET LOCAL lock_timeout='2s';

-- mail_receive_slot read the ingest backlog before it waited on the window row. A release pass
-- waiting behind a concurrent admission then counted the backlog without that admission's job
-- and released past backlog_limit after the commit (a backlog of 1 reached 2). Take the window
-- row first, then read the policy and the backlog in statements that start after the wait.
CREATE OR REPLACE FUNCTION mail_receive_slot(wid text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE h timestamptz:=date_trunc('hour',now()); maximum int; backlog int;
BEGIN
 INSERT INTO mail_receive_windows AS w VALUES(wid,h,0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=w.messages WHERE false;
 SELECT p.messages,p.backlog INTO maximum,backlog FROM mail_receive_policy(wid) p;
 IF maximum<=0 OR coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=wid),0)>=backlog THEN RETURN false; END IF;
 INSERT INTO mail_receive_windows AS w VALUES(wid,h,1,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=CASE WHEN w.window_at=h THEN w.messages+1 ELSE 1 END,bytes=CASE WHEN w.window_at=h THEN w.bytes ELSE 0 END,window_at=h WHERE w.window_at<>h OR w.messages<maximum;
 RETURN FOUND;
END $$;
