SET LOCAL lock_timeout='2s';
-- billing_post is the only writer of balances and ledger rows. Idempotent on (kind, source_id): a repeat returns
-- applied=false and the current balances. Lock order: billing_accounts first, then the ledger.
CREATE FUNCTION billing_post(wid text, k text, src text, paid bigint, promo bigint, det jsonb, who text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; eid bigint;
  credit boolean := k IN ('topup','grant','refund_release','dispute_reversal') OR (k='adjustment' AND paid+promo>0);
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  IF a.promo_uc+promo < 0 THEN RAISE EXCEPTION 'promo below zero' USING ERRCODE='23514'; END IF;
  INSERT INTO billing_ledger(workspace_id,kind,source_id,paid_uc,promo_uc,balance_after_uc,promo_after_uc,detail,actor)
    VALUES (wid,k,src,paid,promo,a.balance_uc+paid,a.promo_uc+promo,coalesce(det,'{}'),who)
    ON CONFLICT (kind,source_id) DO NOTHING RETURNING id INTO eid;
  IF eid IS NULL THEN RETURN jsonb_build_object('applied',false,'balanceUc',a.balance_uc::text,'promoUc',a.promo_uc::text); END IF;
  UPDATE billing_accounts SET balance_uc=balance_uc+paid, promo_uc=promo_uc+promo, updated_at=now(),
    unpaid_since = CASE WHEN balance_uc+paid<0 THEN coalesce(unpaid_since,now()) WHEN credit THEN NULL ELSE unpaid_since END,
    empty_since  = CASE WHEN credit AND balance_uc+paid+promo_uc+promo>0 THEN NULL ELSE empty_since END,
    low_since    = CASE WHEN credit AND balance_uc+paid+promo_uc+promo>=low_balance_uc THEN NULL ELSE low_since END,
    recharge_month_total_uc = CASE WHEN det->>'recharge'='true' THEN
      CASE WHEN recharge_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN recharge_month_total_uc ELSE 0 END + paid
      ELSE recharge_month_total_uc END,
    recharge_month = CASE WHEN det->>'recharge'='true' THEN (date_trunc('month',now() AT TIME ZONE 'UTC'))::date ELSE recharge_month END
  WHERE workspace_id=wid;
  IF credit THEN  -- release receive holds and wake campaigns waiting on balance
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.restored:'||wid,'billing.restored',wid,'{}')
      ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
      WHERE jobs.status IN ('completed','failed');
  END IF;
  RETURN jsonb_build_object('applied',true,'entryId',eid::text,'balanceUc',(a.balance_uc+paid)::text,'promoUc',(a.promo_uc+promo)::text);
END $$;

-- One owner notice per dedupe key. Outside 'enforce', or for an account that isn't prepaid, it is recorded as
-- suppressed and no email is queued. Returns the notice ID when this call created it, otherwise NULL.
CREATE FUNCTION billing_notice(wid text, k text, dedupe text, data jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE nid text; live boolean;
BEGIN
  live := (SELECT mode='enforce' FROM billing_config WHERE singleton)
    AND coalesce((SELECT mode FROM billing_accounts WHERE workspace_id=wid),'prepaid')='prepaid';
  INSERT INTO billing_notices(workspace_id,kind,dedupe_key,data,status)
    VALUES (wid,k,dedupe,coalesce(data,'{}'),CASE WHEN live THEN 'pending' ELSE 'suppressed' END)
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING id INTO nid;
  IF nid IS NOT NULL AND live THEN
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.notify:'||nid,'billing.notify',wid,jsonb_build_object('noticeId',nid))
      ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN nid;
END $$;
