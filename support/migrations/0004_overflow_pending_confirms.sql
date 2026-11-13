-- Review R1: mail over a cap is kept (bounded) for the team's daily digest, never dropped silently.
CREATE TABLE overflow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  channel TEXT NOT NULL,          -- support, abuse, privacy, legal
  reason TEXT NOT NULL,           -- the cap that was hit
  sender TEXT,
  dmarc TEXT,
  subject TEXT,
  text TEXT,                      -- first 4,000 characters (untrusted)
  message_id TEXT NOT NULL,
  thread_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX overflow_day ON overflow (day, channel);

-- Review R2: an address's open "Confirm it's me" link; later mail from the address waits in that conversation.
CREATE TABLE pending_confirms (
  address_hash TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
