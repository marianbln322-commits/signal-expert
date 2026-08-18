CREATE TABLE IF NOT EXISTS calibration_models (
  id TEXT PRIMARY KEY,
  model_key TEXT NOT NULL UNIQUE,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  forecast_model_name TEXT NOT NULL,
  forecast_model_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes > 0),
  direction TEXT NOT NULL CHECK(direction IN ('UP','DOWN','NEUTRAL')),
  volatility_segment TEXT NOT NULL,
  regime_segment TEXT NOT NULL,
  calibration_method TEXT NOT NULL CHECK(calibration_method IN ('ISOTONIC','PLATT')),
  status TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1)),
  sample_size INTEGER NOT NULL CHECK(sample_size >= 0),
  model_json TEXT NOT NULL,
  trained_from TEXT,
  trained_through TEXT,
  trained_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(trained_from IS NULL OR trained_through IS NULL OR trained_from <= trained_through)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calibration_models_active
  ON calibration_models(strategy_name,strategy_version,forecast_model_name,forecast_model_version,symbol,horizon_minutes,direction,volatility_segment,regime_segment,calibration_method)
  WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_calibration_models_scope
  ON calibration_models(symbol,horizon_minutes,direction,volatility_segment,regime_segment,calibration_method,status,trained_at DESC);

CREATE TABLE IF NOT EXISTS calibration_metric_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_key TEXT NOT NULL UNIQUE,
  calibration_model_id TEXT REFERENCES calibration_models(id),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  forecast_model_name TEXT NOT NULL,
  forecast_model_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes > 0),
  direction TEXT NOT NULL CHECK(direction IN ('UP','DOWN','NEUTRAL')),
  volatility_segment TEXT NOT NULL,
  regime_segment TEXT NOT NULL,
  calibration_method TEXT NOT NULL CHECK(calibration_method IN ('RAW','ISOTONIC','PLATT')),
  sample_size INTEGER NOT NULL CHECK(sample_size >= 0),
  min_sample_size INTEGER NOT NULL CHECK(min_sample_size >= 0),
  brier_score REAL CHECK(brier_score IS NULL OR brier_score >= 0),
  log_loss REAL CHECK(log_loss IS NULL OR log_loss >= 0),
  expected_calibration_error REAL CHECK(expected_calibration_error IS NULL OR expected_calibration_error BETWEEN 0 AND 1),
  metrics_json TEXT NOT NULL,
  reliability_json TEXT NOT NULL,
  observed_from TEXT,
  observed_through TEXT,
  measured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(observed_from IS NULL OR observed_through IS NULL OR observed_from <= observed_through),
  CHECK((calibration_method = 'RAW' AND calibration_model_id IS NULL) OR (calibration_method != 'RAW' AND calibration_model_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_calibration_snapshots_scope
  ON calibration_metric_snapshots(symbol,horizon_minutes,direction,volatility_segment,regime_segment,calibration_method,measured_at DESC);
CREATE INDEX IF NOT EXISTS idx_calibration_snapshots_model
  ON calibration_metric_snapshots(calibration_model_id,measured_at DESC);

ALTER TABLE forecast_observations ADD COLUMN forecast_model_name TEXT NOT NULL DEFAULT 'LEGACY_V0_8';
ALTER TABLE forecast_observations ADD COLUMN forecast_model_version TEXT NOT NULL DEFAULT 'LEGACY_V0_8';
ALTER TABLE forecast_observations ADD COLUMN volatility_segment TEXT NOT NULL DEFAULT 'LEGACY_V0_8';
ALTER TABLE forecast_observations ADD COLUMN regime_segment TEXT NOT NULL DEFAULT 'LEGACY_V0_8';
ALTER TABLE forecast_observations ADD COLUMN calibration_method TEXT NOT NULL DEFAULT 'RAW' CHECK(calibration_method IN ('RAW','ISOTONIC','PLATT'));
ALTER TABLE forecast_observations ADD COLUMN calibration_model_id TEXT REFERENCES calibration_models(id);
ALTER TABLE forecast_observations ADD COLUMN raw_probability_up REAL CHECK(raw_probability_up IS NULL OR raw_probability_up BETWEEN 0 AND 1);
ALTER TABLE forecast_observations ADD COLUMN calibrated_probability_up REAL CHECK(calibrated_probability_up IS NULL OR calibrated_probability_up BETWEEN 0 AND 1);
ALTER TABLE forecast_observations ADD COLUMN resolution_policy TEXT NOT NULL DEFAULT 'LEGACY_V0_8_CALLER_RESOLUTION' CHECK(resolution_policy IN ('LEGACY_V0_8_CALLER_RESOLUTION','FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON'));
ALTER TABLE forecast_observations ADD COLUMN resolution_candle_open_at TEXT;
ALTER TABLE forecast_observations ADD COLUMN resolution_candle_close_at TEXT;
ALTER TABLE forecast_observations ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

CREATE INDEX IF NOT EXISTS idx_forecast_deep_segment
  ON forecast_observations(symbol,horizon_minutes,predicted_direction,volatility_segment,regime_segment,calibration_method,outcome,generated_at);
CREATE INDEX IF NOT EXISTS idx_forecast_model_identity
  ON forecast_observations(forecast_model_name,forecast_model_version,calibration_model_id,generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_forecast_resolution_candle
  ON forecast_observations(outcome,resolves_at,resolution_candle_close_at);

CREATE TABLE IF NOT EXISTS forecast_observation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  observation_id TEXT NOT NULL REFERENCES forecast_observations(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_forecast_observation_events
  ON forecast_observation_events(observation_id,occurred_at,id);

CREATE TABLE IF NOT EXISTS structure_episodes (
  id TEXT PRIMARY KEY,
  episode_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes > 0),
  machine_type TEXT NOT NULL,
  machine_key TEXT NOT NULL,
  structure_type TEXT NOT NULL,
  direction TEXT CHECK(direction IS NULL OR direction IN ('UP','DOWN','NEUTRAL')),
  state TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','CLOSED')),
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  context_json TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((status = 'OPEN' AND closed_at IS NULL) OR (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_at >= opened_at))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_structure_one_open_scope
  ON structure_episodes(symbol,horizon_minutes,machine_type,machine_key)
  WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS idx_structure_episodes_recent
  ON structure_episodes(symbol,horizon_minutes,status,opened_at DESC);

CREATE TABLE IF NOT EXISTS structure_episode_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  episode_id TEXT NOT NULL REFERENCES structure_episodes(id),
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_structure_episode_events
  ON structure_episode_events(episode_id,observed_at,id);

CREATE TABLE IF NOT EXISTS order_flow_buckets (
  id TEXT PRIMARY KEY,
  bucket_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL,
  window_ms INTEGER NOT NULL CHECK(window_ms IN (10000,30000,60000,300000)),
  bucket_start TEXT NOT NULL,
  bucket_end TEXT NOT NULL,
  status TEXT NOT NULL,
  synchronized INTEGER NOT NULL CHECK(synchronized IN (0,1)),
  finalized INTEGER NOT NULL DEFAULT 0 CHECK(finalized IN (0,1)),
  buy_notional REAL,
  sell_notional REAL,
  delta_notional REAL,
  trade_count INTEGER CHECK(trade_count IS NULL OR trade_count >= 0),
  cvd_notional REAL,
  imbalance_5 REAL,
  imbalance_10 REAL,
  imbalance_20 REAL,
  microprice REAL,
  microprice_deviation_bps REAL,
  metrics_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(bucket_end > bucket_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_flow_bucket_scope
  ON order_flow_buckets(symbol,window_ms,bucket_start);
CREATE INDEX IF NOT EXISTS idx_order_flow_bucket_recent
  ON order_flow_buckets(symbol,window_ms,bucket_end DESC);

CREATE TABLE IF NOT EXISTS market_event_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  provider TEXT NOT NULL,
  channel TEXT NOT NULL,
  session_id TEXT,
  timeframe TEXT,
  sequence_text TEXT,
  sequence_numeric_text TEXT,
  sequence_numeric_length INTEGER CHECK(sequence_numeric_length IS NULL OR sequence_numeric_length > 0),
  source_timestamp TEXT,
  received_at TEXT NOT NULL,
  candle_open_at TEXT,
  candle_close_at TEXT,
  candle_closed INTEGER CHECK(candle_closed IS NULL OR candle_closed IN (0,1)),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK(event_type != 'CANDLE' OR (timeframe IS NOT NULL AND candle_open_at IS NOT NULL AND candle_close_at IS NOT NULL AND candle_closed IS NOT NULL AND candle_close_at > candle_open_at))
);
CREATE INDEX IF NOT EXISTS idx_market_event_replay
  ON market_event_journal(received_at,sequence_numeric_length,sequence_numeric_text,sequence_text,id);
CREATE INDEX IF NOT EXISTS idx_market_event_symbol_time
  ON market_event_journal(symbol,event_type,received_at);

CREATE TABLE IF NOT EXISTS replay_runs (
  id TEXT PRIMARY KEY,
  run_key TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL DEFAULT 'replay-v1',
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  seed TEXT NOT NULL,
  ordering_policy TEXT NOT NULL DEFAULT 'receivedAt+sequence',
  input_hash TEXT,
  source_json TEXT NOT NULL,
  range_from TEXT,
  range_to TEXT,
  symbols_json TEXT NOT NULL,
  options_json TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  error_text TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(range_from IS NULL OR range_to IS NULL OR range_from <= range_to),
  CHECK((status IN ('PENDING','RUNNING') AND completed_at IS NULL) OR (status IN ('COMPLETED','FAILED') AND completed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_replay_runs_status
  ON replay_runs(status,created_at DESC);

CREATE TABLE IF NOT EXISTS replay_predictions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES replay_runs(id),
  prediction_key TEXT NOT NULL,
  evaluator TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes > 0),
  generated_at TEXT NOT NULL,
  resolves_at TEXT NOT NULL,
  entry_price REAL NOT NULL CHECK(entry_price > 0),
  predicted_direction TEXT NOT NULL CHECK(predicted_direction IN ('UP','DOWN','NEUTRAL')),
  probability_up REAL NOT NULL CHECK(probability_up BETWEEN 0 AND 1),
  features_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  outcome TEXT,
  actual_direction TEXT CHECK(actual_direction IS NULL OR actual_direction IN ('UP','DOWN','TIE')),
  resolution_price REAL CHECK(resolution_price IS NULL OR resolution_price > 0),
  resolution_observed_at TEXT,
  resolution_candle_close_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,prediction_key),
  CHECK(resolves_at > generated_at),
  CHECK((outcome IS NULL AND actual_direction IS NULL AND resolution_price IS NULL AND resolution_observed_at IS NULL AND resolution_candle_close_at IS NULL AND resolved_at IS NULL) OR (outcome IS NOT NULL AND actual_direction IS NOT NULL AND resolution_price IS NOT NULL AND resolution_observed_at IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK(resolved_at IS NULL OR (resolution_observed_at >= resolves_at AND resolved_at >= resolution_observed_at)),
  CHECK(resolution_candle_close_at IS NULL OR (resolution_candle_close_at >= resolves_at AND resolution_candle_close_at <= resolution_observed_at))
);
CREATE INDEX IF NOT EXISTS idx_replay_predictions_scope
  ON replay_predictions(run_id,evaluator,symbol,horizon_minutes,generated_at);
CREATE INDEX IF NOT EXISTS idx_replay_predictions_pending
  ON replay_predictions(run_id,resolves_at)
  WHERE outcome IS NULL;

CREATE TABLE IF NOT EXISTS walk_forward_folds (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES replay_runs(id),
  evaluator TEXT NOT NULL,
  fold_index INTEGER NOT NULL CHECK(fold_index >= 0),
  mode TEXT NOT NULL CHECK(mode IN ('expanding','rolling')),
  train_start TEXT NOT NULL,
  train_end TEXT NOT NULL,
  test_start TEXT NOT NULL,
  test_end TEXT NOT NULL,
  train_size INTEGER NOT NULL CHECK(train_size > 0),
  test_size INTEGER NOT NULL CHECK(test_size > 0),
  train_ids_json TEXT NOT NULL,
  test_ids_json TEXT NOT NULL,
  train_metrics_json TEXT NOT NULL,
  test_metrics_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,evaluator,fold_index),
  CHECK(train_start <= train_end AND test_start <= test_end AND train_end < test_start)
);
CREATE INDEX IF NOT EXISTS idx_walk_forward_folds_run
  ON walk_forward_folds(run_id,evaluator,fold_index);
