export const ORDER_FLOW_WINDOWS = Object.freeze({ "10s": 10_000, "30s": 30_000, "60s": 60_000, "5m": 300_000 });
export const BOOK_IMBALANCE_LEVELS = Object.freeze([5, 10, 20]);

const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const nonnegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
const clamp = (value, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : 0;
const round = (value, digits = 8) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export function parseEventTimestamp(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === "string" && value.trim() !== "") value = /^\d+$/.test(value) ? Number(value) : new Date(value).getTime();
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

export function validEventTimestamp(value, { now = Date.now(), maxFutureSkewMs = 5_000 } = {}) {
  const timestamp = parseEventTimestamp(value);
  return timestamp !== null && timestamp <= Number(now) + maxFutureSkewMs;
}

export function aggressorSide(trade) {
  if (trade?.side === "BUY" || trade?.aggressorSide === "BUY") return "BUY";
  if (trade?.side === "SELL" || trade?.aggressorSide === "SELL") return "SELL";
  const maker = trade?.isBuyerMaker ?? trade?.buyerMaker ?? trade?.m;
  return maker === true ? "SELL" : maker === false ? "BUY" : null;
}

export function normalizeBookLevels(levels, { allowZero = false } = {}) {
  if (!Array.isArray(levels)) return null;
  const result = [];
  for (const level of levels) {
    const price = Number(Array.isArray(level) ? level[0] : level?.price ?? level?.p);
    const quantity = Number(Array.isArray(level) ? level[1] : level?.quantity ?? level?.qty ?? level?.q);
    if (!positive(price) || !(allowZero ? nonnegative(quantity) : positive(quantity))) return null;
    result.push({ price, quantity });
  }
  return result;
}

function sorted(map, side, limit = Infinity) {
  return [...map.entries()]
    .map(([price, quantity]) => ({ price, quantity }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, limit);
}

export function computeBookImbalance(bids, asks, levels = 10) {
  const bidSlice = bids.slice(0, levels);
  const askSlice = asks.slice(0, levels);
  const bidQuantity = bidSlice.reduce((sum, level) => sum + level.quantity, 0);
  const askQuantity = askSlice.reduce((sum, level) => sum + level.quantity, 0);
  const bidNotional = bidSlice.reduce((sum, level) => sum + level.price * level.quantity, 0);
  const askNotional = askSlice.reduce((sum, level) => sum + level.price * level.quantity, 0);
  return {
    levels,
    bidQuantity: round(bidQuantity), askQuantity: round(askQuantity),
    bidNotional: round(bidNotional), askNotional: round(askNotional),
    quantityImbalance: round(ratio(bidQuantity - askQuantity, bidQuantity + askQuantity)),
    notionalImbalance: round(ratio(bidNotional - askNotional, bidNotional + askNotional)),
  };
}

export function computeMicroprice(bestBid, bestAsk) {
  if (!bestBid || !bestAsk || !positive(bestBid.price) || !positive(bestAsk.price) || !nonnegative(bestBid.quantity) || !nonnegative(bestAsk.quantity) || bestBid.price >= bestAsk.price) return null;
  const totalQuantity = bestBid.quantity + bestAsk.quantity;
  const midPrice = (bestBid.price + bestAsk.price) / 2;
  const microprice = totalQuantity > 0 ? (bestAsk.price * bestBid.quantity + bestBid.price * bestAsk.quantity) / totalQuantity : midPrice;
  return {
    bestBid: bestBid.price,
    bestAsk: bestAsk.price,
    midPrice: round(midPrice),
    microprice: round(microprice),
    deviation: round(microprice - midPrice),
    deviationBps: round((microprice - midPrice) / midPrice * 10_000),
  };
}

export function summarizeAggressorVolume(trades, startTime = -Infinity) {
  const summary = { buyQuantity: 0, sellQuantity: 0, buyNotional: 0, sellNotional: 0, buyTrades: 0, sellTrades: 0 };
  for (const trade of trades) {
    if (trade.timestamp < startTime) continue;
    const prefix = trade.side === "BUY" ? "buy" : "sell";
    summary[`${prefix}Quantity`] += trade.quantity;
    summary[`${prefix}Notional`] += trade.notional;
    summary[`${prefix}Trades`] += 1;
  }
  return {
    ...Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, round(value)])),
    totalQuantity: round(summary.buyQuantity + summary.sellQuantity),
    totalNotional: round(summary.buyNotional + summary.sellNotional),
    deltaQuantity: round(summary.buyQuantity - summary.sellQuantity),
    deltaNotional: round(summary.buyNotional - summary.sellNotional),
    tradeCount: summary.buyTrades + summary.sellTrades,
  };
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function stateFor(symbol) {
  return {
    symbol,
    trades: [],
    tradeKeys: new Set(),
    bids: new Map(),
    asks: new Map(),
    lastUpdateId: null,
    synchronized: false,
    bookStatus: "UNAVAILABLE",
    bookReason: "No synchronized order book.",
    lastBookEventTime: null,
    lastBookReceivedAt: null,
    lastTradeEventTime: null,
    lastTradeReceivedAt: null,
    tradeContinuityStartedAt: null,
    ticker: null,
    observations: [],
    liquidityEvents: [],
    spoofEvents: [],
    activeAdds: new Map(),
    counters: { trades: 0, duplicateTrades: 0, outOfOrderTrades: 0, invalidTrades: 0, bookUpdates: 0, invalidBooks: 0, bookGaps: 0 },
    reportedStatus: null,
  };
}

export class OrderFlowAnalyzer {
  constructor({
    symbols = [], now = Date.now, staleAfterMs = 15_000, tradeStaleAfterMs = staleAfterMs,
    maxFutureSkewMs = 5_000, maxTrades = 100_000, maxBookEvents = 20_000,
    maxLiquidityEvents = 20_000, maxBookLevels = 5_000, trackedLevels = 20,
    retentionMs = ORDER_FLOW_WINDOWS["5m"], liquidityWindowMs = 30_000,
    spoofLifetimeMs = 30_000, onUpdate = null, onStatus = null, onError = null, callbacks = {},
  } = {}) {
    this.now = now;
    this.staleAfterMs = Math.max(1, Number(staleAfterMs));
    this.tradeStaleAfterMs = Math.max(1, Number(tradeStaleAfterMs));
    this.maxFutureSkewMs = Math.max(0, Number(maxFutureSkewMs));
    this.maxTrades = Math.max(1, Math.floor(maxTrades));
    this.maxBookEvents = Math.max(1, Math.floor(maxBookEvents));
    this.maxLiquidityEvents = Math.max(1, Math.floor(maxLiquidityEvents));
    this.maxBookLevels = Math.max(BOOK_IMBALANCE_LEVELS.at(-1), Math.floor(maxBookLevels));
    this.trackedLevels = Math.max(BOOK_IMBALANCE_LEVELS.at(-1), Math.floor(trackedLevels));
    this.retentionMs = Math.max(ORDER_FLOW_WINDOWS["5m"], Number(retentionMs));
    this.liquidityWindowMs = Math.max(1_000, Number(liquidityWindowMs));
    this.spoofLifetimeMs = Math.max(1_000, Number(spoofLifetimeMs));
    this.callbacks = { onUpdate: onUpdate ?? callbacks.onUpdate, onStatus: onStatus ?? callbacks.onStatus, onError: onError ?? callbacks.onError };
    this.states = new Map(symbols.map((symbol) => [symbol, stateFor(symbol)]));
  }

  _state(symbol) {
    if (typeof symbol !== "string" || !symbol) throw new TypeError("A non-empty symbol is required.");
    if (!this.states.has(symbol)) this.states.set(symbol, stateFor(symbol));
    return this.states.get(symbol);
  }

  _call(name, payload) {
    try { this.callbacks[name]?.(payload); }
    catch (error) { if (name !== "onError") try { this.callbacks.onError?.({ error, callback: name, payload }); } catch {} }
  }

  _boundedPush(array, value, maximum) {
    array.push(value);
    if (array.length > maximum) array.splice(0, array.length - maximum);
  }

  _trimMap(map, side) {
    if (map.size <= this.maxBookLevels) return;
    const keep = sorted(map, side, this.maxBookLevels);
    map.clear();
    for (const level of keep) map.set(level.price, level.quantity);
  }

  _prune(state, at = this.now()) {
    const cutoff = at - this.retentionMs;
    while (state.trades.length && state.trades[0].timestamp < cutoff) {
      const removed = state.trades.shift();
      state.tradeKeys.delete(removed.key);
    }
    while (state.observations.length && state.observations[0].timestamp < cutoff) state.observations.shift();
    while (state.liquidityEvents.length && state.liquidityEvents[0].timestamp < cutoff) state.liquidityEvents.shift();
    while (state.spoofEvents.length && state.spoofEvents[0].timestamp < cutoff) state.spoofEvents.shift();
    for (const [key, addition] of state.activeAdds) if (addition.timestamp < at - this.spoofLifetimeMs) state.activeAdds.delete(key);
  }

  _eventTime(raw, fallback = null) {
    const value = raw?.eventTime ?? raw?.tradeTime ?? raw?.E ?? raw?.T ?? raw?.timestamp ?? raw?.sourceTimestamp ?? raw?.receivedAt ?? fallback;
    const timestamp = parseEventTimestamp(value);
    return timestamp !== null && validEventTimestamp(timestamp, { now: this.now(), maxFutureSkewMs: this.maxFutureSkewMs }) ? timestamp : null;
  }

  _currentTop(state) {
    const bids = sorted(state.bids, "bid", this.trackedLevels);
    const asks = sorted(state.asks, "ask", this.trackedLevels);
    return { bids, asks, bestBid: bids[0] ?? null, bestAsk: asks[0] ?? null };
  }

  _recordObservation(state, timestamp, source) {
    const { bids, asks, bestBid, bestAsk } = this._currentTop(state);
    if (!bestBid || !bestAsk || bestBid.price >= bestAsk.price) return false;
    const mid = (bestBid.price + bestAsk.price) / 2;
    const spread = bestAsk.price - bestBid.price;
    this._boundedPush(state.observations, {
      timestamp, source, mid, spread, spreadBps: spread / mid * 10_000,
      bidNotional: bids.reduce((sum, level) => sum + level.price * level.quantity, 0),
      askNotional: asks.reduce((sum, level) => sum + level.price * level.quantity, 0),
    }, this.maxBookEvents);
    return true;
  }

  _recentAggressiveNotional(state, side, timestamp, windowMs = 1_000) {
    let notional = 0;
    for (let index = state.trades.length - 1; index >= 0; index -= 1) {
      const trade = state.trades[index];
      if (trade.timestamp < timestamp - windowMs) break;
      if (trade.timestamp <= timestamp && trade.side === side) notional += trade.notional;
    }
    return notional;
  }

  _rank(map, side, price) {
    const levels = sorted(map, side, this.trackedLevels);
    const index = levels.findIndex((level) => level.price === price);
    return index < 0 ? this.trackedLevels + 1 : index + 1;
  }

  _recordLiquidityChange(state, side, price, before, after, timestamp, source, priorRank = null) {
    if (before === after) return;
    const key = `${side}:${price}`;
    const difference = after - before;
    const currentMap = side === "BID" ? state.bids : state.asks;
    const sideName = side === "BID" ? "bid" : "ask";
    const rank = difference < 0 && Number.isInteger(priorRank) ? priorRank : this._rank(currentMap, sideName, price);
    if (difference > 0) {
      const addedNotional = difference * price;
      const previous = state.activeAdds.get(key);
      state.activeAdds.set(key, {
        timestamp, price, side, addedQuantity: difference + (previous?.addedQuantity ?? 0),
        addedNotional: addedNotional + (previous?.addedNotional ?? 0), executedNotional: previous?.executedNotional ?? 0, rank: Math.min(rank, previous?.rank ?? Infinity),
      });
      this._boundedPush(state.liquidityEvents, { timestamp, type: "REPLENISHMENT", side, price, quantity: difference, notional: addedNotional, rank, source }, this.maxLiquidityEvents);
      return;
    }
    const removedQuantity = -difference;
    const removedNotional = removedQuantity * price;
    const aggressionSide = side === "BID" ? "SELL" : "BUY";
    const aggressiveNotional = this._recentAggressiveNotional(state, aggressionSide, timestamp);
    const unexplainedNotional = Math.max(0, removedNotional - aggressiveNotional);
    this._boundedPush(state.liquidityEvents, {
      timestamp, type: "DISAPPEARANCE", side, price, quantity: removedQuantity, notional: removedNotional,
      explainedByAggressionNotional: Math.min(removedNotional, aggressiveNotional), unexplainedNotional, rank, source,
    }, this.maxLiquidityEvents);
    const addition = state.activeAdds.get(key);
    if (addition) {
      const ageMs = timestamp - addition.timestamp;
      const cancellableNotional = Math.max(0, addition.addedNotional - addition.executedNotional);
      const cancelledNotional = Math.min(unexplainedNotional, cancellableNotional);
      const cancellationRatio = ratio(cancelledNotional, addition.addedNotional);
      if (ageMs >= 0 && ageMs <= this.spoofLifetimeMs && addition.rank <= this.trackedLevels && cancellationRatio >= 0.5) {
        const lifetimeComponent = 1 - ageMs / this.spoofLifetimeMs;
        const proximityComponent = 1 - (addition.rank - 1) / this.trackedLevels;
        const score = 100 * clamp(0.55 * cancellationRatio + 0.25 * lifetimeComponent + 0.2 * proximityComponent);
        this._boundedPush(state.spoofEvents, {
          timestamp, side, price, rank: addition.rank, ageMs, addedNotional: addition.addedNotional,
          cancelledNotional, executedNotional: addition.executedNotional, cancellationRatio, score,
          reason: `${side} liquidity added near the top was removed within ${ageMs}ms without matching aggressive execution.`,
        }, this.maxLiquidityEvents);
      }
      if (removedQuantity >= addition.addedQuantity * 0.5 || after === 0) state.activeAdds.delete(key);
    }
  }

  _applyChanges(state, bids, asks, timestamp, source) {
    for (const { price, quantity } of bids) {
      const before = state.bids.get(price) ?? 0;
      const priorRank = this._rank(state.bids, "bid", price);
      quantity === 0 ? state.bids.delete(price) : state.bids.set(price, quantity);
      this._recordLiquidityChange(state, "BID", price, before, quantity, timestamp, source, priorRank);
    }
    for (const { price, quantity } of asks) {
      const before = state.asks.get(price) ?? 0;
      const priorRank = this._rank(state.asks, "ask", price);
      quantity === 0 ? state.asks.delete(price) : state.asks.set(price, quantity);
      this._recordLiquidityChange(state, "ASK", price, before, quantity, timestamp, source, priorRank);
    }
    this._trimMap(state.bids, "bid");
    this._trimMap(state.asks, "ask");
  }

  _validateBook(state) {
    const { bestBid, bestAsk } = this._currentTop(state);
    return Boolean(bestBid && bestAsk && bestBid.price < bestAsk.price);
  }

  _setBookUnavailable(state, reason) {
    state.synchronized = false;
    state.bookStatus = "UNAVAILABLE";
    state.bookReason = reason;
    state.counters.bookGaps += 1;
    this._publishStatus(state);
  }

  _publishStatus(state) {
    const current = this._status(state, this.now());
    if (current.status !== state.reportedStatus) {
      state.reportedStatus = current.status;
      this._call("onStatus", { symbol: state.symbol, ...current, updatedAt: new Date(this.now()).toISOString() });
    }
  }

  _updated(state, reason) {
    this._publishStatus(state);
    this._call("onUpdate", { symbol: state.symbol, reason, metrics: this.snapshot(state.symbol) });
  }

  ingestAggTrade(trade) {
    const symbol = trade?.symbol ?? trade?.s;
    const state = this._state(symbol);
    const timestamp = this._eventTime({ ...trade, eventTime: trade?.tradeTime ?? trade?.T ?? trade?.eventTime ?? trade?.E });
    const price = Number(trade?.price ?? trade?.p);
    const quantity = Number(trade?.quantity ?? trade?.q);
    const side = aggressorSide(trade);
    const sequenceValue = trade?.sequence ?? trade?.aggregateTradeId ?? trade?.a;
    const sequence = sequenceValue === undefined || sequenceValue === null ? null : Number(sequenceValue);
    if (timestamp === null || !positive(price) || !positive(quantity) || !side || (sequence !== null && !Number.isSafeInteger(sequence))) {
      state.counters.invalidTrades += 1;
      this._call("onError", { symbol, error: new TypeError("Malformed aggregate trade."), event: trade });
      return { accepted: false, reason: "INVALID_TRADE" };
    }
    const key = sequence === null ? `${timestamp}:${price}:${quantity}:${side}` : `a:${sequence}`;
    if (state.tradeKeys.has(key)) {
      state.counters.duplicateTrades += 1;
      return { accepted: false, reason: "DUPLICATE_TRADE" };
    }
    const normalized = { key, timestamp, price, quantity, notional: price * quantity, side, sequence };
    if (state.trades.length && timestamp < state.trades.at(-1).timestamp) state.counters.outOfOrderTrades += 1;
    state.trades.push(normalized);
    state.trades.sort((left, right) => left.timestamp - right.timestamp || (left.sequence ?? 0) - (right.sequence ?? 0));
    state.tradeKeys.add(key);
    state.lastTradeEventTime = Math.max(timestamp, state.lastTradeEventTime ?? 0);
    state.lastTradeReceivedAt = this.now();
    state.tradeContinuityStartedAt ??= state.lastTradeReceivedAt;
    state.counters.trades += 1;
    const restingSide = side === "BUY" ? "ASK" : "BID";
    const addition = state.activeAdds.get(`${restingSide}:${price}`);
    if (addition) addition.executedNotional += normalized.notional;
    this._prune(state);
    while (state.trades.length > this.maxTrades) {
      const removed = state.trades.shift();
      state.tradeKeys.delete(removed.key);
    }
    this._updated(state, "AGG_TRADE");
    return { accepted: true, side, timestamp };
  }

  ingestTrade(trade) { return this.ingestAggTrade(trade); }

  ingestBookSnapshot(symbolOrSnapshot, maybeSnapshot) {
    const raw = maybeSnapshot ?? symbolOrSnapshot;
    const symbol = maybeSnapshot ? symbolOrSnapshot : raw?.symbol ?? raw?.data?.symbol;
    const state = this._state(symbol);
    const data = raw?.data ?? raw;
    const bids = normalizeBookLevels(data?.bids);
    const asks = normalizeBookLevels(data?.asks);
    const lastUpdateId = Number(data?.lastUpdateId);
    const timestamp = this._eventTime(raw, this.now());
    const status = raw?.status;
    const explicitlyUnsynchronized = raw?.synchronized === false || ["UNAVAILABLE", "BUFFERING", "BOOTSTRAPPING", "SYNCING", "GAP", "ERROR"].includes(status);
    if (!bids?.length || !asks?.length || !Number.isSafeInteger(lastUpdateId) || lastUpdateId < 0 || timestamp === null) {
      state.counters.invalidBooks += 1;
      this._setBookUnavailable(state, "Malformed order-book snapshot.");
      this._call("onError", { symbol, error: new TypeError("Malformed order-book snapshot."), snapshot: raw });
      return { accepted: false, reason: "INVALID_SNAPSHOT" };
    }
    const previousBids = state.bids;
    const previousAsks = state.asks;
    const hadSynchronizedBook = state.synchronized;
    state.bids = new Map(bids.map(({ price, quantity }) => [price, quantity]));
    state.asks = new Map(asks.map(({ price, quantity }) => [price, quantity]));
    this._trimMap(state.bids, "bid");
    this._trimMap(state.asks, "ask");
    if (hadSynchronizedBook) {
      const bidPrices = new Set([...previousBids.keys(), ...state.bids.keys()]);
      const askPrices = new Set([...previousAsks.keys(), ...state.asks.keys()]);
      for (const price of bidPrices) this._recordLiquidityChange(state, "BID", price, previousBids.get(price) ?? 0, state.bids.get(price) ?? 0, timestamp, "SNAPSHOT_DIFF", this._rank(previousBids, "bid", price));
      for (const price of askPrices) this._recordLiquidityChange(state, "ASK", price, previousAsks.get(price) ?? 0, state.asks.get(price) ?? 0, timestamp, "SNAPSHOT_DIFF", this._rank(previousAsks, "ask", price));
    }
    state.lastUpdateId = lastUpdateId;
    state.lastBookEventTime = timestamp;
    state.lastBookReceivedAt = this.now();
    state.synchronized = !explicitlyUnsynchronized;
    state.bookStatus = state.synchronized ? (status === "FALLBACK" ? "FALLBACK" : "LIVE") : "UNAVAILABLE";
    state.bookReason = state.synchronized ? "Synchronized book snapshot available." : "Snapshot source reports an unsynchronized book.";
    state.counters.bookUpdates += 1;
    if (!this._validateBook(state)) this._setBookUnavailable(state, "Order-book snapshot is empty, locked, or crossed.");
    this._recordObservation(state, timestamp, "SNAPSHOT");
    this._prune(state);
    this._updated(state, "BOOK_SNAPSHOT");
    return { accepted: true, synchronized: state.synchronized, status: state.bookStatus };
  }

  ingestBookDelta(symbolOrDelta, maybeDelta) {
    const raw = maybeDelta ?? symbolOrDelta;
    const symbol = maybeDelta ? symbolOrDelta : raw?.symbol ?? raw?.s;
    const state = this._state(symbol);
    if (!state.synchronized) {
      this._publishStatus(state);
      return { accepted: false, reason: "BOOK_UNSYNCHRONIZED", status: "UNAVAILABLE" };
    }
    const bids = normalizeBookLevels(raw?.bids ?? raw?.b ?? [], { allowZero: true });
    const asks = normalizeBookLevels(raw?.asks ?? raw?.a ?? [], { allowZero: true });
    const timestamp = this._eventTime(raw, this.now());
    const firstValue = raw?.firstUpdateId ?? raw?.U;
    const finalValue = raw?.finalUpdateId ?? raw?.u;
    const hasSequence = firstValue !== undefined || finalValue !== undefined;
    const firstUpdateId = Number(firstValue);
    const finalUpdateId = Number(finalValue);
    if (!bids || !asks || timestamp === null || (hasSequence && (!Number.isSafeInteger(firstUpdateId) || !Number.isSafeInteger(finalUpdateId) || finalUpdateId < firstUpdateId))) {
      state.counters.invalidBooks += 1;
      return { accepted: false, reason: "INVALID_DELTA" };
    }
    if (hasSequence) {
      if (finalUpdateId <= state.lastUpdateId) return { accepted: false, reason: "STALE_OR_DUPLICATE" };
      const expected = state.lastUpdateId + 1;
      const previous = raw?.previousFinalUpdateId ?? raw?.pu;
      if ((previous !== undefined && Number(previous) !== state.lastUpdateId) || firstUpdateId > expected || finalUpdateId < expected) {
        this._setBookUnavailable(state, "Order-book delta sequence gap detected.");
        return { accepted: false, reason: "SEQUENCE_GAP", expected, status: "UNAVAILABLE" };
      }
      state.lastUpdateId = finalUpdateId;
    }
    this._applyChanges(state, bids, asks, timestamp, "DELTA");
    state.lastBookEventTime = Math.max(timestamp, state.lastBookEventTime ?? 0);
    state.lastBookReceivedAt = this.now();
    state.counters.bookUpdates += 1;
    if (!this._validateBook(state)) {
      this._setBookUnavailable(state, "Order-book delta produced an empty, locked, or crossed book.");
      return { accepted: false, reason: "INVALID_BOOK", status: "UNAVAILABLE" };
    }
    this._recordObservation(state, timestamp, "DELTA");
    this._prune(state);
    this._updated(state, "BOOK_DELTA");
    return { accepted: true, synchronized: true, lastUpdateId: state.lastUpdateId };
  }

  ingestBookTicker(ticker) {
    const symbol = ticker?.symbol ?? ticker?.s;
    const state = this._state(symbol);
    const timestamp = this._eventTime(ticker, this.now());
    const bidPrice = Number(ticker?.bidPrice ?? ticker?.b);
    const bidQuantity = Number(ticker?.bidQuantity ?? ticker?.B);
    const askPrice = Number(ticker?.askPrice ?? ticker?.a);
    const askQuantity = Number(ticker?.askQuantity ?? ticker?.A);
    if (timestamp === null || !positive(bidPrice) || !nonnegative(bidQuantity) || !positive(askPrice) || !nonnegative(askQuantity) || bidPrice >= askPrice) return { accepted: false, reason: "INVALID_BOOK_TICKER" };
    state.ticker = { timestamp, receivedAt: this.now(), bidPrice, bidQuantity, askPrice, askQuantity };
    const mid = (bidPrice + askPrice) / 2;
    this._boundedPush(state.observations, { timestamp, source: "BOOK_TICKER", mid, spread: askPrice - bidPrice, spreadBps: (askPrice - bidPrice) / mid * 10_000, bidNotional: bidPrice * bidQuantity, askNotional: askPrice * askQuantity }, this.maxBookEvents);
    this._prune(state);
    this._updated(state, "BOOK_TICKER");
    return { accepted: true, synchronized: state.synchronized };
  }

  ingestBook(value, maybeValue) {
    const raw = maybeValue ?? value;
    const symbol = maybeValue ? value : raw?.symbol ?? raw?.s ?? raw?.data?.symbol;
    if (raw?.data?.bids || raw?.lastUpdateId !== undefined && !raw?.U && !raw?.firstUpdateId) return this.ingestBookSnapshot(symbol, raw);
    return this.ingestBookDelta(symbol, raw);
  }

  _flowWindows(state, at) {
    const aggressorVolume = {};
    const cvd = {};
    for (const [name, milliseconds] of Object.entries(ORDER_FLOW_WINDOWS)) {
      const summary = summarizeAggressorVolume(state.trades, at - milliseconds);
      aggressorVolume[name] = {
        buyQuantity: summary.buyQuantity, sellQuantity: summary.sellQuantity,
        buyNotional: summary.buyNotional, sellNotional: summary.sellNotional,
        buyTrades: summary.buyTrades, sellTrades: summary.sellTrades,
        totalQuantity: summary.totalQuantity, totalNotional: summary.totalNotional, tradeCount: summary.tradeCount,
      };
      cvd[name] = { quantity: summary.deltaQuantity, notional: summary.deltaNotional };
    }
    return { aggressorVolume, cvd };
  }

  _replenishment(state, at) {
    const events = state.liquidityEvents.filter((event) => event.type === "REPLENISHMENT" && event.timestamp >= at - this.liquidityWindowMs);
    const summarize = (side) => {
      const selected = events.filter((event) => event.side === side);
      return { events: selected.length, quantity: round(selected.reduce((sum, event) => sum + event.quantity, 0)), notional: round(selected.reduce((sum, event) => sum + event.notional, 0)), levels: new Set(selected.map((event) => event.price)).size };
    };
    const bid = summarize("BID");
    const ask = summarize("ASK");
    return { windowMs: this.liquidityWindowMs, bid, ask, dominantSide: bid.notional === ask.notional ? "BALANCED" : bid.notional > ask.notional ? "BID" : "ASK" };
  }

  _disappearing(state, at) {
    const events = state.liquidityEvents.filter((event) => event.type === "DISAPPEARANCE" && event.timestamp >= at - this.liquidityWindowMs);
    const summarize = (side) => {
      const selected = events.filter((event) => event.side === side);
      const notional = selected.reduce((sum, event) => sum + event.notional, 0);
      const unexplainedNotional = selected.reduce((sum, event) => sum + event.unexplainedNotional, 0);
      return { events: selected.length, notional: round(notional), unexplainedNotional: round(unexplainedNotional), unexplainedRatio: round(ratio(unexplainedNotional, notional)) };
    };
    const bid = summarize("BID");
    const ask = summarize("ASK");
    return { windowMs: this.liquidityWindowMs, bid, ask, warning: Math.max(bid.unexplainedRatio, ask.unexplainedRatio) >= 0.7 && bid.events + ask.events >= 2, explanation: "Unexplained removal is displayed after subtracting same-side aggressive execution observed immediately before the book decrease." };
  }

  _spreadInstability(state, at) {
    const observations = state.observations.filter((item) => item.timestamp >= at - this.liquidityWindowMs);
    const spreads = observations.map((item) => item.spreadBps);
    if (!spreads.length) return { available: false, windowMs: this.liquidityWindowMs, samples: 0, reason: "No recent spread observations." };
    const meanBps = spreads.reduce((sum, value) => sum + value, 0) / spreads.length;
    const deviationBps = standardDeviation(spreads);
    const maximumBps = Math.max(...spreads);
    const minimumBps = Math.min(...spreads);
    const changes = spreads.slice(1).map((value, index) => Math.abs(value - spreads[index]));
    const meanAbsoluteChangeBps = changes.length ? changes.reduce((sum, value) => sum + value, 0) / changes.length : 0;
    const instabilityScore = 100 * clamp(0.55 * ratio(deviationBps, Math.max(meanBps, 0.000001)) + 0.45 * ratio(meanAbsoluteChangeBps, Math.max(meanBps, 0.000001)));
    return { available: true, windowMs: this.liquidityWindowMs, samples: spreads.length, meanBps: round(meanBps), standardDeviationBps: round(deviationBps), minimumBps: round(minimumBps), maximumBps: round(maximumBps), meanAbsoluteChangeBps: round(meanAbsoluteChangeBps), score: round(instabilityScore, 2) };
  }

  _absorption(state, at) {
    const windowMs = ORDER_FLOW_WINDOWS["10s"];
    const trades = state.trades.filter((trade) => trade.timestamp >= at - windowMs);
    const observations = state.observations.filter((item) => item.timestamp >= at - windowMs);
    if (!trades.length || observations.length < 2) return { detected: false, side: null, score: 0, windowMs, reason: "Insufficient recent trades or book observations." };
    const flow = summarizeAggressorVolume(trades);
    const startMid = observations[0].mid;
    const endMid = observations.at(-1).mid;
    const moveBps = (endMid - startMid) / startMid * 10_000;
    const buyShare = ratio(flow.buyNotional, flow.totalNotional);
    const sellShare = ratio(flow.sellNotional, flow.totalNotional);
    const dominantSide = buyShare === sellShare ? null : buyShare > sellShare ? "BUY" : "SELL";
    const dominance = Math.max(buyShare, sellShare);
    const directionalMoveBps = dominantSide === "BUY" ? moveBps : dominantSide === "SELL" ? -moveBps : 0;
    const expectedMoveBps = Math.max(0.5, state.observations.at(-1)?.spreadBps ?? 0.5);
    const lackOfProgress = clamp(1 - Math.max(0, directionalMoveBps) / (expectedMoveBps * 2));
    const oppositeLiquidity = dominantSide === "BUY" ? observations.at(-1).askNotional : observations.at(-1).bidNotional;
    const flowToLiquidity = ratio(dominantSide === "BUY" ? flow.buyNotional : flow.sellNotional, oppositeLiquidity);
    const score = dominantSide ? 100 * clamp(0.5 * Math.max(0, (dominance - 0.5) * 2) + 0.3 * lackOfProgress + 0.2 * clamp(flowToLiquidity)) : 0;
    const detected = score >= 65 && dominance >= 0.65 && lackOfProgress >= 0.6;
    return {
      detected, side: detected ? dominantSide : null, score: round(score, 2), windowMs,
      evidence: { dominantAggressor: dominantSide, dominantNotionalShare: round(dominance), aggressiveNotional: dominantSide === "BUY" ? flow.buyNotional : flow.sellNotional, opposingTopNotional: round(oppositeLiquidity), midMoveBps: round(moveBps), directionalProgressBps: round(directionalMoveBps), lackOfProgress: round(lackOfProgress) },
      reason: detected ? `${dominantSide} aggression dominated while mid-price made little progress through opposing liquidity.` : "Aggressor dominance and lack-of-price-progress thresholds were not both met.",
    };
  }

  _spoofRisk(state, at, disappearing, spreadInstability) {
    const events = state.spoofEvents.filter((event) => event.timestamp >= at - this.liquidityWindowMs);
    const eventScore = events.length ? Math.max(...events.map((event) => event.score)) : 0;
    const disappearanceScore = 100 * Math.max(disappearing.bid.unexplainedRatio, disappearing.ask.unexplainedRatio);
    const churnScore = spreadInstability.available ? spreadInstability.score : 0;
    const confidence = clamp(events.length / 3);
    const score = clamp((0.65 * eventScore + 0.25 * disappearanceScore + 0.1 * churnScore) * (0.65 + 0.35 * confidence), 0, 100);
    const level = score >= 70 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";
    return {
      score: round(score, 2), level, windowMs: this.liquidityWindowMs, candidateEvents: events.length,
      components: { rapidAddCancel: round(eventScore, 2), unexplainedDisappearance: round(disappearanceScore, 2), quoteInstability: round(churnScore, 2), repetitionConfidence: round(confidence) },
      evidence: events.slice(-5).map((event) => ({ side: event.side, price: event.price, rank: event.rank, ageMs: event.ageMs, addedNotional: round(event.addedNotional), cancelledNotional: round(event.cancelledNotional), executedNotional: round(event.executedNotional), cancellationRatio: round(event.cancellationRatio), reason: event.reason })),
      explanation: "Heuristic only: risk rises when near-top liquidity is added then rapidly cancelled without matching aggressive execution, especially with repeated unexplained removals and unstable quotes.",
    };
  }

  _status(state, at) {
    const tradeAgeMs = state.lastTradeReceivedAt === null ? null : Math.max(0, at - state.lastTradeReceivedAt);
    const continuityCoverageMs = state.tradeContinuityStartedAt === null ? 0 : Math.max(0, at - state.tradeContinuityStartedAt);
    const continuity = { coverageMs: continuityCoverageMs, requiredMs: this.retentionMs, complete: continuityCoverageMs >= this.retentionMs };
    if (!state.synchronized) return { status: "UNAVAILABLE", reason: state.bookReason, bookAgeMs: null, tradeAgeMs, continuity };
    const bookAgeMs = state.lastBookReceivedAt === null ? Infinity : Math.max(0, at - state.lastBookReceivedAt);
    if (state.bookStatus === "FALLBACK") return { status: "REST_FALLBACK", reason: "Order flow is unavailable on a REST/fallback book; providers are not mixed.", bookAgeMs, tradeAgeMs, continuity };
    if (bookAgeMs > this.staleAfterMs) return { status: "STALE", reason: "Synchronized order book is stale.", bookAgeMs, tradeAgeMs, continuity };
    if (tradeAgeMs === null) return { status: "UNAVAILABLE", reason: "Aggressor trades are unavailable.", bookAgeMs, tradeAgeMs, continuity };
    if (tradeAgeMs > this.tradeStaleAfterMs) return { status: "STALE", reason: "Aggressor trades are stale.", bookAgeMs, tradeAgeMs, continuity };
    if (!continuity.complete) return { status: "RECOVERING", reason: `Aggressor-trade continuity is rebuilding (${continuityCoverageMs}ms of ${this.retentionMs}ms required).`, bookAgeMs, tradeAgeMs, continuity };
    return { status: "LIVE", reason: "Fresh synchronized order book and a complete continuous aggressor-trade window are available.", bookAgeMs, tradeAgeMs, continuity };
  }

  freshness(symbol, at = this.now()) {
    const state = this._state(symbol);
    const overall = this._status(state, at);
    const tradeAgeMs = state.lastTradeReceivedAt === null ? null : Math.max(0, at - state.lastTradeReceivedAt);
    const tickerAgeMs = state.ticker === null ? null : Math.max(0, at - state.ticker.receivedAt);
    return {
      ...overall,
      evaluatedAt: new Date(at).toISOString(),
      book: { status: !state.synchronized ? "UNAVAILABLE" : state.bookStatus === "FALLBACK" ? "REST_FALLBACK" : overall.bookAgeMs <= this.staleAfterMs ? "LIVE" : "STALE", ageMs: overall.bookAgeMs, eventTime: state.lastBookEventTime === null ? null : new Date(state.lastBookEventTime).toISOString() },
      trades: { status: tradeAgeMs === null ? "UNAVAILABLE" : tradeAgeMs > this.tradeStaleAfterMs ? "STALE" : overall.continuity?.complete ? "LIVE" : "RECOVERING", ageMs: tradeAgeMs, eventTime: state.lastTradeEventTime === null ? null : new Date(state.lastTradeEventTime).toISOString(), continuity: overall.continuity },
      bookTicker: { status: tickerAgeMs === null ? "UNAVAILABLE" : tickerAgeMs <= this.staleAfterMs ? "LIVE" : "STALE", ageMs: tickerAgeMs, eventTime: state.ticker === null ? null : new Date(state.ticker.timestamp).toISOString() },
    };
  }

  snapshot(symbol, at = this.now()) {
    const state = this._state(symbol);
    this._prune(state, at);
    const freshness = this.freshness(symbol, at);
    if (!state.synchronized) {
      return {
        symbol, status: "UNAVAILABLE", reason: state.bookReason, generatedAt: new Date(at).toISOString(), freshness,
        imbalance: null, aggressorVolume: null, cvd: null, absorption: null, replenishment: null,
        disappearingLiquidity: null, spreadInstability: null, microprice: null, spoofRisk: null,
        counters: { ...state.counters },
      };
    }
    const { bids, asks, bestBid, bestAsk } = this._currentTop(state);
    const imbalance = Object.fromEntries(BOOK_IMBALANCE_LEVELS.map((levels) => [levels, computeBookImbalance(bids, asks, levels)]));
    const { aggressorVolume, cvd } = this._flowWindows(state, at);
    const replenishment = this._replenishment(state, at);
    const disappearingLiquidity = this._disappearing(state, at);
    const spreadInstability = this._spreadInstability(state, at);
    const spoofRisk = this._spoofRisk(state, at, disappearingLiquidity, spreadInstability);
    return {
      symbol,
      status: freshness.status,
      reason: freshness.reason,
      generatedAt: new Date(at).toISOString(),
      book: { synchronized: true, status: state.bookStatus, lastUpdateId: state.lastUpdateId, levels: { bids: bids.length, asks: asks.length } },
      imbalance,
      aggressorVolume,
      cvd,
      absorption: this._absorption(state, at),
      replenishment,
      disappearingLiquidity,
      spreadInstability,
      microprice: computeMicroprice(bestBid, bestAsk),
      spoofRisk,
      freshness,
      counters: { ...state.counters },
      bounds: { retainedTrades: state.trades.length, retainedBookObservations: state.observations.length, retainedLiquidityEvents: state.liquidityEvents.length, retainedSpoofEvents: state.spoofEvents.length, maxTrades: this.maxTrades, maxBookEvents: this.maxBookEvents, maxLiquidityEvents: this.maxLiquidityEvents },
    };
  }

  metrics(symbol, at) { return this.snapshot(symbol, at); }
  analyze(symbol, at) { return this.snapshot(symbol, at); }
  status(symbol, at = this.now()) { return { symbol, ...this._status(this._state(symbol), at) }; }
  getStatus(symbol, at) { return this.status(symbol, at); }

  reset(symbol, reason = "Order-flow state reset requested.") {
    this.states.set(symbol, stateFor(symbol));
    const state = this.states.get(symbol);
    state.bookReason = reason;
    this._call("onStatus", { symbol, status: "UNAVAILABLE", reason, updatedAt: new Date(this.now()).toISOString() });
    return this.snapshot(symbol);
  }

  resetAll(reason) {
    for (const symbol of [...this.states.keys()]) this.reset(symbol, reason);
  }
}

export { OrderFlowAnalyzer as OrderFlow };
