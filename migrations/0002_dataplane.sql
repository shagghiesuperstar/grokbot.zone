-- Data plane (spec 07 section 3): the live catalog, first-party counters and the job state.
CREATE TABLE bots (
  code_lc TEXT PRIMARY KEY, code TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  category TEXT, cats TEXT,
  source TEXT NOT NULL CHECK (source IN ('seed','listing','archive','submission')),
  status TEXT NOT NULL CHECK (status IN ('pending','live','dead','excluded')),
  first_seen TEXT NOT NULL, last_checked TEXT, last_live TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0, first_fail TEXT
);
CREATE INDEX idx_bots_check  ON bots(status, last_checked);
-- first_seen DESC, code_lc ASC matches the Recent order, so LIMIT reads only the rows it returns.
CREATE INDEX idx_bots_recent ON bots(status, first_seen DESC, code_lc);

CREATE TABLE bot_daily (
  day TEXT NOT NULL, code_lc TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, opens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, code_lc)
);

CREATE TABLE visit_seen (
  day TEXT NOT NULL, code_lc TEXT NOT NULL, kind TEXT NOT NULL, vh TEXT NOT NULL,
  PRIMARY KEY (day, code_lc, kind, vh)
);

CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
