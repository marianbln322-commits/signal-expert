# Gate for real MEXC Event Futures orders

Signal Expert does not currently send real orders. Real execution may be enabled only after the exact authenticated MEXC Event Futures contract is verified. Standard MEXC Spot/Futures APIs and Binance fallback data are not substitutes for the Event Futures product shown in the screenshots.

## Required verified operations

An execution adapter must provide all of these operations with documented request/response examples:

1. `listContracts(symbol)` — active 10m/30m Event Futures contracts, server timestamps, entry cutoff and resolution timestamp.
2. `getIndexPrice(symbol)` — the same Index value displayed by Event Futures, with source timestamp and freshness guarantees.
3. `getPayout(contractId)` — current UP/DOWN payout and whether payout locks at order acceptance.
4. `placePrediction(contractId, direction, quantity, clientRequestId)` — authenticated idempotent order placement.
5. `getOrder(clientRequestId)` — accepted/rejected/unknown status and authoritative entry price.
6. `listOpenPositions()` — restart reconciliation without trusting local state.
7. `getSettlement(positionId)` — authoritative result, settlement index, timestamp and amount.
8. `cancelOrder()` — only if Event Futures supports cancellation before acceptance.

## Authentication and secret handling

- Prefer an official API key restricted to trading and IP, with withdrawals disabled.
- Secrets must remain in the local environment/OS secret store and never enter Git, logs, browser storage or screenshots.
- If MEXC exposes no official API, authenticated browser endpoints must be reviewed against MEXC terms before implementation. Session cookies, passwords and two-factor secrets must never be shared in chat or committed.

## Safety contract

Live mode must remain impossible unless all gates pass at startup:

- primary Event Futures Index and payout are fresh;
- server clock skew is measured and within tolerance;
- reconciliation succeeds;
- persistent kill switch is clear;
- daily loss, stake, simultaneous-position and correlated-exposure limits are configured;
- idempotency is proven by integration tests;
- `SHADOW` and `PAPER_AUTO` evaluation meets a user-approved sample-size/calibration threshold;
- a separate explicit local configuration enables `LIVE_MINIMUM`.

The v0.4.0 manual signal desk may tell the operator `ENTER UP NOW` or `ENTER DOWN NOW` only inside its timestamped entry window. This is not an order acknowledgement: the application has no MEXC credential, account, signing, or placement method. The recorded entry and horizon outcome are attributed Spot-proxy observations classified `NOT_EVENT_FUTURES_SETTLEMENT`. Setup quality remains a deterministic rules score, not probability. A measured confidence percentage remains unavailable until the prospective symbol+horizon sample reaches its configured minimum, then includes a Wilson 95% interval and the explicit classification `SPOT_PROXY_PROSPECTIVE_OUTCOMES_NOT_EVENT_FUTURES_CALIBRATION`.

The completed-candle model uses 1h context, 15m/5m structure and a 1m trigger to rank separate 10m/30m setups. Forming candles are excluded and deterministic close-time keys prevent duplicate signals. EMA20/50, FVG/IFVG, liquidity sweep, CHoCH/MSS and explicit finite invalidation components are objective and auditable. A statistically UNDERPERFORMING manual segment can be held at WAIT, but no algorithm can guarantee future accuracy or substitute Spot outcomes for the product's authoritative settlement.

The autonomous v0.3 strategy remains a local PAPER shadow experiment. A previous loss does not create a new signal, no simulation profile may bypass risk limits, and the configured daily stop-at-profit is a safety pause rather than promised income.
