const channels = (symbol) => [`${symbol.toLowerCase()}@aggTrade`, `${symbol.toLowerCase()}@bookTicker`, `${symbol.toLowerCase()}@depth@100ms`, `${symbol.toLowerCase()}@kline_1m`, `${symbol.toLowerCase()}@kline_5m`];
const requiredChannels = ["TRADE", "BOOK_TICKER", "DEPTH", "KLINE_1M", "KLINE_5M"];
const finitePositive = (value) => Number.isFinite(value) && value > 0;
const finiteNonnegative = (value) => Number.isFinite(value) && value >= 0;

export class BinanceSpotStream {
  constructor({ baseUrl, symbols, webSocketFactory = (url) => new WebSocket(url), reconnectMinMs = 1000, reconnectMaxMs = 30000, observability = null }) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); this.symbols = symbols; this.webSocketFactory = webSocketFactory; this.reconnectMinMs = reconnectMinMs; this.reconnectMaxMs = reconnectMaxMs; this.observability = observability;
    this.socket = null; this.handlers = null; this.stopped = true; this.reconnectTimer = null; this.attempt = 0; this.continuity = new Map();
  }
  url() { return `${this.baseUrl}/stream?streams=${this.symbols.flatMap(channels).join("/")}`; }
  start(handlers) { this.handlers = handlers; this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped || this.socket) return;
    try {
      const socket = this.webSocketFactory(this.url()); this.socket = socket;
      socket.addEventListener("open", () => {
        this.attempt = 0; this.continuity.clear();
        for (const symbol of this.symbols) for (const channel of requiredChannels) this.observability?.update(symbol, channel, { status: "RECOVERING", connectedAt: new Date().toISOString(), lastError: null });
        this.handlers?.onOpen?.();
      });
      socket.addEventListener("message", (event) => { void this.message(event.data); });
      socket.addEventListener("error", () => this.handlers?.onError?.(new Error("Binance WebSocket error")));
      socket.addEventListener("close", (event) => {
        this.socket = null; this.continuity.clear();
        for (const symbol of this.symbols) for (const channel of requiredChannels) this.observability?.disconnected(symbol, channel, `close ${event.code}`, !this.stopped);
        this.handlers?.onClose?.(event); if (!this.stopped) this.scheduleReconnect();
      });
    } catch (error) { this.socket = null; this.handlers?.onError?.(error); this.scheduleReconnect(); }
  }
  scheduleReconnect() {
    if (this.reconnectTimer || this.stopped) return;
    const base = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.attempt++); const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }
  sequenceContinuity(key, value, expectedStep = 1) {
    const previous = this.continuity.get(key);
    const status = !Number.isInteger(previous) ? "FIRST"
      : value === previous ? "DUPLICATE"
        : value < previous ? "OUT_OF_ORDER"
          : value > previous + expectedStep ? "GAP" : "CONTINUOUS";
    if (!Number.isInteger(previous) || value > previous) this.continuity.set(key, value);
    return { status, previous, received: value, expected: Number.isInteger(previous) ? previous + expectedStep : null };
  }
  async message(raw) {
    try {
      const text = typeof raw === "string" ? raw : typeof raw?.text === "function" ? await raw.text() : new TextDecoder().decode(raw);
      const parsed = JSON.parse(text); const data = parsed.data ?? parsed; const symbol = data?.s;
      if (!this.symbols.includes(symbol)) return;
      if (data.e === "aggTrade") {
        const eventTime = Number(data.E); const tradeTime = Number(data.T); const price = Number(data.p); const quantity = Number(data.q); const sequence = Number(data.a); const isBuyerMaker = data.m;
        if (![eventTime, tradeTime, sequence].every(Number.isInteger) || !finitePositive(price) || !finitePositive(quantity) || typeof isBuyerMaker !== "boolean") return this.observability?.invalid(symbol, "TRADE", { reason: "Malformed aggregate-trade event" });
        const continuity = this.sequenceContinuity(`${symbol}:TRADE`, sequence);
        this.handlers?.onTrade?.({ symbol, eventTime, tradeTime, price, quantity, sequence, isBuyerMaker, buyerMaker: isBuyerMaker, m: isBuyerMaker, continuity });
        if (continuity.status === "GAP") this.observability?.gap(symbol, "TRADE", continuity);
        this.observability?.message(symbol, "TRADE", { eventAt: eventTime, sequence, continuity: continuity.status });
        return;
      }
      if (data.e === "depthUpdate") {
        const eventTime = Number(data.E); const transactionTime = data.T === undefined ? null : Number(data.T); const firstUpdateId = Number(data.U); const finalUpdateId = Number(data.u); const previousFinalUpdateId = data.pu === undefined ? null : Number(data.pu);
        const validLevels = (levels) => Array.isArray(levels) && levels.every((level) => Array.isArray(level) && level.length >= 2 && finitePositive(Number(level[0])) && finiteNonnegative(Number(level[1])));
        const valid = Number.isInteger(eventTime) && (transactionTime === null || Number.isInteger(transactionTime)) && Number.isInteger(firstUpdateId) && Number.isInteger(finalUpdateId) && finalUpdateId >= firstUpdateId && (previousFinalUpdateId === null || Number.isInteger(previousFinalUpdateId)) && validLevels(data.b) && validLevels(data.a);
        if (!valid) return this.observability?.invalid(symbol, "DEPTH", { reason: "Malformed diff-depth event" });
        this.handlers?.onDepth?.({ symbol, eventTime, transactionTime, firstUpdateId, finalUpdateId, previousFinalUpdateId, bids: data.b, asks: data.a });
        return;
      }
      if (data.e === "kline") {
        const interval = data.k?.i; const intervalMs = interval === "1m" ? 60_000 : interval === "5m" ? 300_000 : null; const channel = interval === "1m" ? "KLINE_1M" : interval === "5m" ? "KLINE_5M" : null;
        const eventTime = Number(data.E); const openTime = Number(data.k?.t); const closeTime = Number(data.k?.T);
        const candle = { openTime, closeTime, open: Number(data.k?.o), high: Number(data.k?.h), low: Number(data.k?.l), close: Number(data.k?.c), volume: Number(data.k?.v), quoteVolume: Number(data.k?.q), trades: Number(data.k?.n), closed: data.k?.x === true };
        const valid = channel && [eventTime, openTime, closeTime, candle.trades].every(Number.isInteger) && [candle.open, candle.high, candle.low, candle.close].every(finitePositive) && [candle.volume, candle.quoteVolume].every(finiteNonnegative) && closeTime > openTime && candle.high >= Math.max(candle.open, candle.close) && candle.low <= Math.min(candle.open, candle.close) && candle.low <= candle.high;
        if (!valid) return this.observability?.invalid(symbol, channel ?? "KLINE_UNKNOWN", { reason: "Malformed kline event", interval });
        const continuity = this.sequenceContinuity(`${symbol}:${channel}`, openTime, intervalMs);
        if (continuity.status === "GAP") this.observability?.gap(symbol, channel, { expectedStepMs: intervalMs, previousOpenTime: continuity.previous, receivedOpenTime: openTime });
        this.handlers?.onKline?.({ symbol, interval, eventTime, candle, continuity });
        this.observability?.message(symbol, channel, { eventAt: eventTime, sequence: openTime, sequenceStep: intervalMs, continuity: continuity.status, trackOperational: candle.closed !== true });
        return;
      }
      if (Object.hasOwn(data, "b") && Object.hasOwn(data, "a")) {
        const eventTime = Number.isInteger(Number(data.E)) ? Number(data.E) : Date.now(); const sequence = Number(data.u); const bidPrice = Number(data.b); const bidQuantity = Number(data.B); const askPrice = Number(data.a); const askQuantity = Number(data.A);
        if (!Number.isInteger(sequence) || !finitePositive(bidPrice) || !finitePositive(askPrice) || !finiteNonnegative(bidQuantity) || !finiteNonnegative(askQuantity) || askPrice <= bidPrice) return this.observability?.invalid(symbol, "BOOK_TICKER", { reason: "Malformed book-ticker event" });
        const continuity = this.sequenceContinuity(`${symbol}:BOOK_TICKER`, sequence);
        if (continuity.status === "GAP") continuity.status = "CONTINUOUS";
        this.handlers?.onBookTicker?.({ symbol, eventTime, sequence, bidPrice, bidQuantity, askPrice, askQuantity, continuity });
        this.observability?.message(symbol, "BOOK_TICKER", { eventAt: eventTime, sequence, continuity: continuity.status });
      }
    } catch (error) { this.handlers?.onError?.(error); }
  }
  stop() {
    this.stopped = true; if (this.reconnectTimer) clearTimeout(this.reconnectTimer); this.reconnectTimer = null;
    const socket = this.socket; if (!socket) return Promise.resolve();
    return new Promise((resolveStop) => {
      let settled = false; const done = () => { if (settled) return; settled = true; clearTimeout(timeout); resolveStop(); };
      const timeout = setTimeout(done, 1500); socket.addEventListener("close", done, { once: true });
      try { if (socket.readyState < 2) socket.close(1000, "shutdown"); else done(); } catch { done(); }
    });
  }
}
