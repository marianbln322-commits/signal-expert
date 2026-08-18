import { analyzeMarket } from "./quant.mjs";
import { deriveOrderBookMetrics, evaluateEntryGates } from "./entry-gates.mjs";
import { explainReadiness } from "./readiness.mjs";
import { OrderBookService } from "./order-book-service.mjs";
import { OrderFlowAnalyzer } from "./order-flow.mjs";

const timeframes = ["1m", "5m", "15m", "1h"];
const intervalMilliseconds = { "1m": 60000, "5m": 300000, "15m": 900000, "1h": 3600000 };
const emptyState = () => ({
  ticker: null, depth: null, candles: { "1m": null, "5m": null, "15m": null, "1h": null }, analysis: null,
  errors: { ticker: null, depth: null, candles: {} }, lastAttemptAt: null,
});

export class MarketService {
  constructor({ provider, symbols, staleAfterMs, payoutRate, database, candidateThresholds, eventRisk, entryPolicy, stream = null, streamEnabled = false, observability = null, operationalService = null, alertService = null, structureState = null, orderBook = null, orderFlow = null, reconcileMs = 60000 }) {
    this.provider = provider; this.symbols = symbols; this.staleAfterMs = staleAfterMs; this.payoutRate = payoutRate; this.database = database; this.candidateThresholds = candidateThresholds;
    this.eventRisk = eventRisk; this.entryPolicy = entryPolicy; this.stream = stream; this.streamEnabled = streamEnabled && Boolean(stream); this.observability = observability; this.operationalService = operationalService; this.alertService = alertService; this.structureState = structureState; this.reconcileMs = reconcileMs;
    this.primarySourceId = provider.primary?.sourceId ?? provider.sourceId ?? null;
    const primaryProvider = provider.primary ?? provider;
    const fallbackProvider = provider.fallback ?? null;
    this.orderBook = orderBook ?? new OrderBookService({ symbols, provider: primaryProvider, fallbackProvider, depthLimit: 5000, topLevelLimit: 20 });
    this.orderFlow = orderFlow ?? new OrderFlowAnalyzer({ symbols, staleAfterMs, tradeStaleAfterMs: staleAfterMs });
    this.states = new Map(symbols.map((symbol) => [symbol, emptyState()])); this.timers = []; this.tickerBusy = false; this.candleBusy = false; this.bookSync = new Map(); this.lastFlowStatus = new Map(); this.flowBookIdentity = new Map(); this.flowTickerIdentity = new Map();
  }
  async start(tickerPollMs, candlePollMs) {
    if (this.streamEnabled) {
      for (const symbol of this.symbols) {
        for (const channel of ["TRADE", "BOOK_TICKER", "DEPTH", "KLINE_1M", "KLINE_5M"]) this.observability?.update(symbol, channel, { status: "STARTING" });
        this.orderBook.beginBootstrap(symbol);
      }
      this.stream.start({
        onTrade: (event) => this.ingestTrade(event),
        onBookTicker: (event) => this.ingestBookTicker(event),
        onDepth: (event) => this.ingestDepth(event),
        onKline: (event) => this.ingestKline(event),
        onClose: () => {
          for (const symbol of this.symbols) this.invalidateOrderFlow(symbol, "Binance stream disconnected; continuous aggressor-trade coverage must rebuild.");
        },
        onError: (error) => console.error(JSON.stringify({ level: "error", event: "binance_stream_error", message: this.error(error) })),
      });
    }
    await Promise.all([this.refreshTickerData(), this.refreshCandleData(), ...(this.streamEnabled ? this.symbols.map((symbol) => this.synchronizeOrderBook(symbol, true)) : [])]);
    this.timers.push(setInterval(() => this.refreshTickerData().catch(() => {}), tickerPollMs));
    this.timers.push(setInterval(() => this.refreshCandleData().catch(() => {}), this.streamEnabled ? this.reconcileMs : candlePollMs));
    if (this.streamEnabled) this.timers.push(setInterval(() => this.observability?.checkStale(), Math.max(1000, Math.floor(this.staleAfterMs / 3))));
  }
  async stop() { this.timers.forEach(clearInterval); this.timers = []; await this.stream?.stop(); this.orderBook.resetAll("Market service stopped."); this.orderFlow.resetAll("Market service stopped."); }
  hasSymbol(symbol) { return this.states.has(symbol); }
  error(error) { return error instanceof Error ? error.message : "Unknown provider error"; }
  audit(symbol, status, envelope, message) {
    this.database.sourceEvent({ sourceName: envelope?.source ?? this.provider.name, symbol, status, sourceTimestamp: envelope?.sourceTimestamp, receivedAt: new Date().toISOString(), latencyMs: envelope ? Math.max(0, new Date(envelope.receivedAt) - new Date(envelope.sourceTimestamp)) : null, message });
  }
  acceptsPrimaryStream(state, envelope) { return Boolean(envelope && this.primarySourceId && envelope.source === this.primarySourceId && envelope.failover?.active !== true); }
  observeEnvelope(symbol, channel, envelope, input = {}) {
    if (!envelope || !this.operationalService) return;
    this.operationalService.message(symbol, channel, {
      eventAt: envelope.sourceTimestamp,
      receivedAt: envelope.receivedAt,
      failover: envelope.failover ?? { active: false },
      ...input,
    });
  }
  emitAnalysisAlerts(symbol, analysis) {
    if (!this.alertService || !analysis) return;
    const observedAt = analysis.calculatedAt ?? new Date().toISOString();
    for (const candidate of analysis.candidates ?? []) {
      const entity = `${symbol}.${candidate.horizonMinutes}M`;
      const payload = { symbol, horizonMinutes: candidate.horizonMinutes, decisionKey: candidate.decisionKey, classification: "PAPER_RESEARCH_ANALYTICS_ALERT", liveExecutionAvailable: false };
      this.alertService.direction({ scope: "ENGINE", entity, symbol, channel: "ANALYSIS", previousState: "UNINITIALIZED", state: candidate.setupDirection ?? candidate.direction ?? "WAIT", observedAt, payload });
      this.alertService.regime({ scope: "ENGINE", entity, symbol, channel: "ANALYSIS", previousState: "UNINITIALIZED", state: candidate.extendedRegime?.regime ?? candidate.marketRegime?.canonical ?? candidate.marketRegime?.phase ?? "UNAVAILABLE", observedAt, payload: { ...payload, regime: candidate.extendedRegime ?? candidate.marketRegime ?? null } });
      this.alertService.correction({ scope: "ENGINE", entity, symbol, channel: "ANALYSIS", previousState: "UNINITIALIZED", state: candidate.correction?.status ?? "UNAVAILABLE", observedAt, payload: { ...payload, correction: candidate.correction ?? null } });
      for (const side of ["support", "resistance"]) this.alertService.level({ scope: "ENGINE", entity: `${entity}.${side.toUpperCase()}`, symbol, channel: "ANALYSIS", previousState: "UNINITIALIZED", state: candidate.levelInteractions?.[side]?.status ?? "UNAVAILABLE", observedAt, payload: { ...payload, side, interaction: candidate.levelInteractions?.[side] ?? null } });
    }
  }
  updateTickerProviderBoundary(symbol, envelope) {
    if (!this.streamEnabled) return;
    const identity = envelope ? `${envelope.source ?? "UNAVAILABLE"}:${envelope.failover?.active === true ? "FALLBACK" : "PRIMARY"}` : "UNAVAILABLE";
    const previous = this.flowTickerIdentity.get(symbol);
    this.flowTickerIdentity.set(symbol, identity);
    if (!previous || previous === identity) return;
    this.orderFlow.reset(symbol, `Ticker provider boundary changed from ${previous} to ${identity}; accepted aggregate-trade continuity must rebuild.`);
    this.lastFlowStatus.set(symbol, "UNAVAILABLE");
    this.publishCanonicalBook(symbol);
  }
  publishCanonicalBook(symbol) {
    const state = this.states.get(symbol); if (!state) return null;
    const book = this.orderBook.snapshot(symbol);
    state.depth = { ...book, transport: book.status === "FALLBACK" ? "REST_FALLBACK" : "BINANCE_DIFF_DEPTH_100MS_REST_SNAPSHOT_SYNC" };
    const identity = `${book.source ?? "UNAVAILABLE"}:${book.status}`;
    const previousIdentity = this.flowBookIdentity.get(symbol);
    if (previousIdentity && previousIdentity !== identity) this.orderFlow.reset(symbol, `Order-book source boundary changed from ${previousIdentity} to ${identity}.`);
    this.flowBookIdentity.set(symbol, identity);
    if (book.synchronized) this.orderFlow.ingestBookSnapshot(book);
    this.refreshFlowReadiness(symbol);
    return book;
  }
  orderFlowSnapshot(symbol, state = this.states.get(symbol)) {
    const snapshot = this.orderFlow.snapshot(symbol);
    if (!this.streamEnabled || this.acceptsPrimaryStream(state, state?.ticker)) return snapshot;
    return {
      ...snapshot,
      status: "REST_FALLBACK",
      reason: "Order flow is unavailable while the active reconciled ticker is not Binance primary; providers are not mixed.",
      imbalance: null,
      aggressorVolume: null,
      cvd: null,
      absorption: null,
      replenishment: null,
      disappearingLiquidity: null,
      spreadInstability: null,
      microprice: null,
      spoofRisk: null,
      freshness: { ...(snapshot.freshness ?? {}), status: "REST_FALLBACK" },
    };
  }
  refreshFlowReadiness(symbol) {
    const flow = this.orderFlowSnapshot(symbol);
    const previous = this.lastFlowStatus.get(symbol);
    this.lastFlowStatus.set(symbol, flow.status);
    if (flow.status === "LIVE" && ["GAP", "ERROR"].includes(this.observability?.channelStatus(symbol, "TRADE"))) this.observability.reconciled(symbol, "TRADE", { method: "CONTIGUOUS_AGGTRADE_WINDOW", coverageMs: flow.freshness?.trades?.continuity?.coverageMs, requiredMs: flow.freshness?.trades?.continuity?.requiredMs });
    if (flow.status === "LIVE" && previous !== "LIVE") this.recalculate(symbol);
    return flow;
  }
  invalidateOrderFlow(symbol, reason) {
    const flow = this.orderFlow.reset(symbol, reason);
    this.lastFlowStatus.set(symbol, flow.status);
    this.recalculate(symbol);
    return flow;
  }
  async synchronizeOrderBook(symbol, force = false) {
    if (this.bookSync.has(symbol)) return this.bookSync.get(symbol);
    const current = this.orderBook.status(symbol);
    if (!force && ["LIVE", "SYNCING", "BOOTSTRAPPING", "BUFFERING"].includes(current.status)) return current;
    const operation = this.orderBook.bootstrap(symbol, this.provider.primary ?? this.provider)
      .then((result) => {
        const book = this.publishCanonicalBook(symbol);
        this.operationalService?.depth(symbol, "DEPTH", book?.synchronized === true && book?.status === "LIVE", { eventAt: book?.sourceTimestamp, receivedAt: book?.receivedAt, sequence: book?.data?.lastUpdateId, detectSequence: false, failover: book?.failover ?? { active: false }, reason: book?.reason ?? result.reason });
        if (book?.status === "LIVE" && book.synchronized) {
          this.observability?.message(symbol, "DEPTH", { eventAt: new Date(book.sourceTimestamp).getTime(), sequence: book.data.lastUpdateId, trackOperational: false });
          if (["GAP", "ERROR"].includes(this.observability?.channelStatus(symbol, "DEPTH"))) this.observability.reconciled(symbol, "DEPTH", { method: "BINANCE_SNAPSHOT_DIFF_DEPTH_BRIDGE", lastUpdateId: book.data.lastUpdateId });
        } else this.observability?.update(symbol, "DEPTH", { status: "RECOVERING", lastError: book?.reason ?? result.reason });
        return result;
      })
      .catch((error) => {
        this.operationalService?.depth(symbol, "DEPTH", false, { observedAt: new Date().toISOString(), reason: this.error(error) });
        this.observability?.invalid(symbol, "DEPTH", { reason: this.error(error) });
        return { accepted: false, synchronized: false, reason: "BOOTSTRAP_ERROR", error };
      })
      .finally(() => this.bookSync.delete(symbol));
    this.bookSync.set(symbol, operation);
    return operation;
  }
  ingestDepth(event) {
    const state = this.states.get(event.symbol); if (!state) return;
    const result = this.orderBook.ingestDepth(event);
    const depthFault = ["SEQUENCE_GAP", "PREVIOUS_ID_GAP", "INVALID_BOOK", "BUFFER_OVERFLOW"].includes(result.reason);
    this.operationalService?.message(event.symbol, "DEPTH", { eventAt: event.eventTime, receivedAt: new Date().toISOString(), sequence: event.finalUpdateId, detectSequence: false, duplicate: ["DUPLICATE", "DUPLICATE_BUFFERED", "STALE"].includes(result.reason), outOfOrder: result.reason === "OUT_OF_ORDER" || result.continuity === "OUT_OF_ORDER", gap: depthFault, depthSynced: result.applied === true ? true : depthFault ? false : undefined });
    if (result.applied) {
      const book = this.publishCanonicalBook(event.symbol);
      this.observability?.message(event.symbol, "DEPTH", { eventAt: event.eventTime, sequence: event.finalUpdateId, trackOperational: false });
      if (["GAP", "ERROR"].includes(this.observability?.channelStatus(event.symbol, "DEPTH"))) this.observability.reconciled(event.symbol, "DEPTH", { method: "BINANCE_CONTINUOUS_DEPTH_RESYNC", lastUpdateId: book?.data?.lastUpdateId });
      return;
    }
    if (result.reason === "FALLBACK_BUFFERED") {
      this.observability?.update(event.symbol, "DEPTH", { status: "RECOVERING", lastError: "Binance depth arrived while a REST fallback book was active; a Binance snapshot is required before deltas can apply.", lastContinuity: result.continuity });
      void this.synchronizeOrderBook(event.symbol, true);
    } else if (["SEQUENCE_GAP", "PREVIOUS_ID_GAP", "INVALID_BOOK", "BUFFER_OVERFLOW"].includes(result.reason)) {
      this.orderFlow.reset(event.symbol, `Canonical depth continuity failed: ${result.reason}.`);
      this.observability?.gap(event.symbol, "DEPTH", { ...result, firstUpdateId: event.firstUpdateId, finalUpdateId: event.finalUpdateId });
      void this.synchronizeOrderBook(event.symbol, true);
    } else if (["BUFFERED", "DUPLICATE_BUFFERED"].includes(result.reason)) this.observability?.update(event.symbol, "DEPTH", { status: "RECOVERING", lastError: "Buffering diff-depth updates pending snapshot bridge.", lastContinuity: result.continuity });
    else if (["DUPLICATE", "STALE", "OUT_OF_ORDER"].includes(result.reason) || ["DUPLICATE", "OUT_OF_ORDER", "STALE"].includes(result.continuity)) {
      const currentStatus = this.observability?.channelStatus(event.symbol, "DEPTH");
      this.observability?.update(event.symbol, "DEPTH", { status: currentStatus === "LIVE" ? "LIVE" : currentStatus ?? "RECOVERING", lastContinuity: result.continuity, lastContinuityAt: new Date().toISOString(), depthCounters: this.orderBook.status(event.symbol).counters });
    } else if (this.orderBook.status(event.symbol).synchronized) this.observability?.message(event.symbol, "DEPTH", { eventAt: event.eventTime, sequence: event.finalUpdateId, trackOperational: false });
  }
  ingestTrade(event) {
    const state = this.states.get(event.symbol); if (!state) return;
    if (event.continuity?.status === "GAP") {
      this.invalidateOrderFlow(event.symbol, "Aggregate-trade sequence gap detected; incomplete CVD/aggressor windows were discarded.");
      return;
    }
    if (!this.acceptsPrimaryStream(state, state.ticker) || this.orderBook.status(event.symbol).status !== "LIVE" || !Number.isFinite(event.price) || event.price <= 0) return;
    this.orderFlow.ingestTrade(event);
    const receivedAt = new Date().toISOString();
    state.ticker = { ...state.ticker, data: { ...state.ticker.data, lastPrice: event.price }, sourceTimestamp: new Date(event.tradeTime ?? event.eventTime).toISOString(), receivedAt, transport: "BINANCE_COMBINED_WEBSOCKET_REST_RECONCILED" };
    this.refreshFlowReadiness(event.symbol);
  }
  ingestBookTicker(event) {
    const state = this.states.get(event.symbol); if (!state || !this.acceptsPrimaryStream(state, state.ticker)) return;
    if (![event.bidPrice, event.askPrice, event.bidQuantity, event.askQuantity].every(Number.isFinite) || event.bidPrice <= 0 || event.askPrice <= event.bidPrice) return;
    this.orderBook.ingestBookTicker(event);
    if (this.orderBook.status(event.symbol).status === "LIVE") this.orderFlow.ingestBookTicker(event);
    const receivedAt = new Date().toISOString();
    state.ticker = { ...state.ticker, data: { ...state.ticker.data, bidPrice: event.bidPrice, askPrice: event.askPrice }, sourceTimestamp: new Date(event.eventTime).toISOString(), receivedAt, transport: "BINANCE_COMBINED_WEBSOCKET_REST_RECONCILED" };
  }
  ingestKline(event) {
    const state = this.states.get(event.symbol); const timeframe = event.interval;
    if (!state || !["1m", "5m"].includes(timeframe)) return;
    const envelope = state.candles[timeframe]; const candle = event.candle;
    const validCandle = candle && [candle.openTime, candle.closeTime, candle.trades].every(Number.isInteger) && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0) && [candle.volume, candle.quoteVolume].every((value) => Number.isFinite(value) && value >= 0) && candle.closeTime > candle.openTime && candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close);
    if (!this.acceptsPrimaryStream(state, envelope) || !validCandle) return;
    const priorCompleted = this.completedCloseTime(envelope);
    const data = [...envelope.data]; const index = data.findIndex((candle) => candle.openTime === event.candle.openTime);
    if (index >= 0) data[index] = event.candle; else data.push(event.candle);
    data.sort((left, right) => left.openTime - right.openTime);
    const limited = data.slice(-200); const latestCompleted = limited.findLast((candle) => candle.closed === true);
    state.candles[timeframe] = { ...envelope, data: limited, sourceTimestamp: new Date(event.eventTime).toISOString(), receivedAt: new Date().toISOString(), latestCompletedCloseTime: latestCompleted ? new Date(latestCompleted.closeTime).toISOString() : null, transport: "BINANCE_COMBINED_WEBSOCKET_REST_RECONCILED" };
    if (event.candle.closed) this.operationalService?.watermark(event.symbol, `KLINE_${timeframe.toUpperCase()}`, timeframe, event.candle.closeTime, { eventAt: event.eventTime, receivedAt: state.candles[timeframe].receivedAt });
    if (event.candle.closed && this.completedCloseTime(state.candles[timeframe]) !== priorCompleted) this.recalculate(event.symbol);
  }
  async refreshTickerData() {
    if (this.tickerBusy) return; this.tickerBusy = true;
    try {
      await Promise.all(this.symbols.map(async (symbol) => {
        const state = this.states.get(symbol); state.lastAttemptAt = new Date().toISOString();
        try {
          const bundle = this.streamEnabled
            ? { ticker: await this.provider.ticker(symbol), depth: null }
            : typeof this.provider.tickerDepth === "function"
              ? await this.provider.tickerDepth(symbol)
              : await Promise.all([this.provider.ticker(symbol), this.provider.depth(symbol)]).then(([ticker, depth]) => ({ ticker, depth }));
          state.ticker = bundle.ticker;
          this.updateTickerProviderBoundary(symbol, bundle.ticker);
          this.observeEnvelope(symbol, "TICKER", bundle.ticker);
          if (!this.streamEnabled) {
            state.depth = bundle.depth;
            this.observeEnvelope(symbol, "DEPTH", bundle.depth, { depthSynced: true });
          }
          state.errors.ticker = null;
          if (!this.streamEnabled) state.errors.depth = null;
          if (this.streamEnabled && bundle.ticker.source === this.primarySourceId && ["GAP", "ERROR"].includes(this.observability?.channelStatus(symbol, "BOOK_TICKER"))) this.observability.reconciled(symbol, "BOOK_TICKER", { method: "REST_TICKER_RECONCILIATION", source: bundle.ticker.source, reconciledAt: new Date().toISOString() });
          if (this.streamEnabled) await this.synchronizeOrderBook(symbol);
          this.audit(symbol, "LIVE", bundle.ticker, bundle.ticker.failover?.active ? bundle.ticker.failover.primaryError : null);
        } catch (error) {
          const message = this.error(error);
          state.ticker = null; this.updateTickerProviderBoundary(symbol, null); if (!this.streamEnabled) state.depth = null; state.errors.ticker = message; if (!this.streamEnabled) state.errors.depth = message;
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
          for (const timeframe of timeframes) {
            state.candles[timeframe] = envelopes[timeframe]; delete state.errors.candles[timeframe];
            const completedClose = this.completedCloseTime(envelopes[timeframe]);
            this.operationalService?.watermark(symbol, `KLINE_${timeframe.toUpperCase()}`, timeframe, completedClose, { eventAt: envelopes[timeframe]?.sourceTimestamp, receivedAt: envelopes[timeframe]?.receivedAt, failover: envelopes[timeframe]?.failover ?? { active: false } });
          }
          if (this.streamEnabled && envelopes["1m"].source === this.primarySourceId && envelopes["5m"].source === this.primarySourceId) for (const channel of ["KLINE_1M", "KLINE_5M"]) if (["GAP", "ERROR"].includes(this.observability?.channelStatus(symbol, channel))) this.observability.reconciled(symbol, channel, { method: "REST_KLINE_BUNDLE_RECONCILIATION", source: envelopes[channel === "KLINE_1M" ? "1m" : "5m"].source, reconciledAt: new Date().toISOString() });
          this.recalculate(symbol);
        } catch (error) {
          const message = this.error(error); state.analysis = null;
          for (const timeframe of timeframes) { state.candles[timeframe] = null; state.errors.candles[timeframe] = message; }
        }
        const candleErrors = Object.entries(state.errors.candles).map(([timeframe, message]) => `${timeframe}: ${message}`);
        if (candleErrors.length) this.audit(symbol, "ERROR", null, candleErrors.join("; "));
      }));
    } finally { this.candleBusy = false; }
  }
  recalculate(symbol) {
    const state = this.states.get(symbol); if (!state) return;
    const live = timeframes.every((timeframe) => this.status(state.candles[timeframe], timeframe) === "LIVE");
    const sources = new Set(timeframes.map((timeframe) => state.candles[timeframe]?.source));
    if (!live || sources.size !== 1 || sources.has(undefined)) {
      state.analysis = null;
      if (sources.size > 1) for (const timeframe of timeframes) state.errors.candles[timeframe] = "Candle timeframes came from mixed providers; analysis fails closed.";
      return;
    }
    const closed = Object.fromEntries(timeframes.map((timeframe) => [timeframe, state.candles[timeframe].data.filter((candle) => candle.closed)]));
    const orderFlow = this.orderFlowSnapshot(symbol, state);
    const orderBookMetrics = deriveOrderBookMetrics(state.depth);
    const analysis = analyzeMarket(closed, this.payoutRate, new Date(), { symbol, thresholds: this.candidateThresholds, triggerGraceMs: this.entryPolicy.triggerGraceMs, orderFlow, orderBookMetrics, deepEnabled: this.streamEnabled });
    if (this.structureState) analysis.candidates = analysis.candidates.map((candidate) => this.structureState.apply(candidate));
    analysis.sources = Object.fromEntries(timeframes.map((timeframe) => [timeframe, { source: state.candles[timeframe].source, sourceName: state.candles[timeframe].sourceName, sourceUrl: state.candles[timeframe].sourceUrl, sourceTimestamp: state.candles[timeframe].sourceTimestamp, receivedAt: state.candles[timeframe].receivedAt, latestCompletedCloseTime: this.completedCloseTime(state.candles[timeframe]), failover: state.candles[timeframe].failover, transport: state.candles[timeframe].transport ?? "REST" }]));
    state.analysis = analysis;
    this.emitAnalysisAlerts(symbol, analysis);
    this.database.insertSignal(symbol, state.analysis, state.candles["1m"].sourceTimestamp);
  }
  completedCloseTime(envelope) {
    const value = envelope?.latestCompletedCloseTime ?? envelope?.data?.findLast?.((candle) => candle?.closed === true)?.closeTime;
    const timestamp = new Date(value);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
  }
  status(envelope, timeframe = null) {
    if (!envelope?.sourceTimestamp || !envelope?.receivedAt) return "UNAVAILABLE";
    const now = Date.now(); const source = new Date(envelope.sourceTimestamp).getTime(); const received = new Date(envelope.receivedAt).getTime();
    const receiptLimit = timeframe && this.streamEnabled ? Math.max(this.staleAfterMs, this.reconcileMs * 2) : this.staleAfterMs;
    const sourceLimit = timeframe && this.streamEnabled && ["15m", "1h"].includes(timeframe) ? receiptLimit : this.staleAfterMs;
    if (!Number.isFinite(source) || !Number.isFinite(received) || now - source > sourceLimit || now - received > receiptLimit) return "STALE";
    if (timeframe) {
      const completed = new Date(this.completedCloseTime(envelope)).getTime();
      const completionGrace = this.streamEnabled && ["15m", "1h"].includes(timeframe) ? Math.max(this.staleAfterMs, this.reconcileMs * 2) : this.staleAfterMs;
      if (!intervalMilliseconds[timeframe] || !Number.isFinite(completed) || now - completed > intervalMilliseconds[timeframe] + completionGrace) return "STALE";
    }
    return "LIVE";
  }
  diagnostics(state) {
    const errors = [state.errors.ticker && `ticker: ${state.errors.ticker}`, state.errors.depth && `order book: ${state.errors.depth}`, ...Object.entries(state.errors.candles).map(([timeframe, message]) => `${timeframe} candles: ${message}`)].filter(Boolean);
    const envelopes = [state.ticker, state.depth, ...timeframes.map((timeframe) => state.candles[timeframe])].filter(Boolean);
    const failovers = envelopes.map((envelope) => envelope.failover).filter((failover) => failover?.active);
    const uniquePrimaryErrors = [...new Set(failovers.map((failover) => failover.primaryError))];
    return { errors, fallbackActive: failovers.length > 0, activeSources: [...new Set(envelopes.map((envelope) => envelope.source))], primaryErrors: uniquePrimaryErrors, failover: failovers[0] ?? null, message: failovers.length ? `${failovers[0].primaryName} unavailable. Using explicitly attributed ${failovers[0].fallbackName} data. ${uniquePrimaryErrors.join("; ")}` : errors.join("; ") || null };
  }
  feedStatus(symbol) {
    return this.streamEnabled ? { required: true, enabled: true, ...this.observability?.status(symbol) } : { required: false, enabled: false, actionReady: true, status: "DISABLED", channels: [], openAlerts: [] };
  }
  snapshot(symbol) {
    const state = this.states.get(symbol); if (!state) return null;
    const marketStatus = this.status(state.ticker); const rawDepthFreshness = this.status(state.depth);
    const depthStatus = this.streamEnabled
      ? state.depth?.status === "LIVE" && state.depth?.synchronized === true && rawDepthFreshness === "LIVE" ? "LIVE"
        : state.depth?.status === "FALLBACK" ? "REST_FALLBACK" : state.depth?.status ?? "UNAVAILABLE"
      : rawDepthFreshness;
    const candleStatuses = Object.fromEntries(timeframes.map((timeframe) => [timeframe, this.status(state.candles[timeframe], timeframe)]));
    const candleSources = timeframes.map((timeframe) => state.candles[timeframe]?.source).filter(Boolean);
    const analysisCoherent = candleSources.length === timeframes.length && new Set(candleSources).size === 1;
    const candleSource = analysisCoherent ? candleSources[0] : null;
    const candlesLive = timeframes.every((timeframe) => candleStatuses[timeframe] === "LIVE");
    const baseLive = marketStatus === "LIVE" && candlesLive;
    const dataUsable = baseLive && analysisCoherent && !state.errors.ticker && Object.keys(state.errors.candles).length === 0;
    const provider = this.diagnostics(state); const feed = this.feedStatus(symbol);
    const orderBookMetrics = deriveOrderBookMetrics(state.depth); const orderFlow = this.orderFlowSnapshot(symbol, state); const eventRisk = this.eventRisk.status(); const entryPolicy = this.entryPolicyFor(symbol);
    const receiptTimes = [state.ticker?.receivedAt, state.depth?.receivedAt].map((value) => new Date(value).getTime());
    const sourceSkewMs = receiptTimes.every(Number.isFinite) ? Math.abs(receiptTimes[0] - receiptTimes[1]) : null;
    const sameEntrySource = Boolean(state.ticker?.source && state.ticker.source === state.depth?.source);
    const actionSourceCoherent = Boolean(sameEntrySource && candleSource && state.ticker.source === candleSource);
    const entryCoherent = sameEntrySource && sourceSkewMs !== null && sourceSkewMs <= entryPolicy.maxSourceSkewMs;
    const feedReady = !entryPolicy.feedRequired || feed.actionReady === true;
    const orderFlowReady = !this.streamEnabled || orderFlow.status === "LIVE";
    const entryMarketReady = dataUsable && feedReady && orderFlowReady && !state.errors.depth && depthStatus === "LIVE" && orderBookMetrics.valid && orderBookMetrics.spreadBps <= entryPolicy.maxSpreadBps && orderBookMetrics.topNotional >= entryPolicy.minTopNotional && entryCoherent && actionSourceCoherent && (!entryPolicy.eventRiskEnabled || eventRisk.allowed === true);
    const overall = dataUsable ? (provider.fallbackActive || provider.errors.length || !feedReady || !orderFlowReady ? "DEGRADED" : "LIVE") : provider.errors.length ? "ERROR" : "DEGRADED";
    return {
      symbol,
      market: state.ticker ? { ...state.ticker, classification: "RAW", status: marketStatus } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" },
      orderBook: state.depth ? { ...state.depth, metrics: orderBookMetrics, classification: this.streamEnabled ? "CANONICAL_SYNCHRONIZED_BOOK" : "RAW", status: depthStatus } : { metrics: orderBookMetrics, classification: "UNAVAILABLE", status: "UNAVAILABLE" },
      orderFlow,
      candles: Object.fromEntries(timeframes.map((timeframe) => { const envelope = state.candles[timeframe]; return [timeframe, envelope ? { ...envelope, latestCompletedCloseTime: this.completedCloseTime(envelope), classification: "RAW", status: candleStatuses[timeframe] } : { classification: "UNAVAILABLE", status: "UNAVAILABLE" }]; })),
      analysis: candlesLive ? state.analysis : null, eventRisk,
      operations: this.operationalService?.status(symbol) ?? { symbol, status: "UNAVAILABLE", channels: [], byChannel: {} },
      alerts: (this.alertService?.list({ limit: 100 }) ?? []).filter((alert) => alert.symbol === symbol),
      entryPolicy: { ...entryPolicy, classification: "CONFIGURED_ENTRY_GATE_NOT_EVENT_FUTURES_LIQUIDITY" },
      eventFutures: { classification: "UNAVAILABLE", status: "UNAVAILABLE", reason: "No official MEXC Event Futures API has been verified for live payout, contracts or execution. The active underlying Spot source is identified next to every value.", paperPayout: { value: this.payoutRate, classification: "CALCULATED", source: "USER_CONFIGURATION", live: false } },
      health: { overall, dataUsable, entryMarketReady, analysisCoherent, actionSourceCoherent, entryCoherent, feed, orderFlow: orderFlow.status, market: marketStatus, orderBook: depthStatus, candles: candleStatuses, provider, sourceSkewMs, sameEntrySource, candleSource, lastAttemptAt: state.lastAttemptAt, error: provider.errors.join("; ") || null },
    };
  }
  entryPolicyFor(symbol) { return { ...this.entryPolicy, maxSpreadBps: this.entryPolicy.maxSpreadBpsBySymbol[symbol] }; }
  evaluateEntry(candidate, now = new Date()) {
    const snapshot = this.snapshot(candidate?.symbol);
    if (!snapshot) return { allowed: false, classification: "AUDITABLE_ENTRY_POLICY_PAPER_AND_MANUAL_ONLY", policyVersion: "entry-gates-v0.9.0", evaluatedAt: now.toISOString(), checks: [{ code: "SYMBOL", status: "BLOCKED", reason: "Symbol is not configured.", evidence: null }], readiness: { ready: false, blockedCount: 1, requirements: [] } };
    const policy = this.entryPolicyFor(candidate.symbol); const result = evaluateEntryGates({ snapshot, candidate, policy, now });
    return { ...result, readiness: explainReadiness({ candidate, snapshot, checks: result.checks, policy, now }) };
  }
  feeds(symbol = null) { return symbol ? this.feedStatus(symbol) : { enabled: this.streamEnabled, symbols: Object.fromEntries(this.symbols.map((item) => [item, this.feedStatus(item)])) }; }
  sources() {
    const providers = this.provider.providers ?? [this.provider];
    return [
      ...providers.map((provider, index) => ({ id: provider.sourceId ?? `provider-${index}`, name: provider.name, role: index === 0 ? "PRIMARY" : "FALLBACK", type: provider.official ? "OFFICIAL_PUBLIC_API" : "CONFIGURED_PROVIDER", updateFrequency: this.streamEnabled && index === 0 ? "WebSocket trade/bookTicker/1m/5m plus REST ticker/depth and 15m/1h reconciliation" : "Ticker/depth default 3s; klines default 5s", limitations: provider.sourceId === "BINANCE_SPOT_REST" ? "Binance Spot underlying data; not Event Futures contracts, payout or settlement." : "MEXC Spot fallback underlying data; not Event Futures contracts, payout or settlement.", symbols: this.symbols })),
      ...(this.streamEnabled ? [{ id: "BINANCE_SPOT_STREAM", name: "Binance Spot Combined WebSocket", role: "PRIMARY_EVENT_STREAM", type: "OFFICIAL_PUBLIC_STREAM", updateFrequency: "Event-driven with exponential reconnect and REST reconciliation", limitations: "Trade, bookTicker, 100ms diff-depth and 1m/5m kline events; the canonical book uses the official snapshot/bridge/continuous/resync sequence.", symbols: this.symbols }] : []),
      { id: "mexc-event-futures", name: "MEXC Event Futures", role: "UNAVAILABLE", type: "UNVERIFIED", updateFrequency: null, limitations: "Official integration endpoint not verified; live execution disabled.", symbols: this.symbols },
      this.eventRisk.source(),
    ];
  }
}
