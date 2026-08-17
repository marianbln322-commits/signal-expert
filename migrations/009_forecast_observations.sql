CREATE TABLE IF NOT EXISTS forecast_observations (
  id TEXT PRIMARY KEY,
  observation_key TEXT NOT NULL UNIQUE,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  resolves_at TEXT NOT NULL,
  entry_price REAL NOT NULL,
  predicted_direction TEXT NOT NULL,
  up_score REAL NOT NULL,
  down_score REAL NOT NULL,
  quality_score REAL NOT NULL,
  readiness_json TEXT NOT NULL,
  regime_json TEXT NOT NULL,
  features_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  outcome TEXT,
  actual_direction TEXT,
  resolution_price REAL,
  resolution_source_json TEXT,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_forecast_pending ON forecast_observations(outcome,resolves_at);
CREATE INDEX IF NOT EXISTS idx_forecast_calibration ON forecast_observations(strategy_version,symbol,horizon_minutes,predicted_direction);
