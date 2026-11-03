-- Retry bookkeeping so one undeliverable subscriber cannot pin a window (C2).
-- status is pending, retry, sent, or failed. attempts counts non-quota send failures.
-- A failed row after 3 attempts is terminal: the window can complete, and that address is not retried forever.
ALTER TABLE digest_delivery ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE digest_delivery ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';

-- One open window. Concurrent fires INSERT OR IGNORE and reuse the winner's key (L1).
-- id is constrained to 1, so the row is the unique window lock.
CREATE TABLE IF NOT EXISTS digest_open (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  window_id TEXT NOT NULL,
  since_iso TEXT NOT NULL,
  window_end TEXT NOT NULL,
  opened_at TEXT NOT NULL
);

-- The claim lookup and the 30-day prune filter on these columns (M2).
CREATE INDEX IF NOT EXISTS idx_digest_delivery_window_id ON digest_delivery(window_id);
CREATE INDEX IF NOT EXISTS idx_digest_delivery_window_end ON digest_delivery(window_end);
