import { analyzeMarket } from "./quant.mjs";
const timeframes = ["1m", "5m", "15m"];
const emptyState = () => ({ ticker: null, depth: null, candles: { "1m": null, "5m": null, "15m": null }, analysis: null, lastError: null, lastAttemptAt: null });

export class MarketService {
  constructor({ provider, symbols, staleAfterMs, payoutRate, database }) { this.provider = provider; this.symbols = symbols; this.staleAfterMs = staleAfterMs; this.payoutRate = payoutRate; this.database = database; this.states = new Map(symbols.map((symbol) => [symbol, emptyState()])); this.timers = []; this.tickerBusy = false; this.candleBusy = false; }
  async start(tickerPollMs, candlePollMs) { await Promise.all([this.refreshTickerData(), this.refreshCandleData()]); this.timers.push(setInterval(() => this.refreshTickerData().catch(() => {}), tickerPollMs), setInterval(() => this.refreshCandleData().catch(() => {}), candlePollMs)); }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }
  hasSymbol(symbol) { return this.states.has(symbol); }
  error(error) { return error instanceof Error ? error.message : "Unknown provider error"; }
  audit(symbol, status, envelope, message) { this.database.sourceEvent({ sourceName: envelope?.source ?? this.provider.name, symbol, status, sourceTimestamp: envelope?.sourceTimestamp, receivedAt: new Date().toISOString(), latencyMs: envelope ? Math.max(0, new Date(envelope.receivedAt) - new Date(envelope.sourceTimestamp)) : null, message }); }
  async refreshTickerData() {
    if (this.tickerBusy) return; this.tickerBusy = true;
    try { await Promise.all(this.symbols.map(async (symbol) => { const state = this.states.get(symbol); state.lastAttemptAt = new Date().toISOString(); const [ticker, depth] = await Promise.allSettled([this.provider.ticker(symbol), this.provider.depth(symbol)]); const errors = [];
      if (ticker.status === "fulfilled") { state.ticker = ticker.value; this.audit(symbol, "LIVE", ticker.value); } else { errors.push(this.error(ticker.reason)); this.audit(symbol, "ERROR", null, this.error(ticker.reason)); }
      if (depth.status === "fulfilled") state.depth = depth.value; else errors.push(this.error(depth.reason)); state.lastError = errors.length ? errors.join("; ") : null; }));
    } finally { this.tickerBusy = false; }
  }
  async refreshCandleData() {
    if (this.candleBusy) return; this.candleBusy = true;
    try { await Promise.all(this.symbols.map(async (symbol) => { const state = this.states.get(symbol); state.lastAttemptAt = new Date().toISOString(); const results = await Promise.allSettled(timeframes.map((timeframe) => this.provider.klines(symbol, timeframe))); const errors = []; let complete = true;
      results.forEach((result, index) => { const timeframe = timeframes[index]; if (result.status === "fulfilled") state.candles[timeframe] = result.value; else { complete = false; state.candles[timeframe] = null; errors.push(`${timeframe}: ${this.error(result.reason)}`); } });
      if (complete && timeframes.every((timeframe) => this.status(state.candles[timeframe]) === "LIVE")) {
        const closed = Object.fromEntries(timeframes.map((timeframe) => [timeframe, state.candles[timeframe].data.filter((candle) => candle.closed)]));
        state.analysis = analyzeMarket(closed, this.payoutRate);
        state.analysis.sources = Object.fromEntries(timeframes.map((timeframe) => [timeframe, { source: state.candles[timeframe].source, sourceUrl: state.candles[timeframe].sourceUrl, sourceTimestamp: state.candles[timeframe].sourceTimestamp, receivedAt: state.candles[timeframe].receivedAt }]));
        this.database.insertSignal(symbol, state.analysis, state.candles["1m"].sourceTimestamp);
      } else state.analysis = null;
      if (errors.length) { state.lastError = errors.join("; "); this.audit(symbol, "ERROR", null, state.lastError); }
    })); } finally { this.candleBusy = false; }
  }
  status(envelope) { if (!envelope?.sourceTimestamp || !envelope?.receivedAt) return "UNAVAILABLE"; const now = Date.now(); const source = new Date(envelope.sourceTimestamp).getTime(); const received = new Date(envelope.receivedAt).getTime(); return !Number.isFinite(source) || !Number.isFinite(received) || now - source > this.staleAfterMs || now - received > this.staleAfterMs ? "STALE" : "LIVE"; }
  snapshot(symbol) {
    const state = this.states.get(symbol); if (!state) return null; const marketStatus = this.status(state.ticker); const depthStatus = this.status(state.depth); const candleStatuses = Object.fromEntries(timeframes.map((tf) => [tf, this.status(state.candles[tf])])); const candlesLive = timeframes.every((tf) => candleStatuses[tf] === "LIVE");
    return { symbol, market: state.ticker ? { ...state.ticker, classification: "RAW", status: marketStatus } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" }, orderBook: state.depth ? { ...state.depth, classification: "RAW", status: depthStatus } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" }, candles: Object.fromEntries(timeframes.map((tf) => { const envelope = state.candles[tf]; return [tf, envelope ? { ...envelope, classification: "RAW", status: candleStatuses[tf] } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" }]; })), analysis: candlesLive ? state.analysis : null, eventFutures: { classification: "UNAVAILABLE", status: "UNAVAILABLE", reason: "No official MEXC Event Futures API has been verified for live payout, contracts or execution. Displayed market data is MEXC Spot REST v3 only.", paperPayout: { value: this.payoutRate, classification: "CALCULATED", source: "USER_CONFIGURATION", live: false } }, health: { overall: marketStatus === "LIVE" && candlesLive ? "LIVE" : state.lastError ? "ERROR" : "DEGRADED", market: marketStatus, orderBook: depthStatus, candles: candleStatuses, lastAttemptAt: state.lastAttemptAt, error: state.lastError } };
  }
  sources() { return [{ id: this.provider.sourceId ?? "configured-provider", name: this.provider.name, type: this.provider.official === false ? "CONFIGURED_PROVIDER" : "OFFICIAL_PUBLIC_API", updateFrequency: "Ticker/depth default 3s; klines default 15s", limitations: "Spot underlying data, not Event Futures payout or contracts.", symbols: this.symbols }, { id: "mexc-event-futures", name: "MEXC Event Futures", type: "UNVERIFIED", updateFrequency: null, limitations: "Official integration endpoint not verified; live execution disabled.", symbols: this.symbols }]; }
}
