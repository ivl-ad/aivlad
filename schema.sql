CREATE TABLE IF NOT EXISTS players (
  pid        TEXT PRIMARY KEY,
  auth_hash  TEXT NOT NULL UNIQUE,
  name       TEXT UNIQUE,
  seed       TEXT NOT NULL DEFAULT 'lumbridge',
  save       TEXT NOT NULL DEFAULT '{}',
  ip_hash    TEXT,
  created    INTEGER,
  updated    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_auth ON players(auth_hash);

CREATE INDEX IF NOT EXISTS idx_ip ON players(ip_hash, created);
