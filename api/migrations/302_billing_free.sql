SET LOCAL lock_timeout='2s';
-- Free (not billed) workspaces and people. billing_accounts.mode stays the one column the gate, settlement, notices and
-- auto-recharge read: 'exempt' means free. It is derived here from two flags, both set only by operators (audited):
--   - the workspace flag (free_at, with an optional reason and expiry), the exemption set-billing-mode has always set;
--   - a person's flag (billing_free_people), bound to their sign-in identity (issuer + subject from bane_oidc_identities,
--     never an email): every workspace they own is free while they own it.
-- paid_mode is what the workspace is when neither applies. A free workspace is never gated or charged; its usage is
-- still metered and settled at $0 with the would-be cost recorded, so the cost of free accounts stays visible.
ALTER TABLE billing_accounts
  ADD COLUMN paid_mode text NOT NULL DEFAULT 'prepaid' CHECK (paid_mode IN ('prepaid','invoiced')),
  ADD COLUMN free_at timestamptz,          -- the workspace flag: set when not null
  ADD COLUMN free_until timestamptz,       -- optional expiry of the workspace flag
  ADD COLUMN free_reason text,
  ADD COLUMN free_by text,                 -- 'operator:<userId>' | 'script'
  ADD COLUMN free_via text CHECK (free_via IN ('workspace','account'));  -- why mode is 'exempt' now
-- Exemptions set before this migration become workspace flags with no expiry.
UPDATE billing_accounts SET paid_mode = CASE WHEN mode='invoiced' THEN 'invoiced' ELSE 'prepaid' END,
  free_at = CASE WHEN mode='exempt' THEN updated_at END, free_via = CASE WHEN mode='exempt' THEN 'workspace' END,
  free_by = CASE WHEN mode='exempt' THEN 'script' END;
CREATE INDEX billing_accounts_free ON billing_accounts (workspace_id) WHERE mode='exempt';

CREATE TABLE billing_free_people (
  issuer text COLLATE "C" NOT NULL, subject text COLLATE "C" NOT NULL,
  user_id text NOT NULL,                   -- who it was granted to, for display; the binding is (issuer, subject)
  reason text NOT NULL, until timestamptz, granted_by text NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, subject));
CREATE INDEX billing_free_people_user ON billing_free_people (user_id);

-- A user's sign-in identities (bane_oidc_identities, #89): issuer + subject, https://account.anoma.ly in production.
-- The one link between billing and identity storage.
CREATE FUNCTION billing_user_identities(uid text) RETURNS TABLE(issuer text, subject text) LANGUAGE sql STABLE AS $$
  SELECT issuer::text, subject::text FROM bane_oidc_identities WHERE user_id=uid
$$;

-- Whether a workspace is free now, why, and until when (null: no end). Both flags may apply; the later end wins.
CREATE FUNCTION billing_free_state(wid text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH own AS (SELECT (SELECT coalesce(free_until,'infinity'::timestamptz) FROM billing_accounts
      WHERE workspace_id=wid AND free_at IS NOT NULL AND (free_until IS NULL OR free_until>now())) AS till),
    owner AS (SELECT max(coalesce(p.until,'infinity'::timestamptz)) AS till FROM workspace_members m
      CROSS JOIN LATERAL billing_user_identities(m.user_id) i JOIN billing_free_people p ON p.issuer=i.issuer AND p.subject=i.subject
      WHERE m.workspace_id=wid AND m.role='owner' AND (p.until IS NULL OR p.until>now()))
  SELECT jsonb_build_object('free', own.till IS NOT NULL OR owner.till IS NOT NULL,
    'via', CASE WHEN own.till IS NOT NULL THEN 'workspace' WHEN owner.till IS NOT NULL THEN 'account' END,
    'until', nullif(greatest(own.till, owner.till), 'infinity'::timestamptz))
  FROM own, owner
$$;

-- Applies billing_free_state to billing_accounts.mode. Locks the account row first (the money lock order starts there),
-- then reads the state, so a concurrent flag change is seen once its transaction commits.
CREATE FUNCTION billing_free_sync(wid text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; target text; m text;
BEGIN
  IF (billing_free_state(wid)->>'free')::boolean THEN INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING; END IF;
  PERFORM 1 FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('free', false, 'via', null, 'until', null, 'mode', 'prepaid'); END IF;
  s := billing_free_state(wid);
  UPDATE billing_accounts SET mode=CASE WHEN (s->>'free')::boolean THEN 'exempt' ELSE paid_mode END, free_via=s->>'via', updated_at=now()
    WHERE workspace_id=wid AND (mode, free_via) IS DISTINCT FROM (CASE WHEN (s->>'free')::boolean THEN 'exempt' ELSE paid_mode END, s->>'via');
  SELECT mode INTO m FROM billing_accounts WHERE workspace_id=wid;
  RETURN s || jsonb_build_object('mode', m);
END $$;

-- The workspace flag: on (with an optional reason and expiry) or off, then the sync.
CREATE FUNCTION billing_set_workspace_free(wid text, turn_on boolean, why text, till timestamptz, who text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  UPDATE billing_accounts SET free_at=CASE WHEN turn_on THEN now() END, free_until=CASE WHEN turn_on THEN till END,
    free_reason=CASE WHEN turn_on THEN why END, free_by=CASE WHEN turn_on THEN who END, updated_at=now() WHERE workspace_id=wid;
  RETURN billing_free_sync(wid);
END $$;

-- What a workspace pays as: prepaid or invoiced (clearing its free flag), or exempt (its free flag, no end). Returns
-- the previous mode with the new state, or NULL when the workspace doesn't exist. Scripts and the operator API share it.
CREATE FUNCTION billing_set_mode(wid text, m text, why text, who text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE old text;
BEGIN
  IF m NOT IN ('prepaid','invoiced','exempt') THEN RAISE EXCEPTION 'unknown billing mode %', m USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT FROM workspaces WHERE id=wid) THEN RETURN NULL; END IF;
  SELECT mode INTO old FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  IF m<>'exempt' THEN
    INSERT INTO billing_accounts(workspace_id,paid_mode) VALUES (wid,m) ON CONFLICT (workspace_id) DO UPDATE SET paid_mode=excluded.paid_mode,updated_at=now();
  END IF;
  RETURN jsonb_build_object('old', coalesce(old,'prepaid')) || billing_set_workspace_free(wid, m='exempt', why, NULL, who);
END $$;

-- A person's flag, bound to every sign-in identity they have now, then the sync of every workspace they own (in ID
-- order, so two of these never wait on each other's account rows). Returns those workspaces and their state.
CREATE FUNCTION billing_set_person_free(uid text, turn_on boolean, why text, till timestamptz, who text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE w text; out jsonb := '[]';
BEGIN
  IF turn_on THEN
    INSERT INTO billing_free_people(issuer,subject,user_id,reason,until,granted_by) SELECT i.issuer,i.subject,uid,why,till,who FROM billing_user_identities(uid) i
      ON CONFLICT (issuer,subject) DO UPDATE SET user_id=excluded.user_id,reason=excluded.reason,until=excluded.until,granted_by=excluded.granted_by,granted_at=now();
  ELSE
    DELETE FROM billing_free_people p WHERE p.user_id=uid OR (p.issuer,p.subject) IN (SELECT i.issuer,i.subject FROM billing_user_identities(uid) i);
  END IF;
  FOR w IN SELECT workspace_id FROM workspace_members WHERE user_id=uid AND role='owner' ORDER BY workspace_id LOOP
    out := out || jsonb_build_array(jsonb_build_object('workspaceId', w) || billing_free_sync(w));
  END LOOP;
  RETURN out;
END $$;

-- Ownership changes re-evaluate the workspaces they touch (a free person becoming or ceasing to be an owner). Cheap
-- when nobody is flagged: one empty-table probe per membership statement.
CREATE FUNCTION billing_free_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM billing_free_people) THEN RETURN NULL; END IF;
  IF TG_OP='INSERT' THEN
    PERFORM billing_free_sync(w) FROM (SELECT DISTINCT workspace_id AS w FROM new_rows WHERE role='owner' ORDER BY 1) x;
  ELSIF TG_OP='DELETE' THEN
    PERFORM billing_free_sync(w) FROM (SELECT DISTINCT workspace_id AS w FROM old_rows WHERE role='owner' ORDER BY 1) x;
  ELSE
    PERFORM billing_free_sync(w) FROM (SELECT DISTINCT workspace_id AS w FROM (SELECT workspace_id, role FROM new_rows UNION ALL SELECT workspace_id, role FROM old_rows) c
      WHERE role='owner' ORDER BY 1) x;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER billing_free_members_insert AFTER INSERT ON workspace_members REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION billing_free_members();
CREATE TRIGGER billing_free_members_update AFTER UPDATE ON workspace_members REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION billing_free_members();
CREATE TRIGGER billing_free_members_delete AFTER DELETE ON workspace_members REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION billing_free_members();

-- Hourly (billingHourly): flags that expired, and every workspace a flagged person owns, are synced again, so an expiry
-- takes effect within the hour and a missed re-evaluation heals itself.
CREATE FUNCTION billing_free_sweep() RETURNS int LANGUAGE plpgsql AS $$
DECLARE w text; n int := 0;
BEGIN
  FOR w IN SELECT workspace_id FROM billing_accounts WHERE mode='exempt' AND (free_via='account' OR free_until<=now())
      UNION SELECT m.workspace_id FROM billing_free_people p JOIN workspace_members m ON m.user_id=p.user_id AND m.role='owner'
      ORDER BY 1 LOOP
    PERFORM billing_free_sync(w); n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- Money movements reach the audit trail (#137, audit_events) in the statement that posts them, with billing's 7-year
-- retention and visible in the customer's Activity: top-ups, refunds, disputes, write-offs, expiries and the like from
-- Stripe, jobs or a person. Hourly usage rows are not events. Operator changes are recorded by their routes instead
-- (billing.* with the reason), so they are not written twice.
CREATE FUNCTION billing_ledger_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_events(workspace_id, user_id, actor_type, actor_id, via, action, target_type, target_id, summary, internal, retain_until)
  VALUES (NEW.workspace_id, CASE WHEN NEW.actor LIKE 'user:%' THEN substr(NEW.actor, 6) END,
    CASE WHEN NEW.actor='stripe' THEN 'stripe' WHEN NEW.actor LIKE 'user:%' THEN 'member' WHEN NEW.actor LIKE 'key:%' THEN 'api_key' ELSE 'system' END,
    nullif(substr(NEW.actor, strpos(NEW.actor, ':') + 1), NEW.actor),
    CASE WHEN NEW.actor='stripe' THEN 'webhook' WHEN NEW.actor LIKE 'user:%' THEN 'dashboard' WHEN NEW.actor LIKE 'key:%' THEN 'api' ELSE 'job' END,
    'billing.' || NEW.kind, 'billing_ledger', NEW.id::text,
    jsonb_build_object('amountUc', (NEW.paid_uc + NEW.promo_uc)::text, 'paidUc', NEW.paid_uc::text, 'promoUc', NEW.promo_uc::text,
      'balanceAfterUc', (NEW.balance_after_uc + NEW.promo_after_uc)::text, 'source', left(NEW.source_id, 120)),
    false, now() + interval '7 years');
  RETURN NULL;
END $$;
CREATE TRIGGER billing_ledger_audit AFTER INSERT ON billing_ledger FOR EACH ROW
  WHEN (NEW.kind <> 'usage' AND NEW.actor NOT LIKE 'operator:%') EXECUTE FUNCTION billing_ledger_audit();
