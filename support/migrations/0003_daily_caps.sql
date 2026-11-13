-- Daily caps (review M5): model turns, tickets and inbound mail, per person or sender and globally.
CREATE TABLE daily_counters (
  day TEXT NOT NULL,      -- UTC date, YYYY-MM-DD
  key TEXT NOT NULL,      -- global:turns, user:<id>:tickets, sender:<hash>:mail, alert:turns…
  n INTEGER NOT NULL,
  PRIMARY KEY (day, key)
);
