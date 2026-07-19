-- Typist guild platform schema, SPEC.md schema 1. Rewritten in place
-- pre-first-deploy (the counter-format version was never applied remotely).
-- users.id is the immutable numeric GitHub id; negative ids are the
-- fictional seed users (no OAuth account, no token, can never upload —
-- and the board renders them without a github.com link).
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  banned_at INTEGER,
  token_hash TEXT
);

-- One row per session record. canonical_json is the record exactly as
-- received, canonicalized (sorted keys, no whitespace): unknown fields
-- survive (SPEC 2) and the SPEC 4 immutability conflict check is a plain
-- string compare. The extracted columns exist only for board queries.
CREATE TABLE sessions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  machine TEXT NOT NULL,
  date TEXT NOT NULL,
  book_id INTEGER,
  title TEXT,
  active_ms INTEGER NOT NULL,
  wall_ms INTEGER NOT NULL,
  chars_typed INTEGER NOT NULL,
  errors_uncorrected INTEGER NOT NULL,
  corrections INTEGER,
  legacy INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  canonical_json TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_sessions_user ON sessions (user_id);

-- Append-only audit log; replaces what git history provided.
CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  received_at INTEGER NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  new_sessions INTEGER NOT NULL,
  flagged INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_submissions_user_time ON submissions (user_id, received_at DESC);
