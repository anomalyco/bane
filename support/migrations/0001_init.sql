-- The support Worker's index: conversations, tickets and the single-use records. Live conversation content lives in each
-- conversation's Durable Object; nothing here holds a grant token, and no message text except a ticket's quoted ask.

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('chat', 'email')),
  user_id TEXT,
  email TEXT,                      -- the verified address (email) or the handoff's account address (chat)
  workspace_id TEXT,
  workspace_name TEXT,
  thread_id TEXT UNIQUE,           -- Bane's support-inbox thread: the email conversation, or a chat ticket's follow-up
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ticketed', 'closed')),
  ticket_id TEXT,
  turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX conversations_user_created ON conversations (user_id, created_at);
CREATE INDEX conversations_email_created ON conversations (email, created_at);

-- A handoff opens one conversation (Bane also refuses a second grant from it).
CREATE TABLE handoffs_used (
  jti TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

-- Bane's webhook-id, so a redelivered inbound email is processed once.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

-- "Confirm it's me" links: single use.
CREATE TABLE confirmations (
  nonce TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,  -- one ticket per conversation; later facts are appended
  channel TEXT NOT NULL CHECK (channel IN ('chat', 'email')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_customer', 'resolved', 'closed')),
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('P1', 'P2', 'P3')),
  due_at INTEGER,
  customer TEXT NOT NULL,                -- JSON: user id, email, name, role, workspaces in scope
  summary TEXT NOT NULL,
  ask TEXT NOT NULL,                     -- the customer's request, quoted (untrusted)
  tried TEXT NOT NULL,                   -- JSON [{ tool, finding }]
  recommendation TEXT NOT NULL,
  evidence TEXT NOT NULL,                -- JSON: request, email, campaign, domain and grant IDs
  notes TEXT NOT NULL DEFAULT '[]',      -- JSON: facts appended after filing
  followup_thread_id TEXT,
  notified_at INTEGER,
  cost_usd REAL,
  model TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tickets_status_due ON tickets (status, due_at);
