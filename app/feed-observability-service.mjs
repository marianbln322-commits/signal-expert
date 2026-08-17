import { randomUUID } from "node:crypto";

const nowIso = () => new Date().toISOString();

export class FeedObservabilityService {
  constructor({ database, provider = "BINANCE_SPOT_STREAM", staleAfterMs = 15000 }) {
    this.database = database; this.provider = provider; this.staleAfterMs = staleAfterMs;
    this.sessionId = randomUUID(); this.states = new Map(); this.startedAt = nowIso();
  }
  key(symbol, channel) { return `${this.provider}:${symbol}:${channel}`; }
  update(symbol, channel, update = {}) {
    const key = this.key(symbol, channel); const previous = this.states.get(key) ?? { provider: this.provider, symbol, channel, status: "STARTING", gapCount: 0, reconnectCount: 0 };
    const state = { ...previous, ...update, provider: this.provider, symbol, channel, sessionId: this.sessionId, updatedAt: nowIso() };
    this.states.set(key, state); this.database.upsertFeedChannelState(state);
    if (state.status !== previous.status) this.database.recordFeedEvent({ eventKey: `${key}:${state.status}:${state.updatedAt}`, ...state, eventType: "STATUS_CHANGED", severity: ["GAP", "STALE", "ERROR"].includes(state.status) ? "ERROR" : state.status === "RECOVERING" ? "WARN" : "INFO", occurredAt: state.updatedAt });
    return state;
  }
  message(symbol, channel, { eventAt = Date.now(), sequence = null, lagMs = null } = {}) {
    const timestamp = nowIso(); const previous = this.states.get(this.key(symbol, channel)); const requiresReconciliation = ["GAP", "ERROR"].includes(previous?.status);
    if (!requiresReconciliation) {
      this.resolveAlert("STREAM_DISCONNECTED", symbol, channel, { recoveredAt: timestamp });
      this.resolveAlert("STREAM_STALE", symbol, channel, { recoveredAt: timestamp });
    }
    return this.update(symbol, channel, { status: requiresReconciliation ? previous.status : "LIVE", connectedAt: previous?.connectedAt ?? timestamp, lastMessageAt: timestamp, lastEventAt: new Date(eventAt).toISOString(), lastSequence: sequence, lagMs: lagMs ?? Math.max(0, Date.now() - eventAt), lastError: requiresReconciliation ? previous.lastError : null });
  }
  disconnected(symbol, channel, error, reconnect = true) {
    const prior = this.states.get(this.key(symbol, channel));
    const state = this.update(symbol, channel, { status: reconnect ? "RECOVERING" : "STOPPED", reconnectCount: (prior?.reconnectCount ?? 0) + (reconnect ? 1 : 0), lastError: error ?? null });
    if (reconnect) this.openAlert("STREAM_DISCONNECTED", symbol, channel, "WARN", { error });
    return state;
  }
  channelStatus(symbol, channel) { return this.states.get(this.key(symbol, channel))?.status ?? "UNAVAILABLE"; }
  invalid(symbol, channel, evidence = {}) {
    const state = this.update(symbol, channel, { status: "ERROR", lastError: evidence.reason ?? "Malformed stream event" });
    this.openAlert("INVALID_STREAM_EVENT", symbol, channel, "ERROR", evidence); return state;
  }
  gap(symbol, channel, evidence) {
    const prior = this.states.get(this.key(symbol, channel));
    const state = this.update(symbol, channel, { status: "GAP", gapCount: (prior?.gapCount ?? 0) + 1, lastError: "Sequence or candle gap detected" });
    this.openAlert("FEED_GAP", symbol, channel, "ERROR", evidence); return state;
  }
  reconciled(symbol, channel, evidence = {}) {
    this.resolveAlert("FEED_GAP", symbol, channel, evidence); this.resolveAlert("INVALID_STREAM_EVENT", symbol, channel, evidence); this.resolveAlert("STREAM_DISCONNECTED", symbol, channel, evidence);
    const previous = this.states.get(this.key(symbol, channel)); const lastMessageAt = new Date(previous?.lastMessageAt).getTime();
    const streamCurrent = Number.isFinite(lastMessageAt) && Date.now() - lastMessageAt <= this.staleAfterMs;
    return this.update(symbol, channel, { status: streamCurrent ? "LIVE" : "RECOVERING", lastError: streamCurrent ? null : "REST reconciled; waiting for a valid current stream event" });
  }
  openAlert(type, symbol, channel, severity, payload = {}) { return this.database.upsertOperationalAlert({ fingerprint: `${type}:${this.provider}:${symbol}:${channel}`, alertType: type, provider: this.provider, symbol, channel, severity, status: "OPEN", observedAt: nowIso(), payload }); }
  resolveAlert(type, symbol, channel, payload = {}) { return this.database.resolveOperationalAlert(`${type}:${this.provider}:${symbol}:${channel}`, nowIso(), payload); }
  checkStale(now = Date.now()) {
    for (const state of this.states.values()) {
      if (!["LIVE", "RECOVERING"].includes(state.status)) continue;
      const last = new Date(state.lastMessageAt).getTime();
      if (!Number.isFinite(last) || now - last <= this.staleAfterMs) continue;
      this.update(state.symbol, state.channel, { status: "STALE", lastError: `No stream message for ${now - last}ms` });
      this.openAlert("STREAM_STALE", state.symbol, state.channel, "ERROR", { staleMs: now - last, thresholdMs: this.staleAfterMs });
    }
  }
  status(symbol = null) {
    this.checkStale();
    const channels = [...this.states.values()].filter((item) => !symbol || item.symbol === symbol);
    const openAlerts = this.database.operationalAlerts({ status: "OPEN", limit: 50 }).filter((item) => !symbol || item.symbol === symbol);
    const required = channels.filter((item) => ["TRADE", "BOOK_TICKER", "KLINE_1M", "KLINE_5M"].includes(item.channel));
    const actionReady = required.length > 0 && required.every((item) => item.status === "LIVE");
    return { provider: this.provider, sessionId: this.sessionId, startedAt: this.startedAt, actionReady, status: actionReady ? "LIVE" : channels.some((item) => item.status === "LIVE") ? "DEGRADED" : "RECOVERING", channels, openAlerts };
  }
}
