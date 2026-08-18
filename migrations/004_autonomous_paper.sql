CREATE TABLE autonomous_decisions (
  id TEXT PRIMARY KEY,
  decision_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL CHECK(symbol IN ('BTCUSDT','ETHUSDT')),
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes IN (10,30)),
  direction TEXT NOT NULL CHECK(direction IN ('UP','DOWN','WAIT')),
  quality_score INTEGER NOT NULL CHECK(quality_score BETWEEN 0 AND 100),
  quality_band TEXT NOT NULL CHECK(quality_band IN ('BELOW_STANDARD','STANDARD','HIGH','EXCEPTIONAL')),
  timeframe_watermarks_json TEXT NOT NULL,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  profile TEXT NOT NULL CHECK(profile IN ('FLAT','ADAPTIVE_CAPPED','OBSERVED_10_30_90_270')),
  stage INTEGER NOT NULL CHECK(stage >= 0),
  action TEXT NOT NULL CHECK(action IN ('WAIT','BLOCKED','OPEN')),
  stake REAL,
  reasons_json TEXT NOT NULL,
  paper_position_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX autonomous_decisions_time_idx ON autonomous_decisions(created_at DESC);
CREATE INDEX autonomous_decisions_action_idx ON autonomous_decisions(action, created_at DESC);

CREATE TABLE autonomous_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  status TEXT NOT NULL CHECK(status IN ('RUNNING','PAUSED')),
  profile TEXT NOT NULL CHECK(profile IN ('FLAT','ADAPTIVE_CAPPED','OBSERVED_10_30_90_270')),
  recovery_stage INTEGER NOT NULL DEFAULT 0 CHECK(recovery_stage >= 0),
  previous_loss REAL NOT NULL DEFAULT 0 CHECK(previous_loss >= 0),
  pause_reason TEXT,
  current_position_id TEXT,
  last_settled_position_id TEXT,
  updated_at TEXT NOT NULL
);

ALTER TABLE paper_positions ADD COLUMN origin TEXT NOT NULL DEFAULT 'MANUAL' CHECK(origin IN ('MANUAL','AUTONOMOUS'));
ALTER TABLE paper_positions ADD COLUMN decision_id TEXT REFERENCES autonomous_decisions(id);
ALTER TABLE paper_positions ADD COLUMN strategy_name TEXT;
ALTER TABLE paper_positions ADD COLUMN strategy_version TEXT;
ALTER TABLE paper_positions ADD COLUMN quality_score INTEGER CHECK(quality_score IS NULL OR quality_score BETWEEN 0 AND 100);
ALTER TABLE paper_positions ADD COLUMN stake_profile TEXT CHECK(stake_profile IS NULL OR stake_profile IN ('FLAT','ADAPTIVE_CAPPED','OBSERVED_10_30_90_270'));
ALTER TABLE paper_positions ADD COLUMN recovery_stage INTEGER CHECK(recovery_stage IS NULL OR recovery_stage >= 0);

CREATE UNIQUE INDEX one_open_autonomous_position_idx
  ON paper_positions(origin)
  WHERE origin = 'AUTONOMOUS' AND status = 'OPEN';
CREATE INDEX paper_positions_origin_time_idx ON paper_positions(origin, opened_at DESC);
