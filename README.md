# Signal Expert Deep v0.9.0

Local-first, auditable BTCUSDT/ETHUSDT analytics for manual research signals and autonomous PAPER shadow positions. The runtime is dependency-free Node.js 22, stores state in SQLite, and does not contain exchange credentials or live-order execution.

## Windows release: isolated port 4020

The v0.9 Windows package is designed to coexist with an older Signal Expert instance. Extract it into a **new folder** and double-click:

```text
START-SIGNAL-EXPERT-4020.cmd
```

The launcher binds strictly to `http://127.0.0.1:4020`, uses instance name `phase2`, and stores its lock, runtime state, and database separately under `data/instances/phase2/`. If port 4020 is occupied, startup fails visibly instead of selecting another port. It does not modify or stop an existing instance on port 4101.

Requirements: Node.js 22.5 or newer. The release is self-contained and does not need `npm install`. Keep the launcher window open while using the dashboard; press `Ctrl+C` to stop it.

## Deep v0.9 capabilities

- **Synchronized Binance order book:** buffers `@depth@100ms`, obtains the REST snapshot, discards obsolete updates, bridges the snapshot update ID, then applies continuous incremental events. Duplicate, out-of-order, and gap events are detected; a gap forces resynchronization.
- **Order-flow analytics:** consumes attributed aggregate trades, including Binance maker flag `m`, and calculates bounded rolling buy/sell flow, delta, imbalance, absorption, exhaustion, and spoof-risk heuristics. Spoof risk is a heuristic, not an allegation.
- **Atomic provider behavior:** official Binance Spot is primary. Official MEXC Spot is an attributed REST fallback for compatible market snapshots. Incremental order flow never mixes providers and becomes `UNAVAILABLE / REST_FALLBACK` when Binance stream truth is unavailable.
- **Persistent structural episodes:** correction, level interaction, liquidity and structure transitions survive restarts and remain auditable.
- **Eight extended regimes:** `LOW_LIQUIDITY`, `ABNORMAL_VOLATILITY`, `HIGH_VOLATILITY`, `COMPRESSION`, `BREAKOUT`, `STRONG_TREND`, `WEAK_TREND`, and `RANGE`. Missing critical liquidity inputs, low liquidity, and abnormal volatility fail closed.
- **Physically separate horizon engines:** `engine-10m.mjs` and `engine-30m.mjs` use distinct horizon/regime policies rather than a shared weight matrix.
- **Prospective calibration only:** isotonic and Platt models are fitted only from resolved, prospective forecast outcomes. The dashboard shows `WARMUP` and null calibrated probabilities until the configured minimum real sample exists.
- **Strict forecast resolution:** a forecast resolves on the first complete 1m close after its horizon. WAIT forecasts and READY forecasts are retained for audit.
- **Counterfactual readiness:** blocked candidates expose ordered, auditable requirements instead of inventing readiness.
- **Exact forecast availability:** the raw UP/DOWN split is null until all four timeframes have 50 completed candles, close watermarks, and no canonical engine blocker; every missing count, watermark, or engine condition is exposed with observed and required evidence.
- **Conservative reaction zones:** each candidate carries descriptive ceiling/resistance and floor/support zones built from its existing levels, 1m ATR, completed rejection patterns, level interactions, structure, LIVE canonical order flow, and order-book evidence. They are not reversal guarantees, entry gates, or stake advice.
- **Operational lifecycle:** bounded latency/feed metrics, watermark stall and recovery, failover episodes, alert cooldown/hysteresis, restart reconciliation, and one persistent alert lifecycle.
- **Deterministic replay and walk-forward:** events are ordered by `receivedAt + sequence`; incomplete candles and future observations are excluded from earlier decisions. Replay, baselines, folds, predictions, outcomes, and metrics can be persisted.
- **Deep dashboard/API:** feed, synchronized depth, order flow, extended regime, separate engines, calibration, replay, operations, alerts, and existing PAPER/manual signal views are available locally.

## Safety boundary

Signal Expert is **PAPER/research only**. `READY` means the configured Spot-proxy research checks passed; it is not an exchange acknowledgement, an Event Futures quote, or proof that an order was accepted. No authenticated MEXC Event Futures execution, payout, contract, position, or settlement API has been verified, so no branch can place a live order. Missing, stale, mixed-provider, low-liquidity, abnormal-volatility, or structurally invalid input fails closed rather than being fabricated.

Raw provider values, deterministic calculations, uncalibrated model estimates, prospective calibrated outputs, Spot-proxy observations, paper assumptions, and unavailable values are explicitly classified. Setup quality and the complementary technical UP/DOWN split are not win probabilities.

## Market and signal pipeline

1. Binance REST bootstraps ticker, candles, and the depth snapshot; Binance WebSocket supplies aggregate trades, book updates, and candle events.
2. Only completed candles enter decisions. Market data is checked for transport freshness, timeframe freshness, source coherence, and receipt-time skew.
3. Objective structure includes confirmed swings, FVG/IFVG and retests, sweeps, CHoCH/MSS, support/resistance interactions, corrections, and finite completed-close invalidation.
4. The eight-regime classifier and normalized feature layer feed the independent 10m and 30m engines. Foundational candle-count/watermark blockers are merged with canonical engine blockers before any forecast split is exposed.
5. After canonical evidence is attached, a descriptive reaction-zone stage reuses the candidate's nearest levels, 1m ATR/candles, structure, level interactions, order flow, and order-book evidence; it never changes direction, quality, entry gates, execution, or sizing.
6. The entry policy rechecks direction, quality, trigger deadline, 1m/5m/15m alignment, event risk, depth, spread, liquidity, freshness, provider coherence, and operational health immediately before a local PAPER open.
7. Forecasts and decisions are persisted prospectively; outcomes are resolved without look-ahead and are then eligible for calibration.

The autonomous scheduler can open at most one local PAPER position. Bankroll, stake, exposure, daily stop, and recovery limits remain hard caps. A previous loss can select a configured paper recovery stage but can never create a signal.

## Local API

Important read endpoints include:

- `GET /health`
- `GET /api/v1/dashboard?symbol=BTCUSDT`
- `GET /api/v1/feeds`
- `GET /api/v1/operations`
- `GET /api/v1/calibration`
- `GET /api/v1/replay/runs`
- `GET /api/v1/alerts`
- `GET /api/v1/market/BTCUSDT`

Responses include API version `0.9.0`. Local state-changing controls require a same-origin browser request.

## Replay CLI

The packaged release includes both migration and replay scripts:

```bash
npm run replay -- --input events.jsonl --output replay-result.json
npm run replay -- --input export.json --output result.json --symbols BTCUSDT,ETHUSDT --walk-forward expanding
```

Options include `--from`, `--to`, `--symbols`, `--seed`, `--database`, and `--walk-forward` (`expanding`, `rolling`, or `mode:train:test:step`). Use `-` for stdin/stdout. Replay is classified as offline PAPER research only.

## Developer commands

```bash
npm run db:migrate
npm run start:4020
npm run lint
npm run typecheck
npm test
npm run build
npm run package:release -- 0.9.0
```

The standard development start remains available with `npm start`. The isolated launcher is recommended when preserving another local instance.

## Configuration

Copy `.env.example` if custom values are needed. Relevant v0.9 controls include depth snapshot/buffer/level limits, order-flow freshness and retention, stream freshness/reconciliation, calibration minimum sample, replay history limits, PAPER risk limits, manual/autonomous enablement, event-risk policy, and provider timeout/failover settings.

Node does not automatically load `.env`; export values in the process environment or use the included launcher defaults.

## Data and migrations

SQLite runs in WAL mode. Migrations 001–010 retain the existing market, decision, signal, PAPER, structural, forecast, feed, and alert history. Migration `011_v0_9_deep_analytics.sql` adds Deep analytics persistence for calibration, forecast audit, structural episodes, order flow, journal, replay runs/predictions, and walk-forward folds.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) describes the v0.9 runtime and fail-closed boundaries.
- [`docs/live-execution-gate.md`](docs/live-execution-gate.md) lists what must be verified before any live Event Futures adapter could be considered.

## Public data sources

- [Binance Market Data Only documentation](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only) — primary public Spot REST/stream source.
- [MEXC Spot API v3 documentation](https://mexcdevelop.github.io/apidocs/spot_v3_en/) — explicitly attributed REST fallback.
- [MEXC Event Futures overview](https://www.mexc.com/learn/article/17827791522522) — product overview only, not evidence of an execution API.

External-source descriptions are rephrased for licensing compliance.