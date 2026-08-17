CREATE TABLE IF NOT EXISTS feed_channel_state (
  provider TEXT NOT NULL,
  symbol TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  connected_at TEXT,
  last_message_at TEXT,
  last_event_at TEXT,
  last_sequence INTEGER,
  lag_ms REAL,
  gap_count INTEGER NOT NULL DEFAULT 0,
  reconnect_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider,symbol,channel)
);

CREATE TABLE IF NOT EXISTS feed_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  symbol TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_alerts (
  fingerprint TEXT PRIMARY KEY,
  alert_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  symbol TEXT NOT NULL,
  channel TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_feed_events_recent ON feed_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON operational_alerts(status,last_seen_at DESC);
