CREATE TABLE IF NOT EXISTS strategy_states (
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  machine_type TEXT NOT NULL,
  machine_key TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  last_event_key TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(symbol,horizon_minutes,machine_type,machine_key)
);

CREATE TABLE IF NOT EXISTS strategy_state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL,
  machine_type TEXT NOT NULL,
  machine_key TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  evidence_json TEXT NOT NULL,
  transitioned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_transitions_scope ON strategy_state_transitions(symbol,horizon_minutes,machine_type,transitioned_at DESC);
