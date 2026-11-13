SET LOCAL lock_timeout='2s';
-- Stripe is only the payment rail for the prepaid balance (240). Bane writes an attempt before it calls Stripe,
-- commits, calls Stripe with an idempotency key derived from the attempt, then records the answer with a guarded
-- UPDATE ... WHERE status IN (...). Credit reaches billing_ledger only through billing_post(..., 'topup',
-- 'attempt:<id>', ...), so a webhook, an inline charge and reconciliation can all try to credit the same payment.
CREATE TABLE billing_payment_attempts (
  id text PRIMARY KEY,                                  -- 'bpa_' + 32 hex
  workspace_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checkout','saved_card','recharge','setup')),
  -- created -> pending (the Stripe object is stored) | failed (a 4xx at create)
  -- pending | requires_action -> succeeded | failed | canceled | expired. Terminal states absorb late events.
  status text NOT NULL CHECK (status IN ('created','pending','requires_action','succeeded','failed','canceled','expired')),
  amount_uc bigint NOT NULL CHECK (amount_uc >= 0),    -- credit (excludes tax); 0 for 'setup'
  charged_cents integer, tax_cents integer,
  idempotency_key text NOT NULL UNIQUE,                 -- 'attempt:<id>'; sub-calls append ':<step>'
  stripe_checkout_session text UNIQUE, stripe_payment_intent text UNIQUE, stripe_invoice text UNIQUE, stripe_charge text,
  checkout_url text, expires_at timestamptz,            -- Checkout only: the page a person opens, until Stripe expires it
  invoice_url text, invoice_pdf text, receipt_url text,
  card_brand text, card_last4 text, card_fingerprint text,
  failure_code text, failure_message text,
  refunded_uc bigint NOT NULL DEFAULT 0 CHECK (refunded_uc >= 0 AND refunded_uc <= amount_uc),
  created_by text NOT NULL,                             -- 'user:<id>' | 'key:<id>' | 'system'
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz);
-- Reconciliation reads open attempts oldest first; the per-workspace index serves the payments list and rate limits.
CREATE INDEX billing_attempts_open ON billing_payment_attempts (updated_at) WHERE status IN ('created','pending','requires_action');
CREATE INDEX billing_attempts_workspace ON billing_payment_attempts (workspace_id, created_at DESC);

-- Every Stripe webhook delivery, deduplicated on the event ID. A processed or ignored event is never reopened.
CREATE TABLE billing_gateway_events (
  stripe_event_id text PRIMARY KEY, type text NOT NULL, livemode boolean NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','ignored','failed')),
  attempts integer NOT NULL DEFAULT 0, failure text,
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz);
CREATE INDEX billing_gateway_events_done ON billing_gateway_events (received_at) WHERE status IN ('processed','ignored');

-- Operator refunds of paid credit. The amount is held in the ledger (refund_hold) before Stripe is called and
-- released (refund_release) if Stripe refuses or the refund later fails.
CREATE TABLE billing_refunds (
  id text PRIMARY KEY,                                  -- 'brf_' + 32 hex
  workspace_id text NOT NULL, attempt_id text NOT NULL REFERENCES billing_payment_attempts(id),
  amount_uc bigint NOT NULL CHECK (amount_uc > 0),
  status text NOT NULL CHECK (status IN ('held','pending','succeeded','failed')),
  stripe_refund text UNIQUE, stripe_credit_note text UNIQUE,
  reason text NOT NULL, operator text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz);
CREATE INDEX billing_refunds_attempt ON billing_refunds (attempt_id);
CREATE INDEX billing_refunds_open ON billing_refunds (created_at) WHERE status IN ('held','pending');

-- Cards seen in a dispute or an early fraud warning. Bane never saves one again for auto-recharge.
CREATE TABLE billing_blocked_cards (fingerprint text PRIMARY KEY, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
