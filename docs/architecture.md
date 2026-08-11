# Architecture decision record

## MVP boundary

Read-only MEXC Spot analytics plus explicitly labeled 10m/30m paper contracts for BTCUSDT and ETHUSDT. Live Event Futures execution remains unavailable until official endpoints and exact settlement semantics are verified.

## Data flow

```text
MEXC Spot REST v3
  -> timeout, retry, runtime schema checks
  -> in-memory market cache and freshness state
  -> deterministic quantitative engine
  -> SQLite audit trail
  -> dependency-free Node HTTP API
  -> static responsive dashboard

Paper request -> input/cap checks -> immutable entry timestamp
  -> SQLite ledger -> first fresh ticker after resolution
  -> WON / LOST / REFUNDED and realized P&L
```

## Classifications

- `RAW`: validated provider value.
- `CALCULATED`: deterministic transformation or configured paper assumption.
- `MODEL_ESTIMATE`: rules output with calibration status.
- `UNAVAILABLE`: no verified source or no data.

## Model v0.1

Rules are used because no historical Event Futures labels exist. Inputs are EMA 9/21, RSI 14, ATR 14, Bollinger 20/2, relative volume and wick rejection. `WAIT` is the default. MEXC Spot is only a proxy; polling cannot reproduce tick settlement; the heuristic probability is uncalibrated and excluded from adaptive sizing by default.

Paper settlement is independent of candle availability: it uses the first fresh ticker at or after expiry and refunds the contract when that observation is more than 30 seconds late. The local server binds to loopback by default; network exposure through Docker is explicit.

## Security

There are no private credentials or execution endpoints. Provider and user inputs are validated, payloads are size-limited, traversal is blocked, rate limiting and restrictive headers are applied, external requests time out with bounded backoff, and SQLite uses WAL mode.

## Gate for live execution

Required before implementation: official contract/payout feed, signed order and idempotency contract, settlement index plus tie/rounding rules, account reconciliation, rate/error documentation, regional authorization, restricted no-withdrawal key, paper/live parity tests and a persistent kill switch. Undocumented browser automation is not an acceptable production substitute.
