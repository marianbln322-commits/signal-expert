# Signal Expert Deep v0.9.0 architecture

## Boundary and invariants

Signal Expert is a local, read-only market analytics and PAPER research system for BTCUSDT and ETHUSDT. It has no exchange credentials, custody, withdrawal, or live-order path. MEXC Event Futures contract, payout, execution, and settlement interfaces are not verified; Spot observations are therefore labeled as proxies and never represented as Event Futures truth.

Core invariants:

- decisions consume completed candles only;
- provider attribution is explicit and incompatible providers are never merged into actionable evidence;
- incremental depth/order flow is available only from a synchronized Binance stream;
- missing, stale, gapped, low-liquidity, or abnormal-volatility inputs fail closed;
- forecast calibration uses resolved prospective observations only;
- replay is ordered by receipt time and sequence and cannot see future or incomplete observations;
- 10m and 30m engines are separate implementations;
- every executable action is local PAPER simulation.

## Isolated Windows/runtime topology

The Deep runtime is pinned to `127.0.0.1:4020` by `START-SIGNAL-EXPERT-4020.cmd`:

```text
instance: phase2
strict port: 4020
database: data/instances/phase2/signal-expert.db
lock/state: data/instances/phase2/
stream: enabled
```

Strict-port mode fails if 4020 is occupied. It does not discover, reuse, stop, or mutate the older Windows instance on 4101. Runtime and persistence paths are independent.

## Live data flow

```text
Official Binance Spot REST
  -> ticker + completed-candle bootstrap/reconciliation
  -> authoritative depth snapshot

Official Binance combined WebSocket
  -> aggTrade (including maker flag m)
  -> depth@100ms incremental updates
  -> book ticker and kline events

Depth synchronizer
  -> buffer events while snapshot is requested
  -> discard updates at/before snapshot lastUpdateId
  -> require bridging update
  -> apply contiguous updates
  -> detect duplicate/out-of-order/gap
  -> gap => invalidate + resynchronize

Attributed market state
  -> transport/timeframe freshness
  -> source and receipt-time coherence
  -> bounded order-flow windows
  -> persistent structure episodes
  -> normalized multi-timeframe features
  -> eight-regime classifier
  -> independent 10m engine / independent 30m engine
  -> shared fail-closed entry policy
  -> prospective forecast + candidate audit
  -> manual research view / autonomous PAPER scheduler
  -> first complete post-horizon 1m close
  -> outcome audit + eligible calibration sample
  -> SQLite + local HTTP API + dashboard
```

MEXC Spot can replace a failed compatible REST bundle only as an atomically attributed fallback. Binance incremental depth/order-flow state is not combined with MEXC REST state. In fallback, order flow is `UNAVAILABLE / REST_FALLBACK`, and gates that require it remain closed.

## Depth and order flow

`OrderBookService` follows Binance snapshot/incremental synchronization semantics. Its state includes update IDs, buffer bounds, duplicate/out-of-order/gap diagnostics, resync counts, freshness, and top levels. Snapshot or sequence uncertainty invalidates the book instead of preserving a possibly corrupt view.

Order-flow windows are bounded by configured time and storage limits. Aggregate trade direction is derived from the attributed maker flag. Metrics include buyer/seller volume, delta, imbalance, absorption/exhaustion evidence, and spoof-risk heuristics. These are deterministic market microstructure indicators, not claims about participant intent.

## Structure, features, and regimes

Completed-candle structure covers confirmed swings, FVG/IFVG, retests, sweeps, CHoCH/MSS, correction phases, level interactions, and completed-close invalidation. Structural episodes and transitions are durable so restart does not erase active context.

The normalized feature layer prevents engine-specific interpretation drift. The regime engine classifies exactly one of:

1. `LOW_LIQUIDITY`
2. `ABNORMAL_VOLATILITY`
3. `HIGH_VOLATILITY`
4. `COMPRESSION`
5. `BREAKOUT`
6. `STRONG_TREND`
7. `WEAK_TREND`
8. `RANGE`

Priority is safety-first: incomplete critical inputs classify fail-closed, then low liquidity and abnormal volatility override permissive regimes. `LOW_LIQUIDITY` and `ABNORMAL_VOLATILITY` cannot produce actionable readiness.

## Independent horizon engines

`app/engine-10m.mjs` emphasizes current 1m flow/trigger, 5m confirmation, near-term structure, and synchronized microstructure. `app/engine-30m.mjs` applies a distinct policy emphasizing 15m/1h context while still requiring current lower-timeframe confirmation. The implementations and regime matrices are physically separate. Both emit deterministic verdict, quality, evidence, blockers, invalidation, regime, version, and audit metadata.

The shared entry policy is evaluated when candidates are created and immediately before a PAPER position is persisted. It covers completed 1m trigger, 5m confirmation, 15m alignment, finite invalidation, trigger deadline, event risk, ticker/candle/depth freshness, provider coherence, spread, liquidity, stream health, depth synchronization, order-flow availability, regime safety, and configured confidence safeguards. A transient failure produces WAIT/BLOCKED and can be reevaluated while the candidate remains current.

## Forecast audit and calibration

Every canonical candidate, including WAIT, is stored prospectively with its decision key and input watermark. Resolution uses the first **complete 1m close after the exact horizon**; forming candles and earlier observations cannot resolve it. Missing timely truth remains explicit.

Calibration is segmented by relevant model/symbol/horizon identity. Isotonic and regularized Platt fits are derived only from resolved prospective rows. Reports include sample counts and probability metrics. Before the configured minimum sample, status is `WARMUP` and calibrated values are null. The system never relabels setup quality or raw directional evidence as calibrated probability.

Counterfactual readiness translates failed gates into ordered requirements and, where derivable, the next complete-candle observation time. It is explanatory only and cannot bypass a gate.

## Replay and walk-forward

The CLI accepts JSON, JSONL, database-export-shaped JSON, or stdin. Replay events are normalized and sorted by `receivedAt + sequence`. Candle close availability is enforced at the replay boundary, preventing decisions from seeing a forming candle or future event. Optional `--from`, `--to`, symbol filtering, deterministic seed, expanding/rolling walk-forward folds, and baselines are supported.

Replay runs, predictions, outcomes, metrics, diagnostics, and folds are persisted through the v0.9 DAO layer. The dashboard/API exposes run summaries. Replay remains offline PAPER research and is not a route to live execution.

## Operations and alert lifecycle

Operational state uses bounded windows and durable episode/audit records. It tracks feed latency, watermark movement/stalls, reconnects, gap/resync events, failover episodes, and recovery. Alerts use one lifecycle with deduplication, hysteresis/cooldown, acknowledgement/resolution state, and restart reconciliation. Recovery closes the existing episode rather than creating disconnected success events.

## Persistence

SQLite uses WAL mode and sequential migrations. Migration `011_v0_9_deep_analytics.sql` adds calibration observations/models/reports, forecast audit, structural episodes, order-flow snapshots, journal records, replay runs/predictions, outcomes, and walk-forward folds. Existing signals, decisions, PAPER positions, event-risk state, stream observations, and alerts remain compatible.

The package includes both `scripts/migrate.mjs` and `scripts/replay.mjs`.

## HTTP/UI composition

`app/server.mjs` composes market, structure, order book, order flow, regime, horizon engines, calibration, replay history, alert, operational, manual-signal, autonomous, and PAPER services. `/health` and API responses identify version `0.9.0`.

The aggregate dashboard endpoint returns a coherent symbol-scoped snapshot containing market, depth, order flow, regime, engines, counterfactuals, calibration, operations, alerts, replay, account, autonomous, and manual signal state. Dedicated operations, calibration, replay-run, feed, alert, source, market, and event-risk reads are available. Browser polling is local and state-changing controls require same origin.

## Security and failure handling

The server binds to loopback, validates query/body/provider payloads, limits request sizes/rates, applies restrictive response headers, and uses bounded timeout/backoff. No secret handling or signing code exists. Unavailable external data is surfaced, never simulated. Unknown source, mixed attribution, malformed payload, stale timestamps, depth discontinuity, and insufficient calibration evidence preserve explicit unavailable/warmup states.

## Live execution gate

Any future live adapter requires independently verified official contract/payout discovery, signed idempotent order semantics, settlement index and tie/rounding rules, reconciliation, account/rate/error contracts, regional authorization, restricted credentials, paper/live parity validation, and a persistent kill switch. See [`live-execution-gate.md`](live-execution-gate.md). Undocumented browser automation and Spot substitution are not acceptable.