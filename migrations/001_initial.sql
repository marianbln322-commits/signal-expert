CREATE TABLE IF NOT EXISTS signal_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL CHECK(symbol IN ('BTCUSDT','ETHUSDT')),
  direction TEXT NOT NULL CHECK(direction IN ('UP','DOWN','WAIT')),
  up_score INTEGER NOT NULL,
  down_score INTEGER NOT NULL,
  model_version TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS signal_symbol_time_idx ON signal_snapshots(symbol, calculated_at DESC);
CREATE TABLE IF NOT EXISTS paper_positions (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL CHECK(symbol IN ('BTCUSDT','ETHUSDT')),
  direction TEXT NOT NULL CHECK(direction IN ('UP','DOWN')),
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes IN (10,30)),
  stake REAL NOT NULL CHECK(stake > 0),
  payout_rate REAL NOT NULL CHECK(payout_rate > 0),
  entry_price REAL NOT NULL,
  opened_at TEXT NOT NULL,
  resolves_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','WON','LOST','REFUNDED')),
  settlement_price REAL,
  settled_at TEXT,
  pnl REAL,
  signal_version TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS paper_status_resolution_idx ON paper_positions(status, resolves_at);
