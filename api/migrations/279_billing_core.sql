SET LOCAL lock_timeout='2s';
-- Hosted billing (prepaid USD balance). Money is integer micro-cents (µ¢): 1¢ = 1,000,000 µ¢, $1 = 100,000,000 µ¢.
-- Installation-wide switch. A database row, so ops can flip it (and roll back) without a deploy.
CREATE TABLE billing_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow','enforce')),
  receive_hold boolean NOT NULL DEFAULT false,      -- receive holds (284) merged + IAM ready; only matters in 'enforce'
  bill_simulated boolean NOT NULL DEFAULT false,    -- dev/E2E: meter installation-simulated sends
  storage_billing_from date,                         -- NULL: storage rows are priced at $0 (90 days' notice)
  storage_aged_through date,                         -- daily storage job cursor
  drift_cursor bigint NOT NULL DEFAULT 0,            -- last billing_ledger.id checked
  enforced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO billing_config DEFAULT VALUES;

-- One per workspace, created lazily (first settle, first credit, first Stripe action). A missing row means
-- prepaid, $0, free tier unused. No FK: money history outlives a deleted workspace.
CREATE TABLE billing_accounts (
  workspace_id text PRIMARY KEY,
  mode text NOT NULL DEFAULT 'prepaid' CHECK (mode IN ('prepaid','invoiced','exempt')),
  balance_uc bigint NOT NULL DEFAULT 0,               -- paid credit; signed (debt < 0)
  promo_uc bigint NOT NULL DEFAULT 0 CHECK (promo_uc >= 0),  -- operator grants: spent first, never refunded
  free_month date NOT NULL DEFAULT (date_trunc('month', now() AT TIME ZONE 'UTC'))::date,
  free_emails_used integer NOT NULL DEFAULT 0,        -- settled send+receive units in free_month
  month_spend_uc bigint NOT NULL DEFAULT 0,           -- settled usage cost in free_month (reporting)
  unpaid_since timestamptz,    -- set when balance_uc < 0; cleared only by a credit leaving balance_uc >= 0 (never by write_off)
  low_since timestamptz,       -- low-balance notice episode
  empty_since timestamptz,     -- "sends paused" notice episode
  low_balance_uc bigint NOT NULL DEFAULT 500000000,                -- $5
  recharge_enabled boolean NOT NULL DEFAULT false,
  recharge_threshold_uc bigint NOT NULL DEFAULT 1000000000,        -- $10
  recharge_amount_uc bigint NOT NULL DEFAULT 2500000000 CHECK (recharge_amount_uc >= 2000000000), -- $25, min $20
  recharge_month_cap_uc bigint NOT NULL DEFAULT 50000000000,       -- $500
  recharge_month date, recharge_month_total_uc bigint NOT NULL DEFAULT 0,
  recharge_pending_attempt text,
  recharge_disabled_reason text, recharge_disabled_at timestamptz,
  stripe_customer text UNIQUE,
  stripe_payment_method text, card_brand text, card_last4 text, card_exp_month smallint, card_exp_year smallint, card_fingerprint text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX billing_accounts_unpaid ON billing_accounts (unpaid_since) WHERE unpaid_since IS NOT NULL;
CREATE INDEX billing_accounts_recharge ON billing_accounts (workspace_id)
  WHERE recharge_enabled AND recharge_pending_attempt IS NULL AND recharge_disabled_at IS NULL AND mode='prepaid';

-- The durable meter. Writers upsert `quantity`; the settler moves `settled_quantity` up to it. The difference is
-- the unsettled usage the gate reads. Late writes into an old hour are simply settled by the next run.
CREATE TABLE billing_usage_hourly (
  workspace_id text NOT NULL, hour timestamptz NOT NULL,
  meter text NOT NULL CHECK (meter IN ('send','receive','omen','storage','byo_send','byo_receive')),
  rate_version smallint NOT NULL DEFAULT 1,
  quantity bigint NOT NULL DEFAULT 0, settled_quantity bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, hour, meter, rate_version));
CREATE INDEX billing_usage_open ON billing_usage_hourly (workspace_id, hour) WHERE quantity <> settled_quantity;

-- Single-entry, signed, append-only. paid_uc/promo_uc are the deltas to each bucket.
CREATE TABLE billing_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('topup','usage','grant','refund_hold','refund_release',
                                     'dispute','dispute_reversal','write_off','adjustment')),
  source_id text NOT NULL,
  paid_uc bigint NOT NULL DEFAULT 0, promo_uc bigint NOT NULL DEFAULT 0,
  balance_after_uc bigint NOT NULL, promo_after_uc bigint NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  actor text NOT NULL,                 -- 'system' | 'stripe' | 'user:<id>' | 'key:<id>' | 'operator:<id>'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, source_id));
CREATE INDEX billing_ledger_workspace ON billing_ledger (workspace_id, id DESC);
CREATE FUNCTION billing_ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'billing_ledger is append-only' USING ERRCODE='42501'; END $$;
CREATE TRIGGER billing_ledger_append_only BEFORE UPDATE OR DELETE ON billing_ledger FOR EACH ROW EXECUTE FUNCTION billing_ledger_append_only();

CREATE TABLE billing_notices (
  id text PRIMARY KEY DEFAULT 'bnt_'||replace(gen_random_uuid()::text,'-',''),
  workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('low_balance','sends_paused','receive_hold_soon','receive_held','recharge_failed')),
  dedupe_key text NOT NULL UNIQUE,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','suppressed','failed')),
  lease_until timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX billing_notices_workspace ON billing_notices (workspace_id, created_at DESC);

-- µ¢ per unit. Storage is per byte-day: $0.25/GB-month ÷ days in that UTC month; $0 before storage_billing_from.
CREATE FUNCTION billing_rate_uc(meter text, rate_version smallint, hour timestamptz) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN meter IN ('send','receive') THEN 20000
    WHEN meter='omen' THEN 10000
    WHEN meter='storage' THEN CASE WHEN c.storage_billing_from IS NULL OR hour < c.storage_billing_from THEN 0
      ELSE 25000000::numeric / (1e9 * extract(day FROM date_trunc('month', hour AT TIME ZONE 'UTC') + interval '1 month - 1 day')) END
    ELSE 0 END FROM billing_config c WHERE c.singleton
$$;
