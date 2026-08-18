const DEFAULT_MAX_LEVELS = 5_000;
const DEFAULT_MAX_BUFFER_EVENTS = 10_000;
const DEFAULT_TOP_LEVELS = 20;

const integer = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const nonnegative = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;

export function toTimestamp(value) {
  if (value instanceof Date) value = value.getTime();
  if (typeof value === "string" && value.trim() !== "") value = /^\d+$/.test(value) ? Number(value) : new Date(value).getTime();
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

export function isValidTimestamp(value, { now = Date.now(), maxFutureSkewMs = 5_000 } = {}) {
  const timestamp = toTimestamp(value);
  return timestamp !== null && timestamp <= Number(now) + maxFutureSkewMs;
}

export function normalizePriceLevels(levels, { allowZero = true } = {}) {
  if (!Array.isArray(levels)) return null;
  const normalized = [];
  for (const level of levels) {
    const price = Number(Array.isArray(level) ? level[0] : level?.price ?? level?.p);
    const quantity = Number(Array.isArray(level) ? level[1] : level?.quantity ?? level?.qty ?? level?.q);
    if (!positive(price) || !(allowZero ? nonnegative(quantity) : positive(quantity))) return null;
    normalized.push({ price, quantity });
  }
  return normalized;
}

export function normalizeDepthEvent(event, { symbol, now = Date.now(), maxFutureSkewMs = 5_000 } = {}) {
  const firstUpdateId = Number(event?.firstUpdateId ?? event?.U);
  const finalUpdateId = Number(event?.finalUpdateId ?? event?.u);
  const previousValue = event?.previousFinalUpdateId ?? event?.pu;
  const previousFinalUpdateId = previousValue === undefined || previousValue === null ? null : Number(previousValue);
  const bids = normalizePriceLevels(event?.bids ?? event?.b ?? []);
  const asks = normalizePriceLevels(event?.asks ?? event?.a ?? []);
  const rawTimestamp = event?.eventTime ?? event?.E ?? event?.transactionTime ?? event?.T;
  const eventTime = rawTimestamp === undefined || rawTimestamp === null ? Number(now) : toTimestamp(rawTimestamp);
  const resolvedSymbol = symbol ?? event?.symbol ?? event?.s;
  if (typeof resolvedSymbol !== "string" || !resolvedSymbol || !integer(firstUpdateId) || !integer(finalUpdateId) || finalUpdateId < firstUpdateId || (previousFinalUpdateId !== null && !integer(previousFinalUpdateId)) || !bids || !asks || !isValidTimestamp(eventTime, { now, maxFutureSkewMs })) return null;
  return { symbol: resolvedSymbol, eventTime, firstUpdateId, finalUpdateId, previousFinalUpdateId, bids, asks };
}

export function normalizeDepthSnapshot(snapshot, { symbol, now = Date.now(), maxFutureSkewMs = 5_000, allowMissingUpdateId = false } = {}) {
  const data = snapshot?.data ?? snapshot;
  const rawLastUpdateId = data?.lastUpdateId;
  const lastUpdateId = rawLastUpdateId === undefined || rawLastUpdateId === null ? (allowMissingUpdateId ? 0 : NaN) : Number(rawLastUpdateId);
  const bids = normalizePriceLevels(data?.bids, { allowZero: false });
  const asks = normalizePriceLevels(data?.asks, { allowZero: false });
  const rawTimestamp = snapshot?.sourceTimestamp ?? snapshot?.eventTime ?? snapshot?.receivedAt ?? data?.eventTime;
  const sourceTimestamp = rawTimestamp === undefined || rawTimestamp === null ? Number(now) : toTimestamp(rawTimestamp);
  const resolvedSymbol = symbol ?? snapshot?.symbol ?? data?.symbol;
  if (!integer(lastUpdateId) || !bids || !asks || !bids.length || !asks.length || !isValidTimestamp(sourceTimestamp, { now, maxFutureSkewMs })) return null;
  return {
    symbol: resolvedSymbol,
    lastUpdateId,
    sequenceAvailable: rawLastUpdateId !== undefined && rawLastUpdateId !== null,
    bids,
    asks,
    sourceTimestamp,
    source: snapshot?.source ?? data?.source ?? null,
    sourceName: snapshot?.sourceName ?? null,
    sourceUrl: snapshot?.sourceUrl ?? null,
    receivedAt: snapshot?.receivedAt ?? new Date(Number(now)).toISOString(),
    failover: snapshot?.failover ?? null,
  };
}

function sortedLevels(levels, side, limit = Infinity) {
  return [...levels.entries()]
    .map(([price, quantity]) => ({ price, quantity }))
    .sort((left, right) => side === "bid" ? right.price - left.price : left.price - right.price)
    .slice(0, limit);
}

function initialState(symbol) {
  return {
    symbol,
    status: "UNAVAILABLE",
    synchronized: false,
    snapshotLoaded: false,
    lastUpdateId: null,
    lastEventTime: null,
    lastReceivedAt: null,
    source: null,
    sourceName: null,
    sourceUrl: null,
    failover: null,
    reason: "No depth snapshot has been loaded.",
    bids: new Map(),
    asks: new Map(),
    buffer: [],
    seenRanges: new Set(),
    lastArrivedFinalUpdateId: null,
    generation: 0,
    counters: { applied: 0, duplicate: 0, stale: 0, outOfOrder: 0, gaps: 0, invalid: 0, bufferDrops: 0 },
  };
}

export class OrderBookService {
  constructor({
    symbols = [], provider = null, snapshotFetcher = null, fallbackProvider = null,
    depthLimit = DEFAULT_TOP_LEVELS, topLevelLimit = depthLimit, maxLevels = DEFAULT_MAX_LEVELS,
    maxBufferEvents = DEFAULT_MAX_BUFFER_EVENTS, maxFutureSkewMs = 5_000, now = Date.now,
    onUpdate = null, onStatus = null, onGap = null, onReset = null, onFallback = null, onError = null,
    callbacks = {},
  } = {}) {
    this.provider = provider;
    this.snapshotFetcher = snapshotFetcher;
    this.fallbackProvider = fallbackProvider;
    this.depthLimit = Math.max(1, Math.floor(depthLimit));
    this.topLevelLimit = Math.max(1, Math.floor(topLevelLimit));
    this.maxLevels = Math.max(this.topLevelLimit, Math.floor(maxLevels));
    this.maxBufferEvents = Math.max(1, Math.floor(maxBufferEvents));
    this.maxFutureSkewMs = Math.max(0, Number(maxFutureSkewMs));
    this.now = now;
    this.callbacks = {
      onUpdate: onUpdate ?? callbacks.onUpdate,
      onStatus: onStatus ?? callbacks.onStatus,
      onGap: onGap ?? callbacks.onGap,
      onReset: onReset ?? callbacks.onReset,
      onFallback: onFallback ?? callbacks.onFallback,
      onError: onError ?? callbacks.onError,
    };
    this.books = new Map(symbols.map((symbol) => [symbol, initialState(symbol)]));
  }

  _state(symbol) {
    if (typeof symbol !== "string" || !symbol) throw new TypeError("A non-empty symbol is required.");
    if (!this.books.has(symbol)) this.books.set(symbol, initialState(symbol));
    return this.books.get(symbol);
  }

  _call(name, payload) {
    try { this.callbacks[name]?.(payload); }
    catch (error) { if (name !== "onError") try { this.callbacks.onError?.({ error, callback: name, payload }); } catch {} }
  }

  _setStatus(state, status, reason, details = null) {
    const changed = state.status !== status || state.reason !== reason;
    state.status = status;
    state.reason = reason;
    if (changed) this._call("onStatus", { symbol: state.symbol, status, synchronized: state.synchronized, reason, details, updatedAt: new Date(this.now()).toISOString() });
  }

  _trimSide(levels, side) {
    if (levels.size <= this.maxLevels) return;
    const keep = sortedLevels(levels, side, this.maxLevels);
    levels.clear();
    for (const level of keep) levels.set(level.price, level.quantity);
  }

  _applyLevels(state, bids, asks) {
    for (const { price, quantity } of bids) quantity === 0 ? state.bids.delete(price) : state.bids.set(price, quantity);
    for (const { price, quantity } of asks) quantity === 0 ? state.asks.delete(price) : state.asks.set(price, quantity);
    this._trimSide(state.bids, "bid");
    this._trimSide(state.asks, "ask");
  }

  _bookIsValid(state) {
    const bestBid = sortedLevels(state.bids, "bid", 1)[0]?.price;
    const bestAsk = sortedLevels(state.asks, "ask", 1)[0]?.price;
    return positive(bestBid) && positive(bestAsk) && bestBid < bestAsk;
  }

  _emitUpdate(state, reason, event = null) {
    this._call("onUpdate", { symbol: state.symbol, reason, event, book: this.snapshot(state.symbol) });
  }

  _buffer(state, event) {
    const duplicate = state.buffer.some((item) => item.firstUpdateId === event.firstUpdateId && item.finalUpdateId === event.finalUpdateId);
    if (duplicate) { state.counters.duplicate += 1; return { accepted: false, reason: "DUPLICATE_BUFFERED" }; }
    state.buffer.push(event);
    if (state.buffer.length > this.maxBufferEvents) {
      state.buffer.splice(0, state.buffer.length - this.maxBufferEvents);
      state.counters.bufferDrops += 1;
      this._markGap(state, "Depth buffer capacity exceeded; a new snapshot is required.", { maxBufferEvents: this.maxBufferEvents }, false);
      return { accepted: false, reason: "BUFFER_OVERFLOW" };
    }
    if (state.status === "UNAVAILABLE") this._setStatus(state, "BUFFERING", "Buffering depth updates pending a REST snapshot.");
    return { accepted: true, reason: "BUFFERED" };
  }

  _markGap(state, reason, details = null, retainTrigger = true, trigger = null) {
    state.synchronized = false;
    state.snapshotLoaded = false;
    state.counters.gaps += 1;
    state.buffer = retainTrigger && trigger ? [trigger] : [];
    this._setStatus(state, "GAP", reason, details);
    this._call("onGap", { symbol: state.symbol, reason, details, lastUpdateId: state.lastUpdateId });
  }

  _consume(state, event) {
    if (event.finalUpdateId <= state.lastUpdateId) {
      state.counters.stale += 1;
      return { accepted: false, applied: false, reason: "STALE", continuity: "STALE", lastUpdateId: state.lastUpdateId };
    }
    const expected = state.lastUpdateId + 1;
    if (event.previousFinalUpdateId !== null && event.previousFinalUpdateId !== state.lastUpdateId) {
      if (event.previousFinalUpdateId < state.lastUpdateId && event.firstUpdateId <= expected && event.finalUpdateId >= expected) {
        state.counters.outOfOrder += 1;
      } else {
        this._markGap(state, "Depth previous-update id does not match the local book.", { expectedPrevious: state.lastUpdateId, receivedPrevious: event.previousFinalUpdateId }, true, event);
        return { accepted: false, applied: false, reason: "PREVIOUS_ID_GAP", expected };
      }
    }
    if (event.firstUpdateId > expected || event.finalUpdateId < expected) {
      if (event.finalUpdateId < expected) {
        state.counters.outOfOrder += 1;
        return { accepted: false, applied: false, reason: "OUT_OF_ORDER", expected };
      }
      this._markGap(state, "Depth update sequence contains a gap.", { expected, receivedFirst: event.firstUpdateId, receivedFinal: event.finalUpdateId }, true, event);
      return { accepted: false, applied: false, reason: "SEQUENCE_GAP", expected };
    }
    this._applyLevels(state, event.bids, event.asks);
    state.lastUpdateId = event.finalUpdateId;
    state.lastEventTime = event.eventTime;
    state.lastReceivedAt = this.now();
    state.synchronized = true;
    state.snapshotLoaded = true;
    state.counters.applied += 1;
    if (!this._bookIsValid(state)) {
      this._markGap(state, "Applied depth update produced an empty, locked, or crossed book.", null, true, event);
      return { accepted: false, applied: false, reason: "INVALID_BOOK" };
    }
    this._setStatus(state, "LIVE", "Snapshot and Binance diff-depth stream are synchronized.");
    this._emitUpdate(state, "DEPTH_APPLIED", event);
    return { accepted: true, applied: true, reason: "APPLIED", lastUpdateId: state.lastUpdateId };
  }

  ingestDepth(symbolOrEvent, maybeEvent) {
    const raw = maybeEvent ?? symbolOrEvent;
    const symbol = maybeEvent ? symbolOrEvent : raw?.symbol ?? raw?.s;
    const state = this._state(symbol);
    const event = normalizeDepthEvent(raw, { symbol, now: this.now(), maxFutureSkewMs: this.maxFutureSkewMs });
    if (!event) {
      state.counters.invalid += 1;
      const error = new TypeError("Malformed Binance diff-depth event.");
      this._call("onError", { symbol, error, event: raw });
      return { accepted: false, applied: false, reason: "INVALID_EVENT" };
    }
    const rangeKey = `${event.firstUpdateId}:${event.finalUpdateId}`;
    if (state.seenRanges.has(rangeKey)) {
      state.counters.duplicate += 1;
      return { accepted: false, applied: false, reason: "DUPLICATE", continuity: "DUPLICATE", firstUpdateId: event.firstUpdateId, finalUpdateId: event.finalUpdateId };
    }
    const outOfOrder = Number.isInteger(state.lastArrivedFinalUpdateId) && event.finalUpdateId < state.lastArrivedFinalUpdateId;
    state.seenRanges.add(rangeKey);
    if (state.seenRanges.size > this.maxBufferEvents * 2) state.seenRanges.delete(state.seenRanges.values().next().value);
    state.lastArrivedFinalUpdateId = Math.max(state.lastArrivedFinalUpdateId ?? event.finalUpdateId, event.finalUpdateId);
    if (outOfOrder) state.counters.outOfOrder += 1;
    let result;
    if (state.status === "FALLBACK") {
      const buffered = this._buffer(state, event);
      result = { ...buffered, accepted: buffered.accepted, applied: false, reason: "FALLBACK_BUFFERED", requiresBinanceSnapshot: true };
    } else if (!state.snapshotLoaded || ["UNAVAILABLE", "BUFFERING", "BOOTSTRAPPING", "GAP", "ERROR"].includes(state.status)) result = this._buffer(state, event);
    else result = this._consume(state, event);
    return { ...result, continuity: outOfOrder ? "OUT_OF_ORDER" : result.continuity ?? (result.applied ? "CONTINUOUS" : result.reason) };
  }

  ingest(event) { return this.ingestDepth(event); }

  beginBootstrap(symbol, { clearBuffer = false } = {}) {
    const state = this._state(symbol);
    state.generation += 1;
    state.synchronized = false;
    state.snapshotLoaded = false;
    if (clearBuffer) state.buffer = [];
    this._setStatus(state, "BOOTSTRAPPING", "Loading a REST depth snapshot while buffering stream updates.");
    return state.generation;
  }

  applySnapshot(symbolOrSnapshot, maybeSnapshot, options = {}) {
    const raw = maybeSnapshot ?? symbolOrSnapshot;
    const symbol = maybeSnapshot ? symbolOrSnapshot : options.symbol ?? raw?.symbol ?? raw?.data?.symbol;
    const state = this._state(symbol);
    const snapshot = normalizeDepthSnapshot(raw, { symbol, now: this.now(), maxFutureSkewMs: this.maxFutureSkewMs, allowMissingUpdateId: options.fallback === true });
    if (!snapshot) {
      state.counters.invalid += 1;
      const error = new TypeError("Malformed depth snapshot.");
      this._setStatus(state, "ERROR", error.message);
      this._call("onError", { symbol, error, snapshot: raw });
      return { accepted: false, synchronized: false, reason: "INVALID_SNAPSHOT" };
    }
    state.bids = new Map(snapshot.bids.map(({ price, quantity }) => [price, quantity]));
    state.asks = new Map(snapshot.asks.map(({ price, quantity }) => [price, quantity]));
    this._trimSide(state.bids, "bid");
    this._trimSide(state.asks, "ask");
    state.lastUpdateId = snapshot.lastUpdateId;
    state.lastEventTime = snapshot.sourceTimestamp;
    state.lastReceivedAt = this.now();
    state.source = snapshot.source;
    state.sourceName = snapshot.sourceName;
    state.sourceUrl = snapshot.sourceUrl;
    state.failover = snapshot.failover;
    state.snapshotLoaded = true;
    state.synchronized = false;
    if (!this._bookIsValid(state)) {
      this._markGap(state, "REST snapshot is empty, locked, or crossed.");
      return { accepted: false, synchronized: false, reason: "INVALID_BOOK" };
    }
    if (options.fallback === true) {
      state.buffer = [];
      state.synchronized = true;
      this._setStatus(state, "FALLBACK", options.reason ?? "Using a fallback REST order-book snapshot.");
      this._call("onFallback", { symbol, reason: state.reason, book: this.snapshot(symbol) });
      this._emitUpdate(state, "FALLBACK_SNAPSHOT");
      return { accepted: true, synchronized: true, fallback: true, lastUpdateId: state.lastUpdateId };
    }
    const pending = state.buffer
      .filter((event) => event.finalUpdateId > state.lastUpdateId)
      .sort((left, right) => left.firstUpdateId - right.firstUpdateId || left.finalUpdateId - right.finalUpdateId);
    state.buffer = [];
    if (!pending.length) {
      this._setStatus(state, "SYNCING", "Snapshot loaded; waiting for a depth event that bridges lastUpdateId + 1.");
      this._emitUpdate(state, "SNAPSHOT_LOADED");
      return { accepted: true, synchronized: false, reason: "WAITING_FOR_BRIDGE", lastUpdateId: state.lastUpdateId };
    }
    for (let index = 0; index < pending.length; index += 1) {
      const result = this._consume(state, pending[index]);
      if (result.reason === "STALE" || result.reason === "OUT_OF_ORDER") continue;
      if (!result.applied) {
        for (const event of pending.slice(index + 1)) this._buffer(state, event);
        return { accepted: true, synchronized: false, reason: result.reason, lastUpdateId: state.lastUpdateId };
      }
    }
    return { accepted: true, synchronized: state.synchronized, reason: state.synchronized ? "SYNCHRONIZED" : "WAITING_FOR_BRIDGE", lastUpdateId: state.lastUpdateId };
  }

  async bootstrap(symbol, source = null, options = {}) {
    const generation = this.beginBootstrap(symbol, options);
    const state = this._state(symbol);
    try {
      let snapshot;
      if (source && typeof source !== "function" && typeof source?.depth !== "function") snapshot = source;
      else {
        const fetcher = typeof source === "function" ? source : source?.depth ? (value, limit) => source.depth(value, limit) : this.snapshotFetcher ? this.snapshotFetcher : this.provider?.depth ? (value, limit) => this.provider.depth(value, limit) : null;
        if (!fetcher) throw new Error("No depth snapshot fetcher is configured.");
        snapshot = await fetcher(symbol, this.depthLimit);
      }
      if (state.generation !== generation) return { accepted: false, synchronized: false, reason: "SUPERSEDED" };
      return this.applySnapshot(symbol, snapshot, options);
    } catch (error) {
      if (state.generation !== generation) return { accepted: false, synchronized: false, reason: "SUPERSEDED" };
      this._setStatus(state, "ERROR", `Depth bootstrap failed: ${error.message}`);
      this._call("onError", { symbol, error, operation: "bootstrap" });
      if (options.fallback !== false && this.fallbackProvider?.depth) {
        try {
          const fallback = await this.fallbackProvider.depth(symbol, this.depthLimit);
          const attributedFallback = { ...fallback, failover: { active: true, primarySource: this.provider?.sourceId ?? null, primaryName: this.provider?.name ?? null, primaryError: error.message, fallbackSource: fallback.source ?? this.fallbackProvider.sourceId ?? null, fallbackName: fallback.sourceName ?? this.fallbackProvider.name ?? null, switchedAt: new Date(this.now()).toISOString() } };
          return this.applySnapshot(symbol, attributedFallback, { fallback: true, reason: `Primary depth bootstrap failed: ${error.message}` });
        } catch (fallbackError) { this._call("onError", { symbol, error: fallbackError, operation: "fallback" }); }
      }
      return { accepted: false, synchronized: false, reason: "BOOTSTRAP_ERROR", error };
    }
  }

  applyFallback(symbol, snapshot, reason = "Using a fallback REST order-book snapshot.") {
    return this.applySnapshot(symbol, snapshot, { fallback: true, reason });
  }

  fallback(symbol, snapshot, reason) { return this.applyFallback(symbol, snapshot, reason); }

  ingestBookTicker(event) {
    const symbol = event?.symbol ?? event?.s;
    const state = this._state(symbol);
    const bidPrice = Number(event?.bidPrice ?? event?.b);
    const bidQuantity = Number(event?.bidQuantity ?? event?.B);
    const askPrice = Number(event?.askPrice ?? event?.a);
    const askQuantity = Number(event?.askQuantity ?? event?.A);
    const rawTime = event?.eventTime ?? event?.E;
    const eventTime = rawTime === undefined ? this.now() : toTimestamp(rawTime);
    if (!positive(bidPrice) || !nonnegative(bidQuantity) || !positive(askPrice) || !nonnegative(askQuantity) || bidPrice >= askPrice || !isValidTimestamp(eventTime, { now: this.now(), maxFutureSkewMs: this.maxFutureSkewMs })) {
      state.counters.invalid += 1;
      return { accepted: false, reason: "INVALID_BOOK_TICKER" };
    }
    return { accepted: true, synchronized: state.synchronized, matchesBook: state.synchronized ? sortedLevels(state.bids, "bid", 1)[0]?.price === bidPrice && sortedLevels(state.asks, "ask", 1)[0]?.price === askPrice : null };
  }

  topLevels(symbol, limit = this.topLevelLimit) {
    const state = this._state(symbol);
    const size = Math.max(1, Math.min(this.maxLevels, Math.floor(limit)));
    return { bids: sortedLevels(state.bids, "bid", size), asks: sortedLevels(state.asks, "ask", size) };
  }

  getTopLevels(symbol, limit) { return this.topLevels(symbol, limit); }

  snapshot(symbol, limit = this.topLevelLimit) {
    const state = this._state(symbol);
    const { bids, asks } = this.topLevels(symbol, limit);
    return {
      symbol,
      status: state.status,
      synchronized: state.synchronized,
      reason: state.reason,
      source: state.source,
      sourceName: state.sourceName,
      sourceUrl: state.sourceUrl,
      sourceTimestamp: state.lastEventTime === null ? null : new Date(state.lastEventTime).toISOString(),
      receivedAt: state.lastReceivedAt === null ? null : new Date(state.lastReceivedAt).toISOString(),
      failover: state.failover,
      data: { lastUpdateId: state.lastUpdateId, bids, asks },
      sequenceAvailable: state.status !== "FALLBACK" || state.lastUpdateId !== 0,
      bufferSize: state.buffer.length,
      counters: { ...state.counters },
    };
  }

  getSnapshot(symbol, limit) { return this.snapshot(symbol, limit); }

  status(symbol) {
    const state = this._state(symbol);
    return { symbol, status: state.status, synchronized: state.synchronized, reason: state.reason, lastUpdateId: state.lastUpdateId, bufferSize: state.buffer.length, counters: { ...state.counters } };
  }

  getStatus(symbol) { return this.status(symbol); }

  reset(symbol, reason = "Order book reset requested.") {
    const previous = this._state(symbol);
    const generation = previous.generation + 1;
    const state = initialState(symbol);
    state.generation = generation;
    state.reason = reason;
    this.books.set(symbol, state);
    this._call("onReset", { symbol, reason });
    this._call("onStatus", { symbol, status: "UNAVAILABLE", synchronized: false, reason, updatedAt: new Date(this.now()).toISOString() });
    return this.snapshot(symbol);
  }

  resetAll(reason) {
    for (const symbol of [...this.books.keys()]) this.reset(symbol, reason);
  }
}
