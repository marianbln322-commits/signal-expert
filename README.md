# Signal Expert

Local-first, auditable BTCUSDT/ETHUSDT market analytics and event-futures research. Raw provider data, calculated indicators, uncalibrated estimates, configured paper assumptions and unavailable values are visibly separated.

## Functional scope

- Official public MEXC Spot REST ticker, depth and completed 1m/5m/15m/1h candles with source/receive timestamps.
- Explicit Binance public market-data fallback when MEXC is unreachable; the active source and original MEXC error are always displayed.
- RSI, EMA 9/20/21/50, ATR, Bollinger Bands, relative volume and local support/resistance.
- Objective completed-candle market structure: confirmed swings, FVG/IFVG zones and retests, liquidity sweeps, CHoCH/MSS, explicit structural invalidation, and auditable confluence components.
- Explainable `UP`, `DOWN` or `WAIT` research verdict plus separate completed-candle setup quality for 10m and 30m.
- Autonomous **paper-only** scheduler for BTCUSDT/ETHUSDT: ranks 10m/30m setups, opens at most one position, waits for settlement, then scans again.
- Bankroll-aware sizing for 500–1,000 USDT research accounts with `FLAT`, `ADAPTIVE_CAPPED`, and exact `OBSERVED_10_30_90_270` simulation profiles.
- Stronger setup quality can increase a paper stake from 1× to 1.5× or 2×, but never above the 2% bankroll, configured absolute, available-balance, or exposure cap.
- Persistent SQLite signal, autonomous decision/state, and complete 10m/30m position audit.
- Paper settlement refunds observations arriving more than 30 seconds after the configured horizon.
- Adaptive recovery guard that blocks stale data, absent edge, caps and excessive exposure.
- Responsive local dashboard and `LIVE`, `STALE`, `ERROR`, `UNAVAILABLE` health states.
- Zero third-party runtime dependencies; Node.js standard library only.
- Cross-platform launcher with a single-instance lock, automatic free-port selection, health-gated browser opening and clean shutdown.

## Autonomous paper strategy

Version 0.3.0 enables the local autonomous scheduler by default only while `TRADING_MODE=paper`. It evaluates deterministic candidates once per unique set of completed 1m/5m/15m/1h candle close timestamps. A 10m setup emphasizes the completed 1m trigger and aligned 5m/15m context; a 30m setup emphasizes 1h/15m structure with 5m confirmation. EMA20/50 context, three-candle fair-value gaps and retests, inverted FVGs, confirmed swing liquidity sweeps, and completed-close CHoCH/MSS events contribute auditable confluence. Every eligible direction also requires a finite, direction-appropriate invalidation level from completed-candle structure. ATR volatility and relative volume remain part of the quality score, and extreme short-term volatility blocks entry.

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

The dashboard shows the four live setup cards, active confluence components, explicit invalidation, FVG/IFVG and EMA20/50 chart overlays, recent autonomous decisions, and segmented measured outcomes. Entry sound is browser opt-in and triggers only for a newly observed autonomous PAPER open after page load. Pause/resume controls, profile/stage, active position, measured P&L, sample-sized win rate, ROI, drawdown, and loss streak remain visible. The +100 USDT default is a **stop-after-profit safety threshold**, not a target the software promises to earn: after realized daily autonomous PAPER profit reaches it, new entries pause for that UTC day. The -10 USDT loss stop and all stake/exposure limits remain independent and active. Daily safety pauses automatically reset on the next UTC day; operator and exhausted-profile pauses require explicit resume.

Configure the simulation in `.env` with `PAPER_INITIAL_BANKROLL` (for example 500 or 1000), `AUTONOMOUS_STAKE_PROFILE`, stake fractions/cap, daily safety limits, thresholds, symbols, horizons, `AUTONOMOUS_SEGMENT_GATE_ENABLED`, and `AUTONOMOUS_SEGMENT_MIN_SAMPLE`. These parameters define a research experiment; they do not create or guarantee a monthly income.

## Critical limitation

No official MEXC Event Futures API for live payout, contracts, exact settlement, positions or execution has been verified. Therefore Event Futures is shown as `UNAVAILABLE`, 80% is a labeled paper configuration, and no live order can be sent—even when the autonomous scheduler is running. The primary underlying feed is MEXC **Spot**, not a proven Event Futures settlement index. If MEXC Spot is unreachable, the application may use Binance's public market-data endpoint as an explicitly labeled fallback. Binance values are never represented as MEXC values, and the exact primary-provider error is displayed. The system never replaces missing feeds with invented data.

## Downloaded package: easiest startup

The release archive is self-contained and does not need `npm install`. Install [Node.js 22 LTS](https://nodejs.org/) once, extract the archive, then:

- **Windows:** double-click `START-SIGNAL-EXPERT.cmd`.
- **macOS/Linux:** run `./start-signal-expert.sh` from a terminal.

The launcher validates Node, creates local SQLite storage, finds the first free port starting at `4100`, starts the server on `127.0.0.1`, waits for the health check, and opens the browser. If another Signal Expert instance is already running, it opens that instance instead of starting a conflicting server. Keep the launcher window open and press `Ctrl+C` to stop cleanly. Autonomous paper scanning is enabled by default and is visibly labeled `PAPER ONLY`; use the dashboard pause button or set `AUTONOMOUS_ENABLED=false` before startup to disable it.

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

The directional display combines the 1h higher-timeframe regime, 15m/5m structure, and 1m trigger using EMA 9/21, RSI 14, ATR-normalized impulse, relative volume and wick rejection. The autonomous horizon engine separately enforces 10m/30m structural alignment, ATR volatility and volume context before assigning setup quality. Only candles whose provider close timestamp has passed are admitted to either engine or displayed on the chart; the forming candle is excluded. The displayed UP/DOWN technical split is normalized to exactly 100% (for example, 68%/32%), so independent scores can never misleadingly total above 100. Both that split and autonomous setup quality are deterministic, explicitly `UNCALIBRATED` model outputs—not measured Event Futures win probabilities. Measured win rate appears only after autonomous paper positions settle and always includes its sample size.

```text
required recovery stake = (cumulative loss + target profit) / payout rate
```

A previous loss never creates a new signal, and a recovery is rejected when the required stake cannot mathematically fit risk limits.
