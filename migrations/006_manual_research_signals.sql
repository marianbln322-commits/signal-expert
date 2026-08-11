CREATE TABLE manual_research_signals (
  id TEXT PRIMARY KEY,
  candidate_key TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL CHECK(symbol IN ('BTCUSDT','ETHUSDT')),
  horizon_minutes INTEGER NOT NULL CHECK(horizon_minutes IN (10,30)),
  direction TEXT NOT NULL CHECK(direction IN ('UP','DOWN','WAIT')),
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('WAIT','READY','EXPIRED')),
  quality_score INTEGER NOT NULL CHECK(quality_score BETWEEN 0 AND 100),
  quality_band TEXT NOT NULL CHECK(quality_band IN ('BELOW_STANDARD','STANDARD','HIGH','EXCEPTIONAL')),
  reasons_json TEXT NOT NULL,
  details_json TEXT NOT NULL,
  timeframe_watermarks_json TEXT NOT NULL,
  invalidation_json TEXT NOT NULL,
  invalidation_price REAL,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  entry_price REAL,
  entry_at TEXT,
  entry_valid_until TEXT,
  resolves_at TEXT,
  entry_source_json TEXT,
  candle_sources_json TEXT NOT NULL,
  market_classification TEXT NOT NULL DEFAULT 'SPOT_PROXY' CHECK(market_classification = 'SPOT_PROXY'),
  settlement_classification TEXT NOT NULL DEFAULT 'NOT_EVENT_FUTURES_SETTLEMENT' CHECK(settlement_classification = 'NOT_EVENT_FUTURES_SETTLEMENT'),
  proxy_outcome TEXT CHECK(proxy_outcome IS NULL OR proxy_outcome IN ('PROXY_CORRECT','PROXY_INCORRECT','PROXY_TIE','NO_TIMELY_OBSERVATION')),
  resolution_price REAL,
  resolution_source_json TEXT,
  resolved_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(
    (lifecycle_status = 'WAIT' AND entry_price IS NULL AND entry_at IS NULL AND entry_valid_until IS NULL AND resolves_at IS NULL AND entry_source_json IS NULL AND proxy_outcome IS NULL AND resolution_price IS NULL AND resolution_source_json IS NULL AND resolved_at IS NULL AND expired_at IS NULL)
    OR
    (lifecycle_status = 'READY' AND direction IN ('UP','DOWN') AND entry_price > 0 AND entry_at IS NOT NULL AND entry_valid_until IS NOT NULL AND entry_valid_until > entry_at AND resolves_at > entry_valid_until AND entry_source_json IS NOT NULL AND proxy_outcome IS NULL AND resolution_price IS NULL AND resolution_source_json IS NULL AND resolved_at IS NULL AND expired_at IS NULL)
    OR
    (lifecycle_status = 'EXPIRED' AND direction IN ('UP','DOWN') AND entry_price > 0 AND entry_at IS NOT NULL AND entry_valid_until IS NOT NULL AND entry_valid_until > entry_at AND resolves_at > entry_valid_until AND entry_source_json IS NOT NULL AND proxy_outcome IS NOT NULL AND resolution_source_json IS NOT NULL AND resolved_at IS NOT NULL AND expired_at IS NOT NULL
      AND ((proxy_outcome IN ('PROXY_CORRECT','PROXY_INCORRECT','PROXY_TIE') AND resolution_price > 0) OR (proxy_outcome = 'NO_TIMELY_OBSERVATION' AND resolution_price IS NULL)))
  )
);
CREATE INDEX manual_research_signals_recent_idx ON manual_research_signals(generated_at DESC, created_at DESC);
CREATE INDEX manual_research_signals_resolution_idx ON manual_research_signals(lifecycle_status, resolves_at);
CREATE INDEX manual_research_signals_confidence_idx ON manual_research_signals(strategy_version, symbol, horizon_minutes, proxy_outcome);
CREATE UNIQUE INDEX one_ready_manual_signal_per_segment_idx
  ON manual_research_signals(symbol, horizon_minutes)
  WHERE lifecycle_status = 'READY';
