import { analyzeMarket } from "./quant.mjs";
import { deriveOrderBookMetrics, evaluateEntryGates } from "./entry-gates.mjs";
const timeframes = ["1m", "5m", "15m", "1h"];
const emptyState = () => ({
  ticker: null, depth: null, candles: { "1m": null, "5m": null, "15m": null, "1h": null }, analysis: null,
  errors: { ticker: null, depth: null, candles: {} }, lastAttemptAt: null,
});

export class MarketService {
  constructor({ provider, symbols, staleAfterMs, payoutRate, database, candidateThresholds, eventRisk, entryPolicy }) {
    this.provider = provider; this.symbols = symbols; this.staleAfterMs = staleAfterMs; this.payoutRate = payoutRate; this.database = database; this.candidateThresholds = candidateThresholds;
    this.eventRisk = eventRisk; this.entryPolicy = entryPolicy;
    this.states = new Map(symbols.map((symbol) => [symbol, emptyState()])); this.timers = []; this.tickerBusy = false; this.candleBusy = false;
  }
  async start(tickerPollMs, candlePollMs) {
    await Promise.all([this.refreshTickerData(), this.refreshCandleData()]);
    this.timers.push(setInterval(() => this.refreshTickerData().catch(() => {}), tickerPollMs), setInterval(() => this.refreshCandleData().catch(() => {}), candlePollMs));
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
  hasSymbol(symbol) { return this.states.has(symbol); }
  error(error) { return error instanceof Error ? error.message : "Unknown provider error"; }
  audit(symbol, status, envelope, message) {
    this.database.sourceEvent({ sourceName: envelope?.source ?? this.provider.name, symbol, status, sourceTimestamp: envelope?.sourceTimestamp, receivedAt: new Date().toISOString(), latencyMs: envelope ? Math.max(0, new Date(envelope.receivedAt) - new Date(envelope.sourceTimestamp)) : null, message });
  }
  async refreshTickerData() {
    if (this.tickerBusy) return; this.tickerBusy = true;
    try {
      await Promise.all(this.symbols.map(async (symbol) => {
        const state = this.states.get(symbol); state.lastAttemptAt = new Date().toISOString();
        try {
          const bundle = typeof this.provider.tickerDepth === "function"
            ? await this.provider.tickerDepth(symbol)
            : await Promise.all([this.provider.ticker(symbol), this.provider.depth(symbol)]).then(([ticker, depth]) => ({ ticker, depth }));
          state.ticker = bundle.ticker; state.depth = bundle.depth; state.errors.ticker = null; state.errors.depth = null;
          this.audit(symbol, "LIVE", bundle.ticker, bundle.ticker.failover?.active ? bundle.ticker.failover.primaryError : null);
        } catch (error) {
          const message = this.error(error);
          state.ticker = null; state.depth = null; state.errors.ticker = message; state.errors.depth = message;
          this.audit(symbol, "ERROR", null, message);
        }
      }));
    } finally { this.tickerBusy = false; }
  }
  async refreshCandleData() {
    if (this.candleBusy) return; this.candleBusy = true;
    try {
      await Promise.all(this.symbols.map(async (symbol) => {
        const state = this.states.get(symbol); state.lastAttemptAt = new Date().toISOString();
        try {
          const envelopes = typeof this.provider.klinesSet === "function"
            ? await this.provider.klinesSet(symbol, timeframes)
            : await Promise.all(timeframes.map((timeframe) => this.provider.klines(symbol, timeframe))).then((items) => Object.fromEntries(timeframes.map((timeframe, index) => [timeframe, items[index]])));
          for (const timeframe of timeframes) { state.candles[timeframe] = envelopes[timeframe]; delete state.errors.candles[timeframe]; }
          const live = timeframes.every((timeframe) => this.status(state.candles[timeframe]) === "LIVE");
          const sources = new Set(timeframes.map((timeframe) => state.candles[timeframe]?.source));
          if (live && sources.size === 1) {
            const closed = Object.fromEntries(timeframes.map((timeframe) => [timeframe, state.candles[timeframe].data.filter((candle) => candle.closed)]));
            state.analysis = analyzeMarket(closed, this.payoutRate, new Date(), { symbol, thresholds: this.candidateThresholds, triggerGraceMs: this.entryPolicy.triggerGraceMs });
            state.analysis.sources = Object.fromEntries(timeframes.map((timeframe) => [timeframe, { source: state.candles[timeframe].source, sourceName: state.candles[timeframe].sourceName, sourceUrl: state.candles[timeframe].sourceUrl, sourceTimestamp: state.candles[timeframe].sourceTimestamp, receivedAt: state.candles[timeframe].receivedAt, failover: state.candles[timeframe].failover }]));
            this.database.insertSignal(symbol, state.analysis, state.candles["1m"].sourceTimestamp);
          } else {
            state.analysis = null;
            if (sources.size > 1) for (const timeframe of timeframes) state.errors.candles[timeframe] = "Candle timeframes came from mixed providers; analysis fails closed.";
          }
        } catch (error) {
          const message = this.error(error); state.analysis = null;
          for (const timeframe of timeframes) { state.candles[timeframe] = null; state.errors.candles[timeframe] = message; }
        }
        const candleErrors = Object.entries(state.errors.candles).map(([timeframe, message]) => `${timeframe}: ${message}`);
        if (candleErrors.length) this.audit(symbol, "ERROR", null, candleErrors.join("; "));
      }));
    } finally { this.candleBusy = false; }
  }
  status(envelope) {
    if (!envelope?.sourceTimestamp || !envelope?.receivedAt) return "UNAVAILABLE";
    const now = Date.now(); const source = new Date(envelope.sourceTimestamp).getTime(); const received = new Date(envelope.receivedAt).getTime();
    return !Number.isFinite(source) || !Number.isFinite(received) || now - source > this.staleAfterMs || now - received > this.staleAfterMs ? "STALE" : "LIVE";
  }
  diagnostics(state) {
    const errors = [state.errors.ticker && `ticker: ${state.errors.ticker}`, state.errors.depth && `order book: ${state.errors.depth}`, ...Object.entries(state.errors.candles).map(([timeframe, message]) => `${timeframe} candles: ${message}`)].filter(Boolean);
    const envelopes = [state.ticker, state.depth, ...timeframes.map((timeframe) => state.candles[timeframe])].filter(Boolean);
    const failovers = envelopes.map((envelope) => envelope.failover).filter((failover) => failover?.active);
    const uniquePrimaryErrors = [...new Set(failovers.map((failover) => failover.primaryError))];
    return {
      errors,
      fallbackActive: failovers.length > 0,
      activeSources: [...new Set(envelopes.map((envelope) => envelope.source))],
      primaryErrors: uniquePrimaryErrors,
      message: failovers.length ? `Primary MEXC feed unavailable. Using explicitly attributed ${failovers[0].fallbackName} data. ${uniquePrimaryErrors.join("; ")}` : errors.join("; ") || null,
    };
  }
  snapshot(symbol) {
    const state = this.states.get(symbol); if (!state) return null;
    const marketStatus = this.status(state.ticker); const depthStatus = this.status(state.depth);
    const candleStatuses = Object.fromEntries(timeframes.map((timeframe) => [timeframe, this.status(state.candles[timeframe])]));
    const candleSources = timeframes.map((timeframe) => state.candles[timeframe]?.source).filter(Boolean);
    const analysisCoherent = candleSources.length === timeframes.length && new Set(candleSources).size === 1;
    const candleSource = analysisCoherent ? candleSources[0] : null;
    const candlesLive = timeframes.every((timeframe) => candleStatuses[timeframe] === "LIVE");
    const baseLive = marketStatus === "LIVE" && candlesLive;
    const dataUsable = baseLive && analysisCoherent && !state.errors.ticker && Object.keys(state.errors.candles).length === 0;
    const provider = this.diagnostics(state);
    const orderBookMetrics = deriveOrderBookMetrics(state.depth);
    const eventRisk = this.eventRisk.status();
    const entryPolicy = this.entryPolicyFor(symbol);
    const receiptTimes = [state.ticker?.receivedAt, state.depth?.receivedAt].map((value) => new Date(value).getTime());
    const sourceSkewMs = receiptTimes.every(Number.isFinite) ? Math.abs(receiptTimes[0] - receiptTimes[1]) : null;
    const sameEntrySource = Boolean(state.ticker?.source && state.ticker.source === state.depth?.source);
    const actionSourceCoherent = Boolean(sameEntrySource && candleSource && state.ticker.source === candleSource);
    const entryCoherent = sameEntrySource && sourceSkewMs !== null && sourceSkewMs <= entryPolicy.maxSourceSkewMs;
    const entryMarketReady = dataUsable && !state.errors.depth && depthStatus === "LIVE" && orderBookMetrics.valid && orderBookMetrics.spreadBps <= entryPolicy.maxSpreadBps && orderBookMetrics.topNotional >= entryPolicy.minTopNotional && entryCoherent && actionSourceCoherent && (!entryPolicy.eventRiskEnabled || eventRisk.allowed === true);
    const overall = dataUsable ? (provider.fallbackActive || provider.errors.length ? "DEGRADED" : "LIVE") : provider.errors.length ? "ERROR" : "DEGRADED";
    return {
      symbol,
      market: state.ticker ? { ...state.ticker, classification: "RAW", status: marketStatus } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" },
      orderBook: state.depth ? { ...state.depth, metrics: orderBookMetrics, classification: "RAW", status: depthStatus } : { metrics: orderBookMetrics, classification: "UNAVAILABLE", status: "UNAVAILABLE" },
      candles: Object.fromEntries(timeframes.map((timeframe) => { const envelope = state.candles[timeframe]; return [timeframe, envelope ? { ...envelope, classification: "RAW", status: candleStatuses[timeframe] } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" }]; })),
      analysis: candlesLive ? state.analysis : null,
      eventRisk,
      entryPolicy: { ...entryPolicy, classification: "CONFIGURED_ENTRY_GATE_NOT_EVENT_FUTURES_LIQUIDITY" },
      eventFutures: { classification: "UNAVAILABLE", status: "UNAVAILABLE", reason: "No official MEXC Event Futures API has been verified for live payout, contracts or execution. The active underlying Spot source is identified next to every value.", paperPayout: { value: this.payoutRate, classification: "CALCULATED", source: "USER_CONFIGURATION", live: false } },
      health: { overall, dataUsable, entryMarketReady, analysisCoherent, actionSourceCoherent, entryCoherent, market: marketStatus, orderBook: depthStatus, candles: candleStatuses, provider, sourceSkewMs, sameEntrySource, candleSource, lastAttemptAt: state.lastAttemptAt, error: provider.errors.join("; ") || null },
    };
  }
  entryPolicyFor(symbol) {
    return {
      ...this.entryPolicy,
      maxSpreadBps: this.entryPolicy.maxSpreadBpsBySymbol[symbol],
    };
  }
  evaluateEntry(candidate, now = new Date()) {
    const snapshot = this.snapshot(candidate?.symbol);
    if (!snapshot) return { allowed: false, classification: "AUDITABLE_ENTRY_POLICY_PAPER_AND_MANUAL_ONLY", policyVersion: "entry-gates-v0.6.0", evaluatedAt: now.toISOString(), checks: [{ code: "SYMBOL", status: "BLOCKED", reason: "Symbol is not configured.", evidence: null }] };
    return evaluateEntryGates({ snapshot, candidate, policy: this.entryPolicyFor(candidate.symbol), now });
  }
  sources() {
    const providers = this.provider.providers ?? [this.provider];
    return [
      ...providers.map((provider, index) => ({ id: provider.sourceId ?? `provider-${index}`, name: provider.name, role: index === 0 ? "PRIMARY" : "FALLBACK", type: provider.official ? "OFFICIAL_PUBLIC_API" : "CONFIGURED_PROVIDER", updateFrequency: "Ticker/depth default 3s; klines default 15s", limitations: index === 0 ? "MEXC Spot underlying data, not Event Futures payout or contracts." : "Independent Spot fallback; prices may differ from the MEXC Event Futures settlement index.", symbols: this.symbols })),
      { id: "mexc-event-futures", name: "MEXC Event Futures", role: "UNAVAILABLE", type: "UNVERIFIED", updateFrequency: null, limitations: "Official integration endpoint not verified; live execution disabled.", symbols: this.symbols },
      this.eventRisk.source(),
    ];
  }
}
