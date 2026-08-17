function object(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not an object`); return value; }
function number(value, label) { if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) throw new Error(`${label} is missing`); const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`${label} is not numeric`); return parsed; }
function optionalNumber(value, label, { min = -Infinity } = {}) { if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null; const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${label} is invalid`); return parsed; }
function positive(value, label) { const parsed = number(value, label); if (parsed <= 0) throw new Error(`${label} must be positive`); return parsed; }
function nonnegative(value, label) { const parsed = number(value, label); if (parsed < 0) throw new Error(`${label} must be nonnegative`); return parsed; }
function string(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is not a string`); return value; }

export function describeProviderError(error) {
  if (!(error instanceof Error)) return "Unknown provider error";
  const cause = error.cause instanceof Error ? error.cause : null;
  const code = cause?.code ?? error.code;
  const detail = cause?.message && cause.message !== error.message ? `: ${cause.message}` : "";
  return `${error.message}${code ? ` [${code}]` : ""}${detail}`;
}

export class MexcSpotProvider {
  constructor(baseUrl, { fetchImpl = fetch, timeoutMs = 5000, attempts = 2, identity } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.attempts = attempts;
    const hostname = new URL(this.baseUrl).hostname;
    const officialMexc = hostname === "api.mexc.com";
    const officialBinance = hostname === "data-api.binance.vision";
    this.sourceId = identity?.sourceId ?? (officialMexc ? "MEXC_SPOT_REST" : officialBinance ? "BINANCE_SPOT_REST" : "CONFIGURED_MARKET_PROVIDER");
    this.name = identity?.name ?? (officialMexc ? "MEXC Spot REST v3" : officialBinance ? "Binance Spot Market Data" : `Configured provider (${new URL(this.baseUrl).origin})`);
    this.official = identity?.official ?? (officialMexc || officialBinance);
  }
  async request(path, attempts = this.attempts) {
    const url = `${this.baseUrl}${path}`; let finalError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "signal-expert/0.7.0" } });
        if (!response.ok) { const error = new Error(`${this.name} HTTP ${response.status}`); error.status = response.status; throw error; }
        return { payload: await response.json(), receivedAt: new Date(), url };
      } catch (error) { finalError = error; if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt)); }
      finally { clearTimeout(timeout); }
    }
    throw new Error(`${this.name}: ${describeProviderError(finalError)}`, { cause: finalError });
  }
  envelope(data, response, sourceTimestamp, metadata = {}) {
    const timestamp = new Date(sourceTimestamp); if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid source timestamp");
    return { data, source: this.sourceId, sourceName: this.name, sourceUrl: response.url, sourceTimestamp: timestamp.toISOString(), receivedAt: response.receivedAt.toISOString(), ...metadata, failover: { active: false, primarySource: this.sourceId, primaryError: null } };
  }
  async ticker(symbol) {
    const response = await this.request(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`); const raw = object(response.payload, "ticker"); const returned = string(raw.symbol, "symbol");
    if (returned !== symbol) throw new Error(`Ticker symbol mismatch: expected ${symbol}, received ${returned}`);
    const data = {
      symbol: returned,
      lastPrice: positive(raw.lastPrice, "lastPrice"),
      bidPrice: optionalNumber(raw.bidPrice, "bidPrice", { min: 0 }),
      askPrice: optionalNumber(raw.askPrice, "askPrice", { min: 0 }),
      priceChange: number(raw.priceChange, "priceChange"),
      priceChangePercent: number(raw.priceChangePercent, "priceChangePercent"),
      high24h: positive(raw.highPrice, "highPrice"),
      low24h: positive(raw.lowPrice, "lowPrice"),
      baseVolume24h: nonnegative(raw.volume, "volume"),
      quoteVolume24h: nonnegative(raw.quoteVolume, "quoteVolume"),
      tradeCount24h: optionalNumber(raw.count, "count", { min: 0 }),
    };
    if (data.high24h < data.low24h) throw new Error("Ticker high is below low");
    const sourceTime = optionalNumber(raw.closeTime, "closeTime", { min: 1 }) ?? response.receivedAt.getTime();
    return this.envelope(data, response, sourceTime);
  }
  async depth(symbol, limit = 20) {
    const response = await this.request(`/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${limit}`); const raw = object(response.payload, "depth");
    if (!Array.isArray(raw.bids) || !Array.isArray(raw.asks)) throw new Error("Depth levels are missing");
    const levels = (rows, label) => rows.map((row, index) => { if (!Array.isArray(row) || row.length < 2) throw new Error(`${label}[${index}] invalid`); return { price: positive(row[0], `${label}.price`), quantity: nonnegative(row[1], `${label}.quantity`) }; });
    return this.envelope({ lastUpdateId: optionalNumber(raw.lastUpdateId, "lastUpdateId", { min: 0 }), bids: levels(raw.bids, "bids"), asks: levels(raw.asks, "asks") }, response, response.receivedAt);
  }
  async klines(symbol, interval, limit = 200) {
    const providerInterval = this.sourceId === "MEXC_SPOT_REST" && interval === "1h" ? "60m" : interval;
    const response = await this.request(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${providerInterval}&limit=${limit}`);
    if (!Array.isArray(response.payload)) throw new Error("Klines response is not an array"); const receivedMs = response.receivedAt.getTime();
    const candles = response.payload.map((row, index) => {
      const minimumFields = this.sourceId === "MEXC_SPOT_REST" ? 8 : 9;
      if (!Array.isArray(row) || row.length < minimumFields) throw new Error(`Kline ${index} invalid`);
      const candle = {
        openTime: positive(row[0], "openTime"), open: positive(row[1], "open"), high: positive(row[2], "high"), low: positive(row[3], "low"), close: positive(row[4], "close"),
        volume: nonnegative(row[5], "volume"), closeTime: positive(row[6], "closeTime"), quoteVolume: nonnegative(row[7], "quoteVolume"),
        trades: row.length >= 9 ? nonnegative(row[8], "trades") : null,
      };
      if (candle.closeTime <= candle.openTime || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) throw new Error(`Kline ${index} has invalid OHLC/time relationships`);
      return { ...candle, closed: candle.closeTime < receivedMs };
    });
    const latest = candles.at(-1); if (!latest) throw new Error("Klines response is empty");
    const latestCompleted = candles.findLast((candle) => candle.closed === true);
    if (!latestCompleted) throw new Error("Klines response contains no completed candle");
    const sourceTime = latest.closed ? latest.closeTime : receivedMs;
    return this.envelope(candles, response, sourceTime, { latestCompletedCloseTime: new Date(latestCompleted.closeTime).toISOString() });
  }
}

export class FailoverMarketProvider {
  constructor(primary, fallback = null) {
    this.primary = primary; this.fallback = fallback;
    this.name = fallback ? `${primary.name} with ${fallback.name} fallback` : primary.name;
    this.sourceId = primary.sourceId; this.official = primary.official;
    this.providers = [primary, ...(fallback ? [fallback] : [])];
  }
  async call(method, args) {
    try { return await this.primary[method](...args); }
    catch (primaryError) {
      const primaryMessage = describeProviderError(primaryError);
      if (!this.fallback) throw new Error(`Primary provider unavailable — ${primaryMessage}`, { cause: primaryError });
      try {
        const envelope = await this.fallback[method](...args);
        return { ...envelope, failover: { active: true, primarySource: this.primary.sourceId, primaryName: this.primary.name, primaryError: primaryMessage, fallbackSource: this.fallback.sourceId, fallbackName: this.fallback.name, switchedAt: new Date().toISOString() } };
      } catch (fallbackError) {
        throw new Error(`All market providers failed — primary: ${primaryMessage}; fallback: ${describeProviderError(fallbackError)}`, { cause: fallbackError });
      }
    }
  }
  async callBundle(operation) {
    try { return await operation(this.primary); }
    catch (primaryError) {
      const primaryMessage = describeProviderError(primaryError);
      if (!this.fallback) throw new Error(`Primary provider bundle unavailable — ${primaryMessage}`, { cause: primaryError });
      try {
        const result = await operation(this.fallback);
        const failover = { active: true, primarySource: this.primary.sourceId, primaryName: this.primary.name, primaryError: primaryMessage, fallbackSource: this.fallback.sourceId, fallbackName: this.fallback.name, switchedAt: new Date().toISOString() };
        return Object.fromEntries(Object.entries(result).map(([key, envelope]) => [key, { ...envelope, failover }]));
      } catch (fallbackError) {
        throw new Error(`All market provider bundles failed — primary: ${primaryMessage}; fallback: ${describeProviderError(fallbackError)}`, { cause: fallbackError });
      }
    }
  }
  tickerDepth(symbol) {
    return this.callBundle(async (provider) => {
      const [ticker, depth] = await Promise.all([provider.ticker(symbol), provider.depth(symbol)]);
      return { ticker, depth };
    });
  }
  klinesSet(symbol, timeframes) {
    return this.callBundle(async (provider) => {
      const envelopes = await Promise.all(timeframes.map((timeframe) => provider.klines(symbol, timeframe)));
      return Object.fromEntries(timeframes.map((timeframe, index) => [timeframe, envelopes[index]]));
    });
  }
  ticker(...args) { return this.call("ticker", args); }
  depth(...args) { return this.call("depth", args); }
  klines(...args) { return this.call("klines", args); }
}
