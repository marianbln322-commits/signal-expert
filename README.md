# Signal Expert

Local-first, auditable BTCUSDT/ETHUSDT market analytics and event-futures research. Raw provider data, calculated indicators, uncalibrated estimates, configured paper assumptions and unavailable values are visibly separated.

## Functional scope

- Official public MEXC Spot REST ticker, depth and 1m/5m/15m candles with source/receive timestamps.
- RSI, EMA, ATR, Bollinger Bands, relative volume and local support/resistance.
- Explainable `UP`, `DOWN` or `WAIT` research verdict.
- Persistent SQLite signal audit and complete 10m/30m paper ledger.
- Paper settlement refunds observations arriving more than 30 seconds after the configured horizon.
- Adaptive recovery guard that blocks stale data, absent edge, caps and excessive exposure.
- Responsive local dashboard and `LIVE`, `STALE`, `ERROR`, `UNAVAILABLE` health states.
- Zero third-party runtime dependencies; Node.js standard library only.

## Critical limitation

No official MEXC Event Futures API for live payout, contracts, exact settlement, positions or execution has been verified. Therefore Event Futures is shown as `UNAVAILABLE`, 80% is a labeled paper configuration, and no live order can be sent. The current underlying feed is MEXC **Spot**, not a proven Event Futures settlement index. The system never replaces that missing feed with invented data.

## Run locally

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

- [MEXC Spot API v3 documentation](https://mexcdevelop.github.io/apidocs/spot_v3_en/) — public ticker, depth and kline endpoints; default polling is 3s/15s.
- [MEXC Event Futures overview](https://www.mexc.com/es/learn/article/17827791522522) — product description only, not proof of an integration API.

Responses are runtime-validated. Failed, stale or malformed data is surfaced, never silently simulated. External-source descriptions were rephrased for licensing compliance.

## Security and quantitative limits

No API key, signing, custody, withdrawal or live-execution code exists. Inputs and provider payloads are validated, requests use timeout and bounded backoff, HTTP responses use restrictive security headers, and local API calls are rate-limited.

The model combines EMA 9/21 regime, RSI 14, ATR-normalized impulse, relative volume and wick rejection. Its probability is a bounded heuristic explicitly marked `UNCALIBRATED`; adaptive sizing blocks it by default until prospective outcomes support Brier score, log-loss and calibration analysis.

```text
required recovery stake = (cumulative loss + target profit) / payout rate
```

A previous loss never creates a new signal, and a recovery is rejected when the required stake cannot mathematically fit risk limits.
