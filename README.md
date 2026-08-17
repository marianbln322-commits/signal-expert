# Signal Expert

Local-first, auditable BTCUSDT/ETHUSDT market analytics and event-futures research. Raw provider data, calculated indicators, uncalibrated estimates, configured paper assumptions and unavailable values are visibly separated.

## Functional scope

- Official public MEXC Spot REST ticker, depth and completed 1m/5m/15m/1h candles with source/receive timestamps.
- Explicit Binance public market-data fallback when MEXC is unreachable; ticker+depth and all candle timeframes switch as coherent provider bundles, while the active source and original MEXC error remain visible.
- RSI, EMA 9/20/21/50, ATR, Bollinger Bands, relative volume and local support/resistance.
- Objective completed-candle market structure: confirmed swings, FVG/IFVG zones and retests, liquidity sweeps, CHoCH/MSS, explicit structural invalidation, and auditable confluence components.
- Completed 1m candlestick trigger (engulfing, rejection, ATR/volume impulse or trend-continuation close) must be explicitly confirmed by completed 5m structure and aligned completed 15m trend before any entry can become actionable.
- Validated Spot spread, cumulative 10-level near-book liquidity, coherent provider bundles and receipt-time skew are checked both when a signal is created and immediately before a PAPER position is persisted.
- Optional attributed Trading Economics high-impact USD calendar filter with configurable pre/post blackout windows; when enabled it fails closed on stale/unavailable data and never invents a positive/negative crypto direction.
- Explainable `↑ UP` (expected to finish above the recorded entry), `↓ DOWN` (expected to finish below it), or `WAIT` (no actionable direction) research verdict plus separate completed-candle setup quality for 10m and 30m.
- Focused selected-symbol manual Event Futures terminal with separate 10m/30m cards: market bias versus action, reference/entry/current prices, countdown, completed 1m/5m/15m confirmations, nearest support/resistance, structural invalidation, quality threshold and one prioritized blocker.
- Prospective empirical confidence per BTC/ETH × 10m/30m appears only after the configured decisive sample; before then it is explicitly unavailable rather than invented.
- Autonomous **paper-only** scheduler for BTCUSDT/ETHUSDT: ranks 10m/30m setups, opens at most one position, waits for settlement, then scans again.
- Bankroll-aware sizing for 500–1,000 USDT research accounts with `FLAT`, `ADAPTIVE_CAPPED`, and exact `OBSERVED_10_30_90_270` simulation profiles.
- Stronger setup quality can increase a paper stake from 1× to 1.5× or 2×, but never above the 2% bankroll, configured absolute, available-balance, or exposure cap.
- Persistent SQLite signal, autonomous decision/state, and complete 10m/30m position audit.
- Paper settlement refunds observations arriving more than 30 seconds after the configured horizon.
- Adaptive recovery guard that blocks stale data, absent edge, caps and excessive exposure.
- Responsive local dashboard and `LIVE`, `STALE`, `ERROR`, `UNAVAILABLE` health states.
- Zero third-party runtime dependencies; Node.js standard library only.
- Cross-platform launcher with a single-instance lock, automatic free-port selection, health-gated browser opening and clean shutdown.

## Manual Event Futures signal terminal

Version 0.7.0 makes official Binance Spot market data the primary attributed analysis feed and retains official MEXC Spot as an atomic bundle fallback. Ticker and order-book snapshots refresh every 3 seconds; 1m/5m/15m/1h kline bundles refresh every 5 seconds. Forming candles remain visible in raw chart data but are excluded from signal decisions until the provider close timestamp has passed. Freshness has two independent checks: provider transport/source receipt must remain inside the configured 30-second default, and each timeframe must expose a completed close no older than one full timeframe interval plus that grace. The dashboard shows the latest completed 1m/5m timestamps and their LIVE/STALE status separately from the analysis calculation time.

Each 10m/30m terminal card now starts with a large **technical UP/DOWN percentage split**. This is a deterministic, uncalibrated directional estimate assembled from the completed 1m flow, completed 5m trend/outlook, 15m/1h context, objective market-structure confluence, and correction state. The normalized signed evidence is mapped with `UP = round(clamp(50 + evidence × 42, 8, 92))`; `DOWN = 100 - UP`, so the split always totals exactly 100%. It is deliberately not labeled win probability. Setup quality remains a separate 0–100 rules score, while prospective measured confidence remains unavailable until its minimum real sample is reached.

The 1m engine evaluates an eight-candle completed flow: net movement normalized by ATR, directional move balance, candle-body pressure, wick pressure, momentum acceleration/deceleration, the latest objective trigger, relative volume, RSI and Bollinger context. The 5m engine separately classifies the established trend and a completed-candle outlook (`CONTINUATION`, `REVERSAL_WATCH`, or `RANGE_OR_TRANSITION`) using EMA regime, confirmed structure, recent close slope and EMA9 slope.

Correction handling is explicit. Against the established 5m trend, the engine measures completed 1m pullback depth in ATR/bps, duration and counter-trend bars. It classifies `CORRECTION_STARTING`, `CORRECTION_ACTIVE`, `CORRECTION_END_CONFIRMED`, or `LOCAL_LEVEL_BREAK_CONFIRMED`. The local-break state requires two completed 1m closes beyond the relevant level and blocks entry without falsely declaring the higher-timeframe trend invalid; formal invalidation still requires the declared 5m/15m completed close. Support/resistance interactions are independently classified as approaching, testing, rejected, break pending confirmation, or break confirmed. An active/starting correction or confirmed local level break keeps the setup at WAIT; a correction end requires a completed 1m trigger back in the trend direction.

The v0.7 signal workflow keeps the durable manual lifecycle and applies one auditable gate shared by manual signals and PAPER execution. It does **not** place an order. `READY` means the Spot-proxy research checks passed; it is not an exchange acknowledgement, a verified Event Futures quote, or evidence that an order was accepted. A candidate can become `READY` only when a completed directional 1m pattern is still inside its timestamped grace period, completed 5m structure and completed 15m trend confirm the same direction, no active correction blocks timing, quality and finite invalidation pass, ticker/candles are fresh, and the attributed Spot top of book passes spread, liquidity, provider, and timestamp-coherence limits. Candles, ticker, and order book must come from the same provider before a setup is actionable.

Version 0.6.1's HTTP 429 fix remains in place: each three-second browser refresh reads one aggregate local endpoint, overlapping refreshes are coalesced, and hidden tabs pause polling. Normal browser traffic remains 20 local requests per minute per visible tab while the 180-request safety limit stays active.

The selected-symbol dashboard shows separate 10m and 30m rounds with `↑ UP`, `↓ DOWN`, or neutral market bias and a distinct current setup state. `↑ UP` means the Spot-proxy price is expected to finish above the recorded proxy observation; `↓ DOWN` means below it. `SETUP PROXY VALID ↑ UP/↓ DOWN` appears only during the strict research window; it is not a live-entry instruction. Before any real-world decision the operator must independently verify the active MEXC Event Futures contract, cutoff, direction, quote, payout, liquidity and settlement rules. After the window, the card changes to tracking-only while retaining the original call for audit. The recorded Spot observation, order-book evidence, macro state, 1m trigger, 5m and 15m confirmations, gate decisions, countdown, 10m/30m proxy-resolution time, support/resistance, completed-close invalidation, setup quality and provider attribution are persisted atomically per decision key. While the window is open, the service overlays a fresh shared-policy evaluation on every response; changed spread, liquidity, source coherence, freshness or macro state blocks the setup without altering the original audit snapshot. A previously blocked WAIT candidate is reevaluated while its completed-1m trigger remains current, and the deadline is the earlier of the configured manual window and trigger deadline.

Every candidate is deduplicated by strategy version, symbol, horizon, and all four completed-candle watermarks. READY signals remain immutable until their horizon ends. The first fresh Spot ticker whose source timestamp is at or after the target resolution and no more than 30 seconds late records `PROXY_CORRECT`, `PROXY_INCORRECT`, or `PROXY_TIE`; missing timely data records `NO_TIMELY_OBSERVATION`. These are shadow observations of the attributed underlying Spot proxy and are never labeled as MEXC Event Futures settlements.

Empirical confidence is prospective and separate from setup quality. It is grouped by model version, symbol, and horizon. Before `MANUAL_SIGNAL_MIN_DECISIVE_SAMPLE` outcomes (default 20), the measured percentage and Wilson 95% bounds are both unavailable. At the threshold, the dashboard shows the measured proxy rate, sample size, and interval. `VALIDATED` requires the Wilson lower bound above the break-even reference; `UNDERPERFORMING` requires the upper bound below it; otherwise the segment remains `MONITOR`. With `MANUAL_SIGNAL_CONFIDENCE_GATE_ENABLED=true`, a statistically underperforming segment is held at WAIT. This algorithm can reject demonstrated weak segments, but it cannot guarantee future accuracy or convert Spot observations into Event Futures ground truth.

Signal sound is browser opt-in, defaults off, ignores READY signals already present at page load, and plays only for a newly observed proxy setup that passed all gates inside its research window. Configure `MANUAL_SIGNALS_ENABLED`, `MANUAL_SIGNAL_SCAN_MS`, `MANUAL_SIGNAL_ENTRY_WINDOW_MS`, `MANUAL_SIGNAL_MAX_RESOLUTION_LAG_MS`, `MANUAL_SIGNAL_MIN_DECISIVE_SAMPLE`, and `MANUAL_SIGNAL_CONFIDENCE_GATE_ENABLED` in the environment.

## Signal generation and PAPER execution

Strategy version 0.7.0 exports the enhanced `generateSignals` engine while retaining the prior compatibility name. It evaluates deterministic candidates once per unique set of completed 1m/5m/15m/1h close timestamps. The 10m setup gives maximum weight to the multi-candle 1m flow and 5m trend; the 30m setup gives more weight to 15m/1h context while still requiring a current 1m trigger and 5m confirmation. EMA20/50, FVG/retest, IFVG, confirmed swing sweeps, CHoCH/MSS, Bollinger position, RSI, ATR, relative volume, correction state, level interaction and finite dynamic/structural invalidation remain auditable inputs.

`PaperService.executeTrade` is still PAPER-only. It reruns the complete entry policy immediately before persistence rather than trusting an earlier scan. This blocks stale triggers, changed spread/liquidity, mixed ticker/order-book providers, excessive timestamp skew, a new macro blackout, or any other failed gate between signal generation and the simulated open. Migration 007 stores that exact gate snapshot with the PAPER position. No branch can send an exchange order.

Setup quality (`STANDARD` ≥68, `HIGH` ≥78, `EXCEPTIONAL` ≥88) is a transparent deterministic rules score, **not** a historical or calibrated success probability. Each confluence component records its timeframe, direction, objective definition, active state, and weight. The default `ADAPTIVE_CAPPED` profile starts from 0.5% of current paper equity, applies a 1×/1.5×/2× quality multiplier, and permits at most one calculated recovery. A previous loss can select a recovery stage but can never create a setup. Every exact stake must fit all hard limits; the application blocks rather than silently reduces an unaffordable stake.

Default 500 USDT example at an 80% configured payout:

```text
STANDARD base stake: 2.50 USDT
one calculated recovery after losing 2.50: 5.63 USDT
maximum per-position bankroll fraction: 2% (10 USDT)
daily PAPER stop-at-profit / gross-loss stop: +100 / -10 USDT
```

`OBSERVED_10_30_90_270` reproduces that ladder exactly for comparison, but the same hard limits apply. On the default 500 USDT account its later stages are therefore blocked rather than allowed to endanger most of the simulated bankroll. The remaining all-profile UTC daily loss allowance is included in every new stake cap, so switching profiles cannot reset that safety budget.

Learning and eligibility are reported separately for BTC/ETH × 10m/30m. Each segment remains `WARMUP` until the configured minimum number of decisive autonomous PAPER outcomes (default 20). After that, its Wilson 95% interval is compared with the configured payout break-even rate: a lower bound above break-even is `VALIDATED`, an upper bound below break-even is `UNDERPERFORMING`, and overlapping evidence remains `MONITOR`. When the segment gate is enabled, only an `UNDERPERFORMING` segment is blocked; the scheduler may still select the next-ranked eligible candidate.

The dashboard shows the primary manual signal desk, a dedicated pre-entry gate panel, and the four explanatory setup cards. The gate panel reports completed 1m→5m confirmation, depth-derived Spot spread/liquidity, and macro status as `PASS`, `BLOCKED / WAIT`, or `SKIPPED · DISABLED (not filtered)`. Manual cards persist the key trigger, freshness, spread, top-liquidity, and macro gate results alongside active confluence, invalidation, FVG/IFVG and EMA20/50 chart overlays. Pause/resume controls, profile/stage, active PAPER position, measured P&L, sample-sized win rate, ROI, drawdown, and loss streak remain visible. The +100 USDT default is a **stop-after-profit safety threshold**, not a target the software promises to earn: after realized daily autonomous PAPER profit reaches it, new entries pause for that UTC day. The -10 USDT loss stop and all stake/exposure limits remain independent and active. Daily safety pauses automatically reset on the next UTC day; operator and exhausted-profile pauses require explicit resume.

Configure the simulation in `.env` with `PAPER_INITIAL_BANKROLL` (for example 500 or 1000), `AUTONOMOUS_STAKE_PROFILE`, stake fractions/cap, daily safety limits, thresholds, symbols, horizons, `AUTONOMOUS_SEGMENT_GATE_ENABLED`, and `AUTONOMOUS_SEGMENT_MIN_SAMPLE`. These parameters define a research experiment; they do not create or guarantee a monthly income.

## Critical limitation

No official MEXC Event Futures API for live payout, contracts, exact settlement, positions or execution has been verified. Therefore Event Futures is shown as `UNAVAILABLE`, 80% is a labeled paper configuration, and no live order can be sent. The manual signal desk is designed for the operator to place a signal themselves, but its observed entry and result use the attributed underlying **Spot proxy**, not a proven Event Futures contract feed or settlement index. If MEXC Spot is unreachable, the application may use Binance's public market-data endpoint as an explicitly labeled fallback. Binance values are never represented as MEXC values, and the exact primary-provider error is displayed. The system never replaces missing feeds with invented data.

## Downloaded package: easiest startup

The release archive is self-contained and does not need `npm install`. Install [Node.js 22 LTS](https://nodejs.org/) once, extract the archive, then:

- **Windows:** double-click `START-SIGNAL-EXPERT.cmd`.
- **macOS/Linux:** run `./start-signal-expert.sh` from a terminal.

The launcher validates Node, creates local SQLite storage, finds the first free port starting at `4100`, starts the server on `127.0.0.1`, waits for the health check, and opens the browser. If another Signal Expert instance is already running, it opens that instance instead of starting a conflicting server. Keep the launcher window open and press `Ctrl+C` to stop cleanly. Manual signal scanning and autonomous PAPER shadow tracking are enabled by default and visibly labeled; set `MANUAL_SIGNALS_ENABLED=false` and/or `AUTONOMOUS_ENABLED=false` before startup to disable either workflow.

To choose a preferred port, set `SIGNAL_EXPERT_PORT`; if occupied, the launcher automatically tries the next ports. Set `NO_BROWSER=1` for headless startup.

## Developer startup

Node.js 22.5+ is required. No package installation is needed. The server binds to `127.0.0.1` by default; Docker exposure is an explicit deployment choice.

```bash
cp .env.example .env
npm run db:migrate
npm start
```

Node does not load `.env` automatically; either export the desired values or use the defaults. Open `http://localhost:4100`.

## Docker Compose

```bash
docker compose up --build
```

SQLite data persists in the `signal_expert_data` volume. Docker publishes the dashboard only on host loopback (`127.0.0.1:4100`); autonomous state changes require a same-origin browser request. Stop with `docker compose down`.

## Validation

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Sources

- [MEXC Spot API v3 documentation](https://mexcdevelop.github.io/apidocs/spot_v3_en/) — primary public ticker, depth and kline source; default polling is 3s/15s.
- [Binance Market Data Only documentation](https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only) — independent public fallback at `data-api.binance.vision`, used only when the primary source fails and always attributed in the interface.
- [MEXC Event Futures overview](https://www.mexc.com/es/learn/article/17827791522522) — product description only, not proof of an integration API.

Responses are runtime-validated. Failed, stale or malformed data is surfaced, never silently simulated. When fallback is active, the header changes to `DEGRADED`, the exact MEXC failure is shown, and every raw value identifies Binance as its source. Disable fallback with `MARKET_FAILOVER_ENABLED=false`. External-source descriptions were rephrased for licensing compliance.

## Gate for live Event Futures execution

Real orders are intentionally absent until the authenticated Event Futures integration contract is verified. The exact required Index, payout, contract, idempotency, reconciliation, settlement and secret-handling operations are documented in [`docs/live-execution-gate.md`](docs/live-execution-gate.md). Spot or fallback prices are never used to pretend that an Event Futures order was accepted.

## Security and quantitative limits

No API key, signing, custody, withdrawal or live-execution code exists. Inputs and provider payloads are validated, requests use timeout and bounded backoff, HTTP responses use restrictive security headers, and local API calls are rate-limited.

The directional display combines the 1h higher-timeframe regime, 15m/5m structure, and 1m trigger using EMA 9/21, RSI 14, ATR-normalized impulse, relative volume and wick rejection. The autonomous horizon engine separately enforces 10m/30m structural alignment, ATR volatility and volume context before assigning setup quality. Only candles whose provider close timestamp has passed are admitted to either engine or displayed on the chart; the forming candle is excluded. The displayed UP/DOWN technical split is normalized to exactly 100% (for example, 68%/32%), so independent scores can never misleadingly total above 100. Both that split and setup quality are deterministic, explicitly `UNCALIBRATED` model outputs—not measured Event Futures win probabilities. The v0.6 manual desk exposes a measured percentage only after its prospective Spot-proxy sample reaches the configured minimum; it always includes sample size and Wilson uncertainty and remains explicitly not Event Futures calibration.

```text
required recovery stake = (cumulative loss + target profit) / payout rate
```

A previous loss never creates a new signal, and a recovery is rejected when the required stake cannot mathematically fit risk limits.
