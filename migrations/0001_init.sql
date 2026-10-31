CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  source TEXT NOT NULL CHECK (source IN ('webform','email')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  name TEXT NOT NULL,
  author TEXT,
  description TEXT NOT NULL,
  code TEXT NOT NULL,
  link TEXT NOT NULL UNIQUE,
  category TEXT,
  submitter_email TEXT,
  ip TEXT,
  raw_excerpt TEXT
);
CREATE INDEX idx_submissions_status ON submissions(status, created_at);
CREATE INDEX idx_submissions_code   ON submissions(code);

CREATE TABLE subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','unsubscribed','bounced')),
  confirm_token TEXT NOT NULL UNIQUE,
  unsub_token   TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  confirmed_at TEXT,
  unsubscribed_at TEXT
);

CREATE TABLE send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  kind TEXT NOT NULL CHECK (kind IN ('ack','owner_summary','confirm','digest','unsubscribe')),
  recipient TEXT NOT NULL,
  message_id TEXT,
  ok INTEGER NOT NULL CHECK (ok IN (0,1)),
  error_code TEXT
);
CREATE INDEX idx_send_log_kind ON send_log(kind, sent_at);
