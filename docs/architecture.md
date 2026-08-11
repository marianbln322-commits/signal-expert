# Architecture decision record

## MVP boundary

Read-only MEXC Spot analytics, durable manual 10m/30m research signals, and explicitly labeled PAPER shadow contracts for BTCUSDT and ETHUSDT. The decision engine uses completed candles only on 1m, 5m, 15m and 1h. A manual operator may act during the signal's strict entry window, but no exchange-order endpoint exists. Live Event Futures feed, execution, and settlement remain unavailable until official contracts and semantics are verified.

## Data flow

```text
MEXC Spot REST v3 (primary)
  -> explicit Binance public fallback only when primary fails
  -> active source + primary error displayed
  -> timeout, retry, runtime schema checks
  -> in-memory market cache and freshness state
  -> deterministic quantitative + completed-candle structure engine
  -> EMA20/50, FVG/IFVG, sweep, CHoCH/MSS and finite invalidation audit
  -> completed-candle 10m/30m setup ranking
  -> strict manual signal entry window + immutable Spot-proxy provenance
  -> prospective symbol+horizon confidence hidden until minimum sample
  -> Wilson safeguard against configured-payout break-even
  -> bankroll-aware autonomous PAPER shadow state machine
  -> SQLite signal/decision/state/position audit trail
  -> dependency-free Node HTTP API
  -> static responsive dashboard

Manual signal scan -> unique four-timeframe candidate key
  -> require fresh usable attributed Spot ticker + finite structural invalidation
  -> READY and ENTER_NOW for configured short entry window
  -> TRACKING_DO_NOT_ENTER_LATE until target horizon
  -> first timely post-horizon Spot-proxy observation
  -> PROXY_CORRECT / PROXY_INCORRECT / PROXY_TIE / NO_TIMELY_OBSERVATION
  -> confidence unavailable below minimum decisive sample
  -> Wilson VALIDATED / MONITOR / UNDERPERFORMING gate

Autonomous PAPER scan -> same unique completed-candle candidate key
  -> quality/alignment/structure/volatility/invalidation gate
  -> BTC/ETH × 10m/30m sample-aware segment safeguard
  -> exact hard-capped stake plan
  -> at most one autonomous position -> wait for settlement
  -> WON reset / LOST capped recovery stage / REFUNDED retain stage

Manual paper request -> input/cap checks -> immutable entry timestamp
  -> SQLite ledger -> first fresh ticker after resolution
  -> WON / LOST / REFUNDED and realized P&L
```

## Classifications

- `RAW`: validated provider value.
- `CALCULATED`: deterministic transformation or configured paper assumption.
- `MODEL_ESTIMATE`: deterministic rules output with calibration status; setup quality is not probability.
- `SPOT_PROXY`: an attributed underlying-market entry observation, not an Event Futures contract value.
- `SPOT_PROXY_PROSPECTIVE_OUTCOMES_NOT_EVENT_FUTURES_CALIBRATION`: measured manual-signal shadow outcomes shown only after the minimum decisive sample.
- `NOT_EVENT_FUTURES_SETTLEMENT`: explicit classification for proxy resolution observations.
- `UNAVAILABLE`: no verified source, insufficient sample, or no data.

## Model v0.3

Rules are used because no historical Event Futures labels exist. The directional display uses completed 1h regime, completed 15m/5m structure, and completed 1m trigger with EMA 9/21, RSI 14, ATR 14, Bollinger 20/2, relative volume and wick rejection. The autonomous engine additionally builds objective structure on completed 5m/15m/1h candles: two-sided confirmed pivots, three-candle FVGs and later retests, completed-close FVG inversion, confirmed-level liquidity sweeps, completed-close CHoCH/MSS, and EMA20/50 trend/dynamic context. Its confluence components expose objective definitions, direction, activity, timeframe and weight. Every candidate requires a finite completed-candle structural invalidation before it can become eligible.

The 10m evaluator emphasizes the completed 1m trigger and aligned 5m/15m context. The 30m evaluator emphasizes aligned 1h/15m structure with 5m confirmation. Forming candles are discarded at both service and model boundaries, swing points are not usable until their right-side confirmation candles close, and a deterministic key containing all four close timestamps prevents duplicate decisions.

The internal directional evidence becomes a complementary UP/DOWN split that always totals 100%; values such as 78/44 are never displayed as probabilities. Autonomous `STANDARD`, `HIGH`, and `EXCEPTIONAL` values are setup-quality tiers, not calibrated success probabilities. `WAIT` is the default whenever history, alignment, freshness, quality, or volatility gates fail. Measured win rate and ROI are derived only from settled paper positions and retain sample size.

The default 500 USDT `ADAPTIVE_CAPPED` simulation uses a 0.5% equity base, 1×/1.5×/2× quality multipliers, a 2% per-position equity cap, 25 USDT absolute cap, and at most one calculated recovery. `FLAT` and exact `OBSERVED_10_30_90_270` profiles are available for comparison, but all profiles obey cash, exposure, daily, and stake caps. Unaffordable exact stages are blocked, never clamped. A loss can advance a stake stage but can never create a setup.

SQLite migration 004 adds durable decision/state metadata and a partial unique index that permits at most one open autonomous position. Migration 005 adds structured decision details and explicit invalidation persistence. Migration 006 adds durable manual signal lifecycle, entry deadline, immutable ticker/candle provenance, fixed non-settlement classifications, proxy outcomes, and one unresolved READY signal per symbol+horizon. Manual confidence is grouped prospectively by strategy version, symbol, and horizon. Its percentage and Wilson bounds remain null before the configured minimum. Afterward the same conservative bound logic marks VALIDATED/MONITOR/UNDERPERFORMING; the enabled confidence gate holds only an UNDERPERFORMING segment at WAIT. The scheduler is busy-locked, persists `WAIT`/`BLOCKED`/`OPEN`, waits for settlement before scanning for another entry, and reconciles state on restart. Binance Spot is treated as a highly relevant underlying-market proxy when MEXC Spot is unavailable, but remains explicitly attributed and is not asserted to be the Event Futures settlement Index.

The manual signal service consumes only MarketService snapshots and contains no provider call, credential, account, or order method. A READY signal stays stable until its proxy observation, while ENTER_NOW expires independently after the short entry deadline. PAPER settlement and manual proxy observation are both independent of candle availability: they require a fresh source timestamp at/after the horizon and reject observations more than 30 seconds late. Neither is labeled as Event Futures settlement. The local launcher binds to loopback, Docker publishes port 4100 on host loopback only, and autonomous pause/resume additionally requires a same-origin browser request.

## Security

There are no private credentials or execution endpoints. Provider and user inputs are validated, payloads are size-limited, traversal is blocked, rate limiting and restrictive headers are applied, external requests time out with bounded backoff, and SQLite uses WAL mode.

## Gate for live execution

Required before implementation: official contract/payout feed, signed order and idempotency contract, settlement index plus tie/rounding rules, account reconciliation, rate/error documentation, regional authorization, restricted no-withdrawal key, paper/live parity tests and a persistent kill switch. Undocumented browser automation is not an acceptable production substitute.
