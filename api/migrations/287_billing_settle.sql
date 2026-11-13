SET LOCAL lock_timeout='2s';
-- Hourly settlement: one transaction per workspace prices the unsettled usage of closed hours, applies the free tier,
-- writes one ledger row through billing_post and moves settled_quantity up. Exactly-once comes from atomicity:
-- settled_quantity and the ledger row commit together. Writers never touch closed hours (they bucket by now()) and
-- never lock billing_accounts, so the settler's lock order (account → closed usage rows → ledger) can't cycle with them.
CREATE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; r record; delta bigint; before bigint; after bigint; payable numeric;
  line numeric; cost numeric := 0; spend numeric; det jsonb := '{}'; m jsonb; rmonth date; mon date; used bigint;
  n int := 0; cost_uc bigint; charged boolean; promo_draw bigint := 0; paid_draw bigint := 0; total bigint;
  posted jsonb; first_hour timestamptz; last_hour timestamptz; recharging boolean;
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"busy":true}'; END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  mon := a.free_month; used := a.free_emails_used; spend := a.month_spend_uc;
  FOR r IN SELECT hour, meter, rate_version, quantity, settled_quantity FROM billing_usage_hourly
      WHERE workspace_id=wid AND quantity<>settled_quantity AND hour<cutoff ORDER BY hour, meter FOR UPDATE LOOP
    delta := r.quantity - r.settled_quantity;
    rmonth := (date_trunc('month', r.hour AT TIME ZONE 'UTC'))::date;
    IF rmonth > mon THEN mon := rmonth; used := 0; spend := 0; END IF;
    IF r.meter IN ('send','receive') THEN
      IF rmonth < mon THEN payable := delta;              -- a late write into a past month: full rate, no free units
      ELSE before := used; after := greatest(0, before + delta);
        payable := greatest(0, after - 3000) - greatest(0, before - 3000); used := after; END IF;
      line := payable * 20000;
    ELSIF r.meter = 'omen' THEN payable := delta; line := delta * 10000::numeric;
    ELSIF r.meter = 'storage' THEN payable := delta; line := delta * billing_rate_uc('storage', r.rate_version, r.hour);
    ELSE payable := 0; line := 0; END IF;                  -- byo_*: $0, reported
    cost := cost + line;
    IF rmonth >= mon THEN spend := spend + line; END IF;
    m := coalesce(det->r.meter, '{"quantity":0,"payable":0,"costUc":0}'::jsonb);
    det := det || jsonb_build_object(r.meter, jsonb_build_object('quantity', (m->>'quantity')::numeric + delta,
      'payable', (m->>'payable')::numeric + payable, 'costUc', (m->>'costUc')::numeric + line));
    UPDATE billing_usage_hourly SET settled_quantity=r.quantity
      WHERE workspace_id=wid AND hour=r.hour AND meter=r.meter AND rate_version=r.rate_version;
    first_hour := least(first_hour, r.hour); last_hour := greatest(last_hour, r.hour); n := n + 1;
  END LOOP;
  IF n = 0 THEN RETURN jsonb_build_object('entries', 0); END IF;
  cost_uc := round(cost);
  -- Shadow and exempt accounts post $0 rows with the would-be cost, so history and shadow bills can be compared.
  charged := cfg.mode='enforce' AND a.mode IN ('prepaid','invoiced');
  IF charged THEN promo_draw := least(a.promo_uc, greatest(cost_uc, 0)); paid_draw := cost_uc - promo_draw; END IF;
  posted := billing_post(wid, 'usage', 'usage:'||wid||':'||txid_current()||':'||extract(epoch FROM clock_timestamp()), -paid_draw, -promo_draw,
    jsonb_build_object('meters', det, 'costUc', cost_uc::text, 'charged', charged, 'from', first_hour, 'to', last_hour + interval '1 hour', 'rateVersion', 1), 'system');
  UPDATE billing_accounts SET free_month=mon, free_emails_used=least(used, 2147483647)::int, month_spend_uc=round(spend)::bigint, updated_at=now()
    WHERE workspace_id=wid RETURNING * INTO a;
  -- Notices and auto-recharge act only for real money: enforce, prepaid. low_balance covers a funded balance running
  -- low (above $0); sends_paused covers $0 or debt once the free allowance is spent. Episodes end with a credit (billing_post).
  IF cfg.mode='enforce' AND a.mode='prepaid' THEN
    total := a.balance_uc + a.promo_uc;
    recharging := a.recharge_enabled AND a.recharge_disabled_at IS NULL AND a.stripe_payment_method IS NOT NULL;
    IF total > 0 AND total < a.low_balance_uc AND a.low_since IS NULL AND NOT recharging THEN
      UPDATE billing_accounts SET low_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'low_balance', 'low_balance:'||wid||':'||a.low_since, jsonb_build_object('totalUc', total::text));
    END IF;
    IF total <= 0 AND a.free_emails_used >= 3000 AND a.empty_since IS NULL THEN
      UPDATE billing_accounts SET empty_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'sends_paused', 'sends_paused:'||wid||':'||a.empty_since,
        jsonb_build_object('totalUc', total::text, 'unpaidSince', a.unpaid_since));
    END IF;
    IF recharging AND a.recharge_pending_attempt IS NULL AND total < a.recharge_threshold_uc THEN
      INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.recharge:'||wid,'billing.recharge',wid,'{}')
        ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
        WHERE jobs.status IN ('completed','failed');
    END IF;
  END IF;
  RETURN jsonb_build_object('entries', n, 'costUc', cost_uc::text, 'charged', charged, 'entryId', posted->>'entryId');
END $$;

-- The storage day for day d (yesterday, UTC): add the bytes of days that turned 91 days old to each workspace's aged
-- sum, then meter one day of aged bytes beyond the free 1 GB. Rerunning a day is a no-op (cursor + ON CONFLICT).
CREATE FUNCTION billing_storage_day(d date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE through date := d - 91; since date; aged int; metered int;
BEGIN
  SELECT storage_aged_through INTO since FROM billing_config WHERE singleton FOR UPDATE;
  IF since IS NOT NULL AND since >= through THEN RETURN jsonb_build_object('aged', 0, 'metered', 0, 'through', since); END IF;
  INSERT INTO mail_storage_aged AS a (workspace_id, aged_bytes, aged_through)
    SELECT workspace_id, sum(bytes), through FROM mail_storage_days
    WHERE day <= through AND (since IS NULL OR day > since) GROUP BY 1 ORDER BY 1
    ON CONFLICT (workspace_id) DO UPDATE SET aged_bytes=a.aged_bytes+excluded.aged_bytes, aged_through=excluded.aged_through;
  GET DIAGNOSTICS aged = ROW_COUNT;
  UPDATE mail_storage_aged SET aged_through=through WHERE aged_through<through;
  UPDATE billing_config SET storage_aged_through=through, updated_at=now() WHERE singleton;
  INSERT INTO billing_usage_hourly (workspace_id, hour, meter, rate_version, quantity)
    SELECT workspace_id, d::timestamp AT TIME ZONE 'UTC', 'storage', 1, aged_bytes - 1000000000
    FROM mail_storage_aged WHERE aged_bytes > 1000000000 ORDER BY workspace_id
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS metered = ROW_COUNT;
  RETURN jsonb_build_object('aged', aged, 'metered', metered, 'through', through);
END $$;

-- The daily unpaid scan (prepaid accounts in debt). Notices go out only under enforce, so shadow never uses up a
-- notice's dedupe key. A debt older than 60 days with no credit in that time is written off; unpaid_since stays
-- (and so does a receive hold) until a top-up.
CREATE FUNCTION billing_unpaid_scan() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE cfg billing_config; r record; soon int := 0; held int := 0; written int := 0;
BEGIN
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  FOR r IN SELECT workspace_id, unpaid_since, balance_uc FROM billing_accounts
      WHERE unpaid_since IS NOT NULL AND unpaid_since <= now() - interval '5 days' AND mode='prepaid' ORDER BY unpaid_since LIMIT 5000 LOOP
    IF cfg.mode='enforce' THEN
      IF billing_notice(r.workspace_id, 'receive_hold_soon', 'receive_hold_soon:'||r.workspace_id||':'||r.unpaid_since,
          jsonb_build_object('debtUc', (-least(r.balance_uc,0))::text, 'holdAt', r.unpaid_since + interval '7 days')) IS NOT NULL THEN soon := soon + 1; END IF;
      IF cfg.receive_hold AND r.unpaid_since <= now() - interval '7 days' AND billing_notice(r.workspace_id, 'receive_held', 'receive_held:'||r.workspace_id||':'||r.unpaid_since,
          jsonb_build_object('debtUc', (-least(r.balance_uc,0))::text, 'heldSince', r.unpaid_since + interval '7 days')) IS NOT NULL THEN held := held + 1; END IF;
    END IF;
    IF r.unpaid_since <= now() - interval '60 days' AND r.balance_uc < 0 AND NOT EXISTS (SELECT FROM billing_ledger l
        WHERE l.workspace_id=r.workspace_id AND l.created_at > now() - interval '60 days' AND l.kind IN ('topup','grant','refund_release','dispute_reversal','adjustment') AND l.paid_uc + l.promo_uc > 0) THEN
      IF (billing_post(r.workspace_id, 'write_off', 'write_off:'||r.workspace_id||':'||(r.unpaid_since AT TIME ZONE 'UTC')::date, -r.balance_uc, 0,
          jsonb_build_object('debtUc', (-r.balance_uc)::text, 'unpaidSince', r.unpaid_since), 'system')->>'applied')::boolean THEN written := written + 1; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('receiveHoldSoon', soon, 'receiveHeld', held, 'writtenOff', written);
END $$;
