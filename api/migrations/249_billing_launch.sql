SET LOCAL lock_timeout='2s';
-- Launch decisions (Ryan, 2026-11-12) and the review's "before enforce" fixes (review-billing.md 4, 5, 8, 9, 10).

-- 1. Billing launches enforced. 'shadow' and 'off' stay as operator kill-switches. Every workspace that exists now is
--    Anomaly's (Bane is Anomaly-only at launch), so each is exempt: nobody is charged by surprise. New workspaces are
--    prepaid.
ALTER TABLE billing_config ALTER COLUMN mode SET DEFAULT 'enforce';
UPDATE billing_config SET mode='enforce', enforced_at=coalesce(enforced_at, now()), updated_at=now() WHERE singleton AND mode='off';
INSERT INTO billing_accounts(workspace_id, mode) SELECT id, 'exempt' FROM workspaces ORDER BY id
  ON CONFLICT (workspace_id) DO UPDATE SET mode='exempt', updated_at=now();

-- 2. Received mail that Bane's spam screen flagged is free: no receive unit, no free-tier use, no stored bytes. Only SES's
--    own verdict on the receipt counts (FAIL or GRAY, which ingest junks): it is set once at ingest, never by the
--    workspace, a ritual or a sender, and a missing verdict (no scan) is billed. Sending is unaffected. Omen
--    evaluations on such mail are still metered: each is a Jev call the workspace's own ritual asked for.
CREATE FUNCTION billing_spam_free(spam boolean, verdicts jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(spam AND verdicts->>'spam' IN ('FAIL','GRAY'), false)
$$;
CREATE OR REPLACE FUNCTION billing_meter_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
  SELECT n.workspace_id, date_trunc('hour',now(),'UTC'), m.meter, 1, sum(m.q)
  FROM new_rows n
  LEFT JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id=n.workspace_id ORDER BY kind LIMIT 1) pc ON true
  CROSS JOIN LATERAL (VALUES (CASE WHEN pc.kind='byo' THEN 'byo_receive' ELSE 'receive' END, CASE WHEN billing_spam_free(n.spam,n.verdicts) THEN 0 ELSE 1 END::bigint),
                             ('omen', coalesce((n.verdicts->>'omenCalls')::bigint,0))) m(meter,q)
  WHERE n.direction='inbound' AND n.ses_message_id IS NOT NULL AND m.q>0
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  INSERT INTO mail_storage_days AS d (workspace_id,day,bytes)
  SELECT workspace_id,(received_at AT TIME ZONE 'UTC')::date,sum(coalesce(size_bytes,0)) FROM new_rows
  WHERE direction='inbound' AND NOT billing_spam_free(spam,verdicts) GROUP BY 1,2 ORDER BY 1,2
  ON CONFLICT (workspace_id,day) DO UPDATE SET bytes=d.bytes+excluded.bytes;
  RETURN NULL;
END $$;
-- spam and verdicts never change after insert, so a delete takes off exactly what the insert added.
CREATE OR REPLACE FUNCTION billing_unmeter_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mail_storage_days d SET bytes=greatest(0,d.bytes-g.bytes)
  FROM (SELECT workspace_id,(received_at AT TIME ZONE 'UTC')::date AS day,sum(coalesce(size_bytes,0)) AS bytes
        FROM old_rows WHERE direction='inbound' AND NOT billing_spam_free(spam,verdicts) GROUP BY 1,2 ORDER BY 1,2) g
  WHERE d.workspace_id=g.workspace_id AND d.day=g.day;
  UPDATE mail_storage_aged a SET aged_bytes=greatest(0,a.aged_bytes-s.bytes)
  FROM (SELECT o.workspace_id,sum(coalesce(o.size_bytes,0)) AS bytes FROM old_rows o
        JOIN mail_storage_aged x ON x.workspace_id=o.workspace_id AND (o.received_at AT TIME ZONE 'UTC')::date<=x.aged_through
        WHERE o.direction='inbound' AND NOT billing_spam_free(o.spam,o.verdicts) GROUP BY 1 ORDER BY 1) s
  WHERE a.workspace_id=s.workspace_id;
  RETURN NULL;
END $$;
-- The storage tables are new and nothing has been priced from them yet: rebuild them without flagged spam.
DELETE FROM mail_storage_aged;
DELETE FROM mail_storage_days;
UPDATE billing_config SET storage_aged_through=NULL WHERE singleton;
INSERT INTO mail_storage_days (workspace_id,day,bytes)
SELECT workspace_id, (received_at AT TIME ZONE 'UTC')::date, sum(coalesce(size_bytes,0))
FROM mail_messages WHERE direction='inbound' AND NOT billing_spam_free(spam,verdicts)
GROUP BY 1,2;

-- 3. (Review 5) A charged <-> uncharged change of a send from an earlier month is written into that month's last hour,
--    and the settler prices a late write into a past month against that month's own free pool (the sum of its settled
--    send and receive units), so a refund returns exactly what the month charged for it. A change within the current
--    month still lands in the current hour: monthly pricing is order-free, so that is exact too, and it keeps one
--    usage row per (workspace, meter) per statement, as before.
CREATE OR REPLACE FUNCTION billing_adjust_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; m text; h timestamptz;
BEGIN
  IF NEW.simulated AND NOT (SELECT bill_simulated FROM billing_config WHERE singleton) THEN RETURN NULL; END IF;
  d := (hosted_charged(NEW.status,NEW.provider_id,NEW.error_code)::int - hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)::int)
       * jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses);
  SELECT CASE WHEN (NEW.feedback_topic_arn IS NULL AND kind='shared') OR EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=NEW.feedback_topic_arn)
         THEN 'send' ELSE 'byo_send' END INTO m FROM provider_connections WHERE workspace_id=NEW.workspace_id ORDER BY kind LIMIT 1;
  IF d=0 OR m IS NULL THEN RETURN NULL; END IF;
  h := CASE WHEN date_trunc('month',NEW.created_at,'UTC') < date_trunc('month',now(),'UTC')
         THEN date_trunc('month',NEW.created_at,'UTC') + interval '1 month' - interval '1 hour'
         ELSE date_trunc('hour',now(),'UTC') END;
  INSERT INTO billing_usage_hourly AS u VALUES (NEW.workspace_id,h,m,1,d,0)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  RETURN NULL;
END $$;

-- 4. (Review 9) billing_post: a replay returns applied=false before the promo check, so replaying a promo draw never raises.
CREATE OR REPLACE FUNCTION billing_post(wid text, k text, src text, paid bigint, promo bigint, det jsonb, who text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; eid bigint;
  credit boolean := k IN ('topup','grant','refund_release','dispute_reversal') OR (k='adjustment' AND paid+promo>0);
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  INSERT INTO billing_ledger(workspace_id,kind,source_id,paid_uc,promo_uc,balance_after_uc,promo_after_uc,detail,actor)
    VALUES (wid,k,src,paid,promo,a.balance_uc+paid,a.promo_uc+promo,coalesce(det,'{}'),who)
    ON CONFLICT (kind,source_id) DO NOTHING RETURNING id INTO eid;
  IF eid IS NULL THEN RETURN jsonb_build_object('applied',false,'balanceUc',a.balance_uc::text,'promoUc',a.promo_uc::text); END IF;
  IF a.promo_uc+promo < 0 THEN RAISE EXCEPTION 'promo below zero' USING ERRCODE='23514'; END IF;
  UPDATE billing_accounts SET balance_uc=balance_uc+paid, promo_uc=promo_uc+promo, updated_at=now(),
    unpaid_since = CASE WHEN balance_uc+paid<0 THEN coalesce(unpaid_since,now()) WHEN credit THEN NULL ELSE unpaid_since END,
    empty_since  = CASE WHEN credit AND balance_uc+paid+promo_uc+promo>0 THEN NULL ELSE empty_since END,
    low_since    = CASE WHEN credit AND balance_uc+paid+promo_uc+promo>=low_balance_uc THEN NULL ELSE low_since END,
    recharge_month_total_uc = CASE WHEN det->>'recharge'='true' THEN
      CASE WHEN recharge_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN recharge_month_total_uc ELSE 0 END + paid
      ELSE recharge_month_total_uc END,
    recharge_month = CASE WHEN det->>'recharge'='true' THEN (date_trunc('month',now() AT TIME ZONE 'UTC'))::date ELSE recharge_month END
  WHERE workspace_id=wid;
  IF credit THEN
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.restored:'||wid,'billing.restored',wid,'{}')
      ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
      WHERE jobs.status IN ('completed','failed');
  END IF;
  RETURN jsonb_build_object('applied',true,'entryId',eid::text,'balanceUc',(a.balance_uc+paid)::text,'promoUc',(a.promo_uc+promo)::text);
END $$;

-- 5. (Review 4) Promotional credit spent by usage is tracked, so a negative settlement (refunds outweighing new usage)
--    goes back to promo first, up to what promo paid, and only the rest to paid credit: refunds never turn promo
--    into refundable cash.
ALTER TABLE billing_accounts ADD COLUMN promo_spent_uc bigint NOT NULL DEFAULT 0 CHECK (promo_spent_uc >= 0);

-- billing_settle: 248's version with review 4 and 5, and usage rows taken SKIP LOCKED (a row a writer holds settles
-- next run, so the settler never waits on a writer).
CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
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
      WHERE workspace_id=wid AND quantity<>settled_quantity AND hour<cutoff ORDER BY hour, meter FOR UPDATE SKIP LOCKED LOOP
    delta := r.quantity - r.settled_quantity;
    rmonth := (date_trunc('month', r.hour AT TIME ZONE 'UTC'))::date;
    IF rmonth > mon THEN mon := rmonth; used := 0; spend := 0; END IF;
    IF r.meter IN ('send','receive') THEN
      IF rmonth < mon THEN
        -- A late write into a past month (a refund of mail queued across the month boundary): that month's own pool.
        SELECT coalesce(sum(settled_quantity),0) INTO before FROM billing_usage_hourly
          WHERE workspace_id=wid AND meter IN ('send','receive')
            AND hour >= rmonth::timestamp AT TIME ZONE 'UTC' AND hour < (rmonth + interval '1 month')::timestamp AT TIME ZONE 'UTC';
        after := greatest(0, before + delta);
      ELSE before := used; after := greatest(0, before + delta); used := after; END IF;
      payable := greatest(0, after - 3000) - greatest(0, before - 3000);
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
  charged := cfg.mode='enforce' AND a.mode IN ('prepaid','invoiced');
  IF charged THEN
    IF cost_uc >= 0 THEN promo_draw := least(a.promo_uc, cost_uc);
    ELSE promo_draw := -least(a.promo_spent_uc, -cost_uc); END IF;   -- a refund returns promo first, up to what it paid
    paid_draw := cost_uc - promo_draw;
  END IF;
  posted := billing_post(wid, 'usage', 'usage:'||wid||':'||txid_current()||':'||extract(epoch FROM clock_timestamp()), -paid_draw, -promo_draw,
    jsonb_build_object('meters', det, 'costUc', cost_uc::text, 'charged', charged, 'from', first_hour, 'to', last_hour + interval '1 hour', 'rateVersion', 1), 'system');
  UPDATE billing_accounts SET free_month=mon, free_emails_used=least(used, 2147483647)::int, month_spend_uc=round(spend)::bigint,
      promo_spent_uc=promo_spent_uc+promo_draw, updated_at=now()
    WHERE workspace_id=wid RETURNING * INTO a;
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

-- 6. (Review 8) The write-off key carries the scan day, so debt that builds up again under the same unpaid episode
--    (unpaid_since is kept after a write-off, and so is a receive hold) is written off too, at most once a day.
CREATE OR REPLACE FUNCTION billing_unpaid_scan() RETURNS jsonb LANGUAGE plpgsql AS $$
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
      IF (billing_post(r.workspace_id, 'write_off', 'write_off:'||r.workspace_id||':'||(r.unpaid_since AT TIME ZONE 'UTC')::date||':'||(now() AT TIME ZONE 'UTC')::date,
          -r.balance_uc, 0, jsonb_build_object('debtUc', (-r.balance_uc)::text, 'unpaidSince', r.unpaid_since), 'system')->>'applied')::boolean THEN written := written + 1; END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('receiveHoldSoon', soon, 'receiveHeld', held, 'writtenOff', written);
END $$;
