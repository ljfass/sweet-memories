CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL
);

CREATE INDEX sessions_admin_id_idx ON sessions(admin_id);

CREATE TABLE login_attempts (
  ip TEXT PRIMARY KEY,
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
  blocked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO settings(key, value, updated_at)
VALUES ('uploads_enabled', 'false', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE photos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 500),
  captured_date TEXT CHECK (
    captured_date IS NULL OR
    captured_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  status TEXT NOT NULL CHECK (status IN ('migration_pending', 'published')),
  rotation INTEGER NOT NULL CHECK (rotation BETWEEN -6 AND 6),
  offset_x INTEGER NOT NULL CHECK (offset_x BETWEEN -16 AND 16),
  offset_y INTEGER NOT NULL CHECK (offset_y BETWEEN -16 AND 16),
  request_id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX photos_public_order_idx
ON photos(status, captured_date, created_at, id);

CREATE TABLE photo_assets (
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('master', 'responsive')),
  format TEXT NOT NULL CHECK (format IN ('avif', 'webp', 'jpeg')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  relative_path TEXT NOT NULL UNIQUE,
  PRIMARY KEY (photo_id, kind, format, width)
);
