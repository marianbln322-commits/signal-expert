# Architecture decision record

## MVP boundary

Read-only MEXC Spot analytics plus explicitly labeled 10m/30m paper contracts for BTCUSDT and ETHUSDT. The decision engine uses completed candles only on 1m, 5m, 15m and 1h. Live Event Futures execution remains unavailable until official endpoints and exact settlement semantics are verified.

## Data flow

```text
MEXC Spot REST v3 (primary)
  -> explicit Binance public fallback only when primary fails
  -> active source + primary error displayed
  -> timeout, retry, runtime schema checks
  -> in-memory market cache and freshness state
  -> deterministic quantitative engine
  -> completed-candle 10m/30m setup ranking
  -> bankroll-aware autonomous PAPER state machine
  -> SQLite decision/state/position audit trail
  -> dependency-free Node HTTP API
  -> static responsive dashboard

Autonomous scan -> unique four-timeframe candle decision key
  -> quality/alignment/volatility gate -> exact hard-capped stake plan
  -> at most one autonomous position -> wait for settlement
  -> WON reset / LOST capped recovery stage / REFUNDED retain stage

Manual paper request -> input/cap checks -> immutable entry timestamp
  -> SQLite ledger -> first fresh ticker after resolution
  -> WON / LOST / REFUNDED and realized P&L
```

## Classifications

- `RAW`: validated provider value.
- `CALCULATED`: deterministic transformation or configured paper assumption.
- `MODEL_ESTIMATE`: rules output with calibration status.
- `UNAVAILABLE`: no verified source or no data.

## Model v0.2

Rules are used because no historical Event Futures labels exist. The directional display uses completed 1h regime, completed 15m/5m structure, and completed 1m trigger with EMA 9/21, RSI 14, ATR 14, Bollinger 20/2, relative volume and wick rejection. The autonomous 10m evaluator requires a completed 1m trigger aligned with 5m/15m and no contradictory 1h regime. The 30m evaluator requires aligned 1h/15m structure with non-adverse 5m/1m confirmation. Forming candles are discarded at both service and model boundaries, and a deterministic key containing all four close timestamps prevents duplicate decisions.

The internal directional evidence becomes a complementary UP/DOWN split that always totals 100%; values such as 78/44 are never displayed as probabilities. Autonomous `STANDARD`, `HIGH`, and `EXCEPTIONAL` values are setup-quality tiers, not calibrated success probabilities. `WAIT` is the default whenever history, alignment, freshness, quality, or volatility gates fail. Measured win rate and ROI are derived only from settled paper positions and retain sample size.

The default 500 USDT `ADAPTIVE_CAPPED` simulation uses a 0.5% equity base, 1×/1.5×/2× quality multipliers, a 2% per-position equity cap, 25 USDT absolute cap, and at most one calculated recovery. `FLAT` and exact `OBSERVED_10_30_90_270` profiles are available for comparison, but all profiles obey cash, exposure, daily, and stake caps. Unaffordable exact stages are blocked, never clamped. A loss can advance a stake stage but can never create a setup.

SQLite migration 004 adds durable decision/state metadata and a partial unique index that permits at most one open autonomous position. The scheduler is busy-locked, persists `WAIT`/`BLOCKED`/`OPEN`, waits for settlement before scanning for another entry, and reconciles state on restart. Binance Spot is treated as a highly relevant underlying-market proxy when MEXC Spot is unavailable, but remains explicitly attributed and is not asserted to be the Event Futures settlement Index.

Paper settlement is independent of candle availability: it uses the first fresh ticker at or after expiry and refunds the contract when that observation is more than 30 seconds late. The local launcher binds to loopback, Docker publishes port 4100 on host loopback only, and autonomous pause/resume additionally requires a same-origin browser request.

## Security

There are no private credentials or execution endpoints. Provider and user inputs are validated, payloads are size-limited, traversal is blocked, rate limiting and restrictive headers are applied, external requests time out with bounded backoff, and SQLite uses WAL mode.

## Gate for live execution

Required before implementation: official contract/payout feed, signed order and idempotency contract, settlement index plus tie/rounding rules, account reconciliation, rate/error documentation, regional authorization, restricted no-withdrawal key, paper/live parity tests and a persistent kill switch. Undocumented browser automation is not an acceptable production substitute.
