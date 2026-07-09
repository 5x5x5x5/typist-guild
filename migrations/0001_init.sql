-- Typist guild platform schema. Mirrors DESIGN-10K.md, adapted for D1.
-- users.id is the immutable numeric GitHub id; negative ids are the
-- fictional seed users (no OAuth account, no token, can never upload).
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  banned_at INTEGER,
  token_hash TEXT
);

-- counters_json is the raw per-machine counter map from bundle format v1.
-- Kept as JSON (not columns) so the format contract survives: merge is
-- field-wise max over the UNION of keys, including counters that don't
-- exist yet. Merging happens in src/bundle.ts at ingest.
CREATE TABLE machines (
  user_id INTEGER NOT NULL REFERENCES users(id),
  machine_id TEXT NOT NULL,
  counters_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, machine_id)
);

CREATE TABLE book_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  book_id INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  total_chars_typed INTEGER,
  correct_chars INTEGER,
  last_active INTEGER,
  PRIMARY KEY (user_id, book_id)
);

-- Append-only audit log; replaces what git history provided. Also the
-- input for delta anti-cheat and, later, profile sparklines.
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  received_at INTEGER NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  total_chars INTEGER NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_submissions_user_time ON submissions (user_id, received_at DESC);
