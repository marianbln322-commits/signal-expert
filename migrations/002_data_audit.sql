CREATE TABLE IF NOT EXISTS data_source_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name TEXT NOT NULL,
  symbol TEXT,
  status TEXT NOT NULL CHECK(status IN ('LIVE','STALE','UNAVAILABLE','RATE_LIMITED','ERROR')),
  source_timestamp TEXT,
  received_at TEXT NOT NULL,
  latency_ms INTEGER,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS source_events_time_idx ON data_source_events(received_at DESC);
