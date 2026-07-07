CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  github_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS charts (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  media_kind TEXT NOT NULL,
  youtube_video_id TEXT,
  local_name TEXT NOT NULL DEFAULT '',
  local_size INTEGER NOT NULL DEFAULT 0,
  local_duration REAL NOT NULL DEFAULT 0,
  visibility TEXT NOT NULL,
  latest_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS chart_versions (
  chart_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  chart_payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (chart_id, version),
  FOREIGN KEY (chart_id) REFERENCES charts(id)
);

CREATE TABLE IF NOT EXISTS chart_stats (
  chart_id TEXT PRIMARY KEY,
  play_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  copied_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chart_id) REFERENCES charts(id)
);

CREATE TABLE IF NOT EXISTS chart_reports (
  id TEXT PRIMARY KEY,
  chart_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  reporter_fingerprint TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (chart_id) REFERENCES charts(id)
);

CREATE INDEX IF NOT EXISTS idx_charts_public_youtube_newest
  ON charts (visibility, media_kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chart_stats_popular
  ON chart_stats (like_count DESC, play_count DESC);
