-- Date-only first_seen values are a different text format from ISO instants.
-- Rewrite them to midnight UTC so the digest window compares one format.
UPDATE bots
SET first_seen = first_seen || 'T00:00:00.000Z'
WHERE length(first_seen) = 10 AND first_seen GLOB '????-??-??';

-- One claim per subscriber per digest window, taken before the send.
-- A row that already exists means that subscriber already has this window.
CREATE TABLE IF NOT EXISTS digest_delivery (
  subscriber_id INTEGER NOT NULL,
  window_id TEXT NOT NULL,
  window_end TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, window_id)
);
