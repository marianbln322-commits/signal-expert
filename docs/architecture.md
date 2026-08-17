# Architecture decision record

## MVP boundary

Read-only MEXC Spot analytics, durable manual 10m/30m research signals, and explicitly labeled PAPER shadow contracts for BTCUSDT and ETHUSDT. The decision engine uses completed candles only on 1m, 5m, 15m and 1h. A manual operator may act during the signal's strict entry window, but no exchange-order endpoint exists. Live Event Futures feed, execution, and settlement remain unavailable until official contracts and semantics are verified.

## Data flow

```text
Binance Spot REST market data (primary)
  -> explicit MEXC Spot REST v3 bundle fallback only when primary fails
  -> active source + primary error displayed
  -> timeout, retry, runtime schema checks
  -> separate transport freshness and timeframe-aware latest-completed-close freshness
  -> in-memory market cache and freshness state
  -> deterministic quantitative + completed-candle structure engine
  -> completed 1m trigger + explicitly aligned completed 5m confirmation + completed 15m trend
  -> one-provider coherence across candle, ticker and order-book inputs before action
  -> EMA20/50, FVG/IFVG, sweep, CHoCH/MSS and finite invalidation audit
  -> completed-candle 10m/30m setup ranking
  -> one shared auditable entry policy:
       fresh ticker/candles + trigger deadline
       -> one provider across 1m/5m/15m/1h candles, ticker and order book
       -> validated Spot spread + cumulative 10-level near-book liquidity
       -> ticker/book provider and timestamp coherence
       -> macro PASS / BLOCKED, or SKIPPED when disabled (not filtered)
  -> research-window setup state + immutable Spot-proxy provenance
  -> selected-symbol 10m/30m cards assembled atomically from one candidate key
  -> prospective symbol+horizon confidence hidden until minimum sample
  -> Wilson safeguard against configured-payout break-even
  -> bankroll-aware autonomous PAPER shadow state machine
  -> immediate shared-policy recheck before every local PAPER open
  -> SQLite signal/decision/state/position and entry-gate audit trail
  -> dependency-free Node HTTP API
  -> static responsive dashboard

Manual signal scan -> unique four-timeframe candidate key
  -> require fresh completed 1m trigger aligned with completed 5m structure and completed 15m trend
  -> require quality + horizon-specific support/resistance + finite completed-close invalidation + fresh usable attributed Spot ticker/candles
  -> require one provider across candles/ticker/book plus validated Spot spread/near-book liquidity and timestamp coherence
  -> require macro CLEAR when enabled; disabled records SKIPPED, not filtered
  -> READY and ENTER_NOW for configured short entry window
  -> TRACKING_DO_NOT_ENTER_LATE until target horizon
  -> first timely post-horizon Spot-proxy observation
  -> PROXY_CORRECT / PROXY_INCORRECT / PROXY_TIE / NO_TIMELY_OBSERVATION
  -> confidence unavailable below minimum decisive sample
  -> Wilson VALIDATED / MONITOR / UNDERPERFORMING gate

Autonomous PAPER scan -> same unique completed-candle candidate key
  -> same shared 1m/5m/freshness/spread/liquidity/source/macro entry policy
  -> quality/alignment/structure/volatility/invalidation gate
  -> BTC/ETH × 10m/30m sample-aware segment safeguard
  -> exact hard-capped stake plan
  -> immediate shared-policy recheck (TOCTOU protection)
  -> at most one local PAPER position -> wait for Spot-proxy settlement
  -> WON reset / LOST capped recovery stage / REFUNDED retain stage

Manual PAPER request -> input/cap checks -> find matching current candidate
  -> immediate shared-policy recheck; no bypass for stale or newly blocked entries
  -> immutable entry timestamp + migration-007 gate evidence
  -> SQLite local PAPER ledger -> first fresh Spot ticker after resolution
  -> WON / LOST / REFUNDED and realized simulated P&L
  -> no live Event Futures order adapter or exchange request
```

## Classifications

- `RAW`: validated provider value.
- `CALCULATED`: deterministic transformation or configured paper assumption.
- `MODEL_ESTIMATE`: deterministic rules output with calibration status; setup quality is not probability.
- `SPOT_PROXY`: an attributed underlying-market entry observation, not an Event Futures contract value.
- `SPOT_PROXY_PROSPECTIVE_OUTCOMES_NOT_EVENT_FUTURES_CALIBRATION`: measured manual-signal shadow outcomes shown only after the minimum decisive sample.
- `NOT_EVENT_FUTURES_SETTLEMENT`: explicit classification for proxy resolution observations.
- `UNAVAILABLE`: no verified source, insufficient sample, or no data.

## Strategy and entry policy v0.7

Rules are used because no historical Event Futures labels exist. Strategy v0.7 combines an eight-candle completed 1m flow with an objective completed 1m trigger, established 5m structure and trend outlook, and completed 15m/1h context. The 1m flow measures ATR-normalized displacement, body and wick pressure, directional move balance, and acceleration/deceleration; the 5m outlook separates continuation, reversal watch, and range/transition. The engine additionally builds objective structure on completed 5m/15m/1h candles: two-sided confirmed pivots, three-candle FVGs and later retests, completed-close FVG inversion, confirmed-level liquidity sweeps, completed-close CHoCH/MSS, and EMA20/50 trend/dynamic context. Each horizon receives nearest support/resistance with source and distance plus a finite structural invalidation that requires a completed 5m close for 10m setups or a completed 15m close for 30m setups. Completed 1m pullbacks against the established 5m trend are classified by depth, duration, direction and interaction with support/resistance; a confirmed local 1m level break blocks entry but is not mislabeled as higher-timeframe trend invalidation.

The shared entry-policy v0.7 is applied when a manual signal is created, during autonomous selection, and again immediately before a manual or autonomous PAPER position is persisted. Its immutable checks cover direction, quality, invalidation, completed 1m trigger, completed 5m confirmation, completed 15m alignment, trigger deadline, market freshness, validated Spot order book, configured spread, cumulative 10-level near-book notional, one provider across all candle/ticker/book inputs, receipt-time coherence, and macro/news state. MEXC and Binance failover occurs atomically within the ticker/depth bundle and within the four-timeframe candle bundle; if independently refreshed bundles disagree on provider, analysis may remain visible but entry fails closed. An enabled but stale, unavailable, or blacked-out macro source blocks. A disabled macro source is `SKIPPED` and means not filtered; it is never represented as `CLEAR` or `PASS`. Manual READY responses also carry a current non-mutating gate overlay, and both manual WAIT and autonomous BLOCKED decisions are reevaluated while the same trigger is still current so transient market gates are not frozen at their first observation.

The 10m evaluator emphasizes the completed 1m trigger and aligned 5m/15m context. The 30m evaluator emphasizes aligned 1h/15m structure with 5m confirmation. Forming candles are discarded at both service and model boundaries, swing points are not usable until their right-side confirmation candles close, and a deterministic key containing all four close timestamps prevents duplicate decisions.

The internal directional evidence becomes a complementary UP/DOWN split that always totals 100%; values such as 78/44 are never displayed as probabilities. Autonomous `STANDARD`, `HIGH`, and `EXCEPTIONAL` values are setup-quality tiers, not calibrated success probabilities. `WAIT` is the default whenever history, alignment, freshness, quality, or volatility gates fail. Measured win rate and ROI are derived only from settled paper positions and retain sample size.

The default 500 USDT `ADAPTIVE_CAPPED` simulation uses a 0.5% equity base, 1×/1.5×/2× quality multipliers, a 2% per-position equity cap, 25 USDT absolute cap, and at most one calculated recovery. `FLAT` and exact `OBSERVED_10_30_90_270` profiles are available for comparison, but all profiles obey cash, exposure, daily, and stake caps. Unaffordable exact stages are blocked, never clamped. A loss can advance a stake stage but can never create a setup.

SQLite migration 004 adds durable decision/state metadata and a partial unique index that permits at most one open autonomous position. Migration 005 adds structured decision details and explicit invalidation persistence. Migration 006 adds durable manual signal lifecycle, entry deadline, immutable ticker/candle provenance, fixed non-settlement classifications, proxy outcomes, and one unresolved READY signal per symbol+horizon. Migration 007 stores the exact shared-policy version, evaluation timestamp, checks, order-book evidence, and macro/news evidence used immediately before a PAPER position is persisted; upgraded pre-v0.5 rows receive the explicit `NOT_EVALUATED_PRE_V0_5` classification rather than an ambiguous empty object. Manual confidence is grouped prospectively by strategy version, symbol, and horizon. Its percentage and Wilson bounds remain null before the configured minimum. Afterward the same conservative bound logic marks VALIDATED/MONITOR/UNDERPERFORMING; the enabled confidence gate holds only an UNDERPERFORMING segment at WAIT. The scheduler is busy-locked, persists `WAIT`/`BLOCKED`/`OPEN`, waits for settlement before scanning for another entry, and reconciles state on restart. Official Binance Spot is the selected primary underlying-market proxy; official MEXC Spot is used only as an explicitly attributed atomic bundle fallback. Neither source is asserted to be the Event Futures settlement index.

The manual signal service consumes only MarketService snapshots and contains no provider call, credential, account, or order method. The browser dashboard reads its five local views through one symbol-scoped `/api/v1/dashboard` snapshot every three seconds; refreshes are single-flight/coalesced and hidden tabs do not poll. Existing granular read endpoints remain available for compatibility, while the unchanged per-IP limiter continues to protect both reads and state changes. A READY signal stays stable until its proxy observation, while ENTER_NOW expires independently after the short entry deadline. PAPER settlement and manual proxy observation are both independent of candle availability: they require a fresh source timestamp at/after the horizon and reject observations more than 30 seconds late. Neither is labeled as Event Futures settlement. The local launcher binds to loopback, Docker publishes port 4100 on host loopback only, and autonomous pause/resume additionally requires a same-origin browser request.

## Security

There are no private credentials or execution endpoints. Provider and user inputs are validated, payloads are size-limited, traversal is blocked, rate limiting and restrictive headers are applied, external requests time out with bounded backoff, and SQLite uses WAL mode.

## Gate for live execution

Required before implementation: official contract/payout feed, signed order and idempotency contract, settlement index plus tie/rounding rules, account reconciliation, rate/error documentation, regional authorization, restricted no-withdrawal key, paper/live parity tests and a persistent kill switch. Undocumented browser automation is not an acceptable production substitute.
