-- Compare source and projection in the same snapshot, then ADD only their
-- difference. A concurrent trigger delta (before or after our upsert) survives.
CREATE FUNCTION reconcile_sending_depth() RETURNS void LANGUAGE sql AS $$
  INSERT INTO sending_stream_depth SELECT workspace_id,stripe,marketing,sum(delta) FROM (
    SELECT workspace_id,hashtext(id)&15 AS stripe,coalesce(snapshot->>'kind'='marketing',false) AS marketing,count(*) AS delta
      FROM sending_emails WHERE review_id IS NULL AND status IN ('queued','attempting') GROUP BY 1,2,3
    UNION ALL SELECT workspace_id,stripe,marketing,-n FROM sending_stream_depth
  ) d GROUP BY 1,2,3 HAVING sum(delta)<>0 ORDER BY 1,2,3
  ON CONFLICT(workspace_id,stripe,marketing) DO UPDATE SET n=sending_stream_depth.n+excluded.n
$$;
SELECT reconcile_sending_depth();
CREATE FUNCTION reconcile_asset_usage() RETURNS void LANGUAGE sql AS $$
INSERT INTO sending_asset_usage SELECT workspace_id,sum(delta) FROM (
  SELECT workspace_id,size AS delta FROM sending_attachments UNION ALL SELECT workspace_id,size FROM sending_upload_reservations
  UNION ALL SELECT workspace_id,-bytes FROM sending_asset_usage
) a GROUP BY 1 HAVING sum(delta)<>0 ORDER BY 1 ON CONFLICT(workspace_id) DO UPDATE SET bytes=sending_asset_usage.bytes+excluded.bytes;
$$;
SELECT reconcile_asset_usage();
INSERT INTO mail_outbound_sync(id) SELECT id FROM mail_messages WHERE direction='outbound' AND sending_email_id IS NOT NULL AND status IN ('queued','attempting','accepted','sent','delayed','acceptance_unknown') FOR KEY SHARE ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION direct_pending_load(wid text,incoming int,marketing int) RETURNS TABLE(total int,projected int) LANGUAGE sql STABLE AS $$
  SELECT n,CASE WHEN EXISTS(SELECT FROM provider_connections WHERE workspace_id=wid AND kind='shared') THEN greatest(
    CASE WHEN incoming>marketing THEN n-m+incoming-marketing END,CASE WHEN marketing>0 THEN m+marketing END) ELSE n+incoming END
  FROM (SELECT coalesce(sum(n),0)::int n,coalesce(sum(n) FILTER(WHERE d.marketing),0)::int m FROM sending_stream_depth d WHERE workspace_id=wid) s
$$;
