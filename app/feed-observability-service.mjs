import { randomUUID } from "node:crypto";

const nowIso = () => new Date().toISOString();

export class FeedObservabilityService {
  constructor({ database = null, provider = "BINANCE_SPOT_STREAM", staleAfterMs = 15000, alertService = null, operationalService = null } = {}) {
    this.database = database ?? alertService?.database ?? null; this.alertService = alertService; this.operationalService = operationalService; this.provider = provider; this.staleAfterMs = staleAfterMs;
    if (!this.database && !this.alertService) throw new TypeError("FeedObservabilityService requires a database or alertService.");
    this.sessionId = randomUUID(); this.states = new Map(); this.startedAt = nowIso();
  }
  key(symbol, channel) { return `${this.provider}:${symbol}:${channel}`; }
  update(symbol, channel, update = {}) {
    const key = this.key(symbol, channel); const previous = this.states.get(key) ?? { provider: this.provider, symbol, channel, status: "STARTING", gapCount: 0, reconnectCount: 0 };
    const state = { ...previous, ...update, provider: this.provider, symbol, channel, sessionId: this.sessionId, updatedAt: nowIso() };
    this.states.set(key, state); this.database?.upsertFeedChannelState?.(state);
    if (state.status !== previous.status) this.database?.recordFeedEvent?.({ eventKey: `${key}:${state.status}:${state.updatedAt}`, ...state, eventType: "STATUS_CHANGED", severity: ["GAP", "STALE", "ERROR"].includes(state.status) ? "ERROR" : state.status === "RECOVERING" ? "WARN" : "INFO", occurredAt: state.updatedAt });
    return state;
  }
  message(symbol, channel, { eventAt = Date.now(), sequence = null, sequenceStep = 1, lagMs = null, continuity = null, trackOperational = true } = {}) {
    const timestamp = nowIso(); const previous = this.states.get(this.key(symbol, channel)); const requiresReconciliation = ["GAP", "ERROR"].includes(previous?.status);
    if (trackOperational) this.operationalService?.message(symbol, channel, { eventAt, receivedAt: timestamp, sequence, sequenceStep, duplicate: continuity === "DUPLICATE", outOfOrder: continuity === "OUT_OF_ORDER", gap: continuity === "GAP" });
    if (!requiresReconciliation) {
      this.resolveAlert("STREAM_DISCONNECTED", symbol, channel, { recoveredAt: timestamp });
      this.resolveAlert("STREAM_STALE", symbol, channel, { recoveredAt: timestamp });
    }
    return this.update(symbol, channel, { status: requiresReconciliation ? previous.status : "LIVE", connectedAt: previous?.connectedAt ?? timestamp, lastMessageAt: timestamp, lastEventAt: new Date(eventAt).toISOString(), lastSequence: sequence, lagMs: lagMs ?? Math.max(0, Date.now() - eventAt), lastError: requiresReconciliation ? previous.lastError : null });
  }
  disconnected(symbol, channel, error, reconnect = true) {
    const prior = this.states.get(this.key(symbol, channel));
    const observedAt = nowIso();
    if (reconnect) this.operationalService?.reconnect(symbol, channel, { observedAt, reason: error ?? null });
    const state = this.update(symbol, channel, { status: reconnect ? "RECOVERING" : "STOPPED", reconnectCount: (prior?.reconnectCount ?? 0) + (reconnect ? 1 : 0), lastError: error ?? null });
    if (reconnect) this.openAlert("STREAM_DISCONNECTED", symbol, channel, "WARN", { error });
    return state;
  }
  channelStatus(symbol, channel) { return this.states.get(this.key(symbol, channel))?.status ?? "UNAVAILABLE"; }
  invalid(symbol, channel, evidence = {}) {
    this.operationalService?.invalidate(symbol, channel, { observedAt: nowIso(), invalidationReason: evidence.reason ?? "Malformed stream event", invalidationPayload: evidence });
    const state = this.update(symbol, channel, { status: "ERROR", lastError: evidence.reason ?? "Malformed stream event" });
    this.openAlert("INVALID_STREAM_EVENT", symbol, channel, "ERROR", evidence); return state;
  }
  gap(symbol, channel, evidence) {
    const prior = this.states.get(this.key(symbol, channel));
    if (channel === "DEPTH") this.operationalService?.depth(symbol, channel, false, { observedAt: nowIso(), reason: evidence?.reason ?? "SEQUENCE_GAP" });
    const state = this.update(symbol, channel, { status: "GAP", gapCount: (prior?.gapCount ?? 0) + 1, lastError: "Sequence or candle gap detected" });
    this.openAlert("FEED_GAP", symbol, channel, "ERROR", evidence); return state;
  }
  reconciled(symbol, channel, evidence = {}) {
    this.resolveAlert("FEED_GAP", symbol, channel, evidence); this.resolveAlert("INVALID_STREAM_EVENT", symbol, channel, evidence); this.resolveAlert("STREAM_DISCONNECTED", symbol, channel, evidence);
    const previous = this.states.get(this.key(symbol, channel)); const lastMessageAt = new Date(previous?.lastMessageAt).getTime();
    const streamCurrent = Number.isFinite(lastMessageAt) && Date.now() - lastMessageAt <= this.staleAfterMs;
    return this.update(symbol, channel, { status: streamCurrent ? "LIVE" : "RECOVERING", lastError: streamCurrent ? null : "REST reconciled; waiting for a valid current stream event" });
  }
  alertFingerprint(type, symbol, channel) { return `${type}:${this.provider}:${symbol}:${channel}`; }
  openAlert(type, symbol, channel, severity, payload = {}) {
    const fingerprint = this.alertFingerprint(type, symbol, channel);
    if (this.alertService) return this.alertService.open({ fingerprint, type: "FEED", provider: this.provider, scope: channel, entity: symbol, symbol, channel, state: type, severity, observedAt: nowIso(), payload: { feedCondition: type, ...payload, classification: "PAPER_RESEARCH_OPERATIONAL_ALERT" } });
    return this.database.upsertOperationalAlert({ fingerprint, alertType: "FEED", provider: this.provider, symbol, channel, severity, status: "OPEN", observedAt: nowIso(), payload: { feedCondition: type, ...payload, classification: "PAPER_RESEARCH_OPERATIONAL_ALERT" } });
  }
  resolveAlert(type, symbol, channel, payload = {}) {
    const fingerprint = this.alertFingerprint(type, symbol, channel);
    if (this.alertService) return this.alertService.resolve({ fingerprint, resolvedAt: nowIso(), payload });
    return this.database.resolveOperationalAlert(fingerprint, nowIso(), payload);
  }
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
    const openAlerts = (this.alertService?.list({ status: "OPEN", limit: 50 }) ?? this.database?.operationalAlerts?.({ status: "OPEN", limit: 50 }) ?? []).filter((item) => !symbol || item.symbol === symbol);
    const requiredChannels = ["TRADE", "BOOK_TICKER", "DEPTH", "KLINE_1M", "KLINE_5M"];
    const required = channels.filter((item) => requiredChannels.includes(item.channel));
    const present = new Set(required.map((item) => item.channel));
    const actionReady = requiredChannels.every((channel) => present.has(channel)) && required.every((item) => item.status === "LIVE");
    return { provider: this.provider, sessionId: this.sessionId, startedAt: this.startedAt, actionReady, status: actionReady ? "LIVE" : channels.some((item) => item.status === "LIVE") ? "DEGRADED" : "RECOVERING", channels, openAlerts };
  }
}
