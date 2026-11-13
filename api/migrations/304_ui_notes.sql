SET LOCAL lock_timeout='2s';
-- UI notes: Bane staff (the platform operator role) leave design and bug notes on the dashboard itself, and an agent
-- picks them up and fixes them (src/ui-notes.ts, scripts/ui-notes.ts). They are about the app, not a customer, so they
-- belong to the deployment: no workspace. The screenshot is a private object in the attachments bucket under
-- ui-notes/<note id>, served only through a short-lived signed link.
CREATE TABLE ui_notes (
  id text PRIMARY KEY CHECK (id ~ '^uin_[0-9a-f]{32}$'),
  author_id text REFERENCES bane_users(id) ON DELETE SET NULL,
  updated_by text REFERENCES bane_users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  kind text NOT NULL CHECK (kind IN ('alignment','spacing','copy','bug','motion','mobile','other')),
  severity text CHECK (severity IN ('low','medium','high')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','fixed','wontfix')),
  pr_url text CHECK (length(pr_url) <= 500 AND pr_url ~ '^https://'),
  resolution text CHECK (length(resolution) <= 2000),
  -- Where it was left: the full URL, its path and query, and the route pattern (IDs replaced), which pins match on.
  url text NOT NULL CHECK (length(url) <= 2000),
  path text NOT NULL CHECK (length(path) <= 2000),
  route text NOT NULL CHECK (length(route) <= 300),
  -- Viewport, theme, device and build; and the element: locator, text, box and computed styles. Bounded by the API.
  context jsonb NOT NULL CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 8192),
  element jsonb NOT NULL CHECK (jsonb_typeof(element) = 'object' AND octet_length(element::text) <= 32768),
  screenshot_key text CHECK (screenshot_key ~ '^ui-notes/uin_[0-9a-f]{32}$'),
  screenshot jsonb CHECK (screenshot IS NULL OR jsonb_typeof(screenshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX ui_notes_status ON ui_notes (status, created_at DESC, id DESC);
CREATE INDEX ui_notes_route ON ui_notes (route, created_at DESC);

-- A key lets a script (an agent fixing notes) read notes and set their status, as the operator who made it. It works
-- only on the UI notes routes, only while that person still holds the operator role, and expires within 90 days.
CREATE TABLE ui_note_keys (
  id text PRIMARY KEY CHECK (id ~ '^unk_[0-9a-f]{32}$'),
  user_id text NOT NULL REFERENCES bane_users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  hash text NOT NULL UNIQUE,
  prefix text NOT NULL CHECK (length(prefix) <= 20),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at <= created_at + interval '91 days'),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ui_note_keys_user ON ui_note_keys (user_id, created_at DESC);
