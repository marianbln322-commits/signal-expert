# Signal Expert

Local-first, auditable BTCUSDT/ETHUSDT market analytics and event-futures research. Raw provider data, calculated indicators, uncalibrated estimates, configured paper assumptions and unavailable values are visibly separated.

## Functional scope

- Official public MEXC Spot REST ticker, depth and completed 1m/5m/15m/1h candles with source/receive timestamps.
- Explicit Binance public market-data fallback when MEXC is unreachable; the active source and original MEXC error are always displayed.
- RSI, EMA, ATR, Bollinger Bands, relative volume and local support/resistance.
- Explainable `UP`, `DOWN` or `WAIT` research verdict.
- Persistent SQLite signal audit and complete 10m/30m paper ledger.
- Paper settlement refunds observations arriving more than 30 seconds after the configured horizon.
- Adaptive recovery guard that blocks stale data, absent edge, caps and excessive exposure.
- Responsive local dashboard and `LIVE`, `STALE`, `ERROR`, `UNAVAILABLE` health states.
- Zero third-party runtime dependencies; Node.js standard library only.
- Cross-platform launcher with a single-instance lock, automatic free-port selection, health-gated browser opening and clean shutdown.

## Critical limitation

No official MEXC Event Futures API for live payout, contracts, exact settlement, positions or execution has been verified. Therefore Event Futures is shown as `UNAVAILABLE`, 80% is a labeled paper configuration, and no live order can be sent. The primary underlying feed is MEXC **Spot**, not a proven Event Futures settlement index. If MEXC Spot is unreachable, the application may use Binance's public market-data endpoint as an explicitly labeled fallback. Binance values are never represented as MEXC values, and the exact primary-provider error is displayed. The system never replaces missing feeds with invented data.

## Downloaded package: easiest startup

The release archive is self-contained and does not need `npm install`. Install [Node.js 22 LTS](https://nodejs.org/) once, extract the archive, then:

- **Windows:** double-click `START-SIGNAL-EXPERT.cmd`.
- **macOS/Linux:** run `./start-signal-expert.sh` from a terminal.

The launcher validates Node, creates local SQLite storage, finds the first free port starting at `4100`, starts the server on `127.0.0.1`, waits for the health check, and opens the browser. If another Signal Expert instance is already running, it opens that instance instead of starting a conflicting server. Keep the launcher window open and press `Ctrl+C` to stop cleanly.

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

SQLite data persists in the `signal_expert_data` volume. Stop with `docker compose down`.

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

The model combines the 1h higher-timeframe regime, 15m/5m structure, and 1m trigger using EMA 9/21, RSI 14, ATR-normalized impulse, relative volume and wick rejection. Only candles whose provider close timestamp has passed are admitted to the model or displayed on the chart; the forming candle is excluded. The displayed UP/DOWN technical split is normalized to exactly 100% (for example, 68%/32%), so independent scores can never misleadingly total above 100. It is a deterministic technical estimate explicitly marked `UNCALIBRATED`, not a measured Event Futures win probability; adaptive sizing blocks it by default until prospective outcomes support Brier score, log-loss and calibration analysis.

```text
required recovery stake = (cumulative loss + target profit) / payout rate
```

A previous loss never creates a new signal, and a recovery is rejected when the required stake cannot mathematically fit risk limits.
