-- OAuth 2.1 for the MCP write tools: public clients (DCR), email magic-link login, PKCE auth codes, bearer tokens.
-- No plaintext secret is ever stored: magic_hash, code_hash and token_hash are SHA-256 hex digests.

CREATE TABLE IF NOT EXISTS oauth_client (
  client_id     TEXT PRIMARY KEY,
  redirect_uris TEXT NOT NULL,          -- JSON array of exact-match URIs
  client_name   TEXT,
  created_at    INTEGER NOT NULL,       -- epoch ms
  ip_hash       TEXT
);

-- One row per login attempt: first holds the magic-link hash, then (after the link is used) the auth-code hash.
CREATE TABLE IF NOT EXISTS oauth_pending (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state          TEXT,
  scope          TEXT NOT NULL,
  email          TEXT,
  magic_hash     TEXT,                  -- NULL once the magic link has been used
  code_hash      TEXT,                  -- set when the magic link is used
  expires_at     INTEGER NOT NULL,      -- epoch ms; 15 min for the magic link, then 60 s for the code
  consumed_at    INTEGER                -- set when the code is exchanged
);
CREATE INDEX IF NOT EXISTS oauth_pending_magic ON oauth_pending(magic_hash);
CREATE INDEX IF NOT EXISTS oauth_pending_code ON oauth_pending(code_hash);

CREATE TABLE IF NOT EXISTS oauth_token (
  token_hash TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  scope      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,          -- epoch ms
  revoked_at INTEGER
);

-- Fixed-window counters: DCR per IP, magic-link sends per IP and address, writes per token.
CREATE TABLE IF NOT EXISTS oauth_rl (
  k            TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  window_start INTEGER NOT NULL         -- epoch ms
);
