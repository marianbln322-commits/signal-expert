const DEFAULT_WINDOW_SIZE = 256;

function finite(value) { return Number.isFinite(value) ? value : null; }
function time(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}
function distribution(values) {
  return { count: values.length, current: values.at(-1) ?? null, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99) };
}
function eventTotals(events) {
  return events.reduce((totals, event) => {
    for (const key of ["duplicates", "outOfOrder", "gaps", "missingMessages", "reconnects", "failover", "stall", "invalidations"]) totals[key] += event[key] ?? 0;
    return totals;
  }, { samples: events.length, duplicates: 0, outOfOrder: 0, gaps: 0, missingMessages: 0, reconnects: 0, failover: 0, stall: 0, invalidations: 0 });
}
function increment(value, explicit) { return value + (Number.isFinite(explicit) ? Math.max(0, explicit) : explicit ? 1 : 0); }
function watermarkCadenceMs(name) {
  const match = String(name ?? "").trim().toUpperCase().match(/^(\d+)([SMHD])$/);
  if (!match) return 0;
  const units = { S: 1_000, M: 60_000, H: 3_600_000, D: 86_400_000 };
  return Number(match[1]) * units[match[2]];
}
function failoverIdentity(failover) {
  if (!failover || failover.active !== true) return null;
  const clean = (value, fallback) => String(value ?? fallback).trim().toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_") || fallback;
  return `${clean(failover.primarySource ?? failover.primaryName, "PRIMARY")}--${clean(failover.fallbackSource ?? failover.fallbackName, "FALLBACK")}`;
}
function channelState(symbol, channel) {
  return {
    symbol, channel, samples: { latency: [], age: [], divergence: [], clockOffset: [], rtt: [], events: [] },
    lastObservedAt: null, lastEventAt: null, lastSequence: null,
    duplicates: 0, outOfOrder: 0, gaps: 0, missingMessages: 0, reconnects: 0,
    depthSynced: null, depthStatus: "UNAVAILABLE", depthUpdatedAt: null,
    failoverActive: false, failovers: 0, failover: null, failoverGroup: null,
    watermarks: new Map(), stalls: 0, invalidations: 0, lastInvalidation: null,
    alertStates: new Map(),
  };
}

export class OperationalService {
  constructor({ windowSize = DEFAULT_WINDOW_SIZE, stallAfterMs = 120_000, clock = () => new Date(), alertService = null, connections = [], connection = null } = {}) {
    this.windowSize = Number.isInteger(windowSize) && windowSize > 0 ? windowSize : DEFAULT_WINDOW_SIZE;
    this.stallAfterMs = Number.isFinite(stallAfterMs) && stallAfterMs >= 0 ? stallAfterMs : 120_000;
    this.clock = clock;
    this.alertService = alertService;
    this.channels = new Map();
    this.failoverAlertGroups = new Set();
    this.disconnectors = [];
    for (const source of [...(Array.isArray(connections) ? connections : [connections]), connection].filter(Boolean)) this.connect(source);
  }

  nowMs() { return time(this.clock()) ?? Date.now(); }
  key(symbol, channel) { return `${symbol}:${channel}`; }
  state(symbol, channel) {
    const key = this.key(symbol, channel);
    if (!this.channels.has(key)) this.channels.set(key, channelState(symbol, channel));
    return this.channels.get(key);
  }
  push(values, value) {
    if (!Number.isFinite(value)) return;
    values.push(value);
    if (values.length > this.windowSize) values.splice(0, values.length - this.windowSize);
  }
  pushEvent(values, value) {
    values.push(value);
    if (values.length > this.windowSize) values.splice(0, values.length - this.windowSize);
  }

  connect(source) {
    if (!source) return () => {};
    const observer = (observation) => this.observe(observation);
    let disconnect = null;
    if (typeof source === "function") disconnect = source(observer);
    else if (typeof source.subscribe === "function") disconnect = source.subscribe(observer);
    else if (typeof source.on === "function") {
      source.on("operational", observer);
      disconnect = () => source.off?.("operational", observer) ?? source.removeListener?.("operational", observer);
    }
    const normalized = typeof disconnect === "function" ? disconnect : typeof disconnect?.unsubscribe === "function" ? () => disconnect.unsubscribe() : () => {};
    this.disconnectors.push(normalized);
    return normalized;
  }

  disconnect() {
    for (const disconnect of this.disconnectors.splice(0)) {
      try { disconnect(); } catch { /* Optional telemetry connections must not block shutdown. */ }
    }
  }
  close() { this.disconnect(); }

  syncFaultAlert(state, name, active, { type, severity, payload }, observedMs) {
    if (!this.alertService) return;
    const wasActive = state.alertStates.get(name) === true;
    if (active === wasActive) return;
    const fingerprint = `${type}:OPERATIONAL:${state.symbol}:${state.channel}:${name}`;
    if (active) this.alertService.open({ fingerprint, type, provider: "OPERATIONAL", scope: state.channel, entity: state.symbol, symbol: state.symbol, channel: state.channel, state: name, severity, observedAt: new Date(observedMs).toISOString(), payload: { ...payload, classification: "PAPER_RESEARCH_OPERATIONAL_ALERT" } });
    else this.alertService.resolve({ fingerprint, resolvedAt: new Date(observedMs).toISOString(), payload: { recovered: true, classification: "PAPER_RESEARCH_OPERATIONAL_ALERT" } });
    state.alertStates.set(name, active);
  }

  syncFailoverAlerts(symbol, observedMs) {
    if (!this.alertService) return;
    const active = [...this.channels.values()].filter((item) => item.symbol === symbol && item.failoverActive && item.failoverGroup);
    const grouped = new Map();
    for (const item of active) {
      if (!grouped.has(item.failoverGroup)) grouped.set(item.failoverGroup, []);
      grouped.get(item.failoverGroup).push(item);
    }
    const activeFingerprints = new Set();
    for (const [group, states] of grouped) {
      const fingerprint = `FAILOVER:OPERATIONAL:${symbol}:${group}`;
      activeFingerprints.add(fingerprint);
      const payload = {
        classification: "PAPER_RESEARCH_OPERATIONAL_ALERT",
        providerPair: group,
        affectedChannels: states.map((item) => item.channel).sort(),
        channelEvidence: Object.fromEntries(states.map((item) => [item.channel, item.failover])),
      };
      if (!this.failoverAlertGroups.has(fingerprint)) {
        this.alertService.open({ fingerprint, type: "FAILOVER", provider: "OPERATIONAL", scope: "PROVIDER", entity: symbol, symbol, channel: "MULTI_CHANNEL", state: "FAILOVER_ACTIVE", severity: "WARN", observedAt: new Date(observedMs).toISOString(), payload });
        this.failoverAlertGroups.add(fingerprint);
      } else this.alertService.refresh?.(fingerprint, { scope: "PROVIDER", entity: symbol, state: "FAILOVER_ACTIVE", ...payload }, new Date(observedMs).toISOString());
    }
    for (const fingerprint of [...this.failoverAlertGroups]) {
      if (!fingerprint.startsWith(`FAILOVER:OPERATIONAL:${symbol}:`) || activeFingerprints.has(fingerprint)) continue;
      this.alertService.resolve({ fingerprint, resolvedAt: new Date(observedMs).toISOString(), payload: { recovered: true, classification: "PAPER_RESEARCH_OPERATIONAL_ALERT" } });
      this.failoverAlertGroups.delete(fingerprint);
    }
  }

  syncAlerts(state, status, watermarks, window, observedMs) {
    this.syncFailoverAlerts(state.symbol, observedMs);
    this.syncFaultAlert(state, "WATERMARK_STALL", Object.values(watermarks).some((item) => item.stalled), { type: "WATERMARK_STALL", severity: "WARN", payload: { watermarks } }, observedMs);
    this.syncFaultAlert(state, "DEPTH_OUT_OF_SYNC", state.depthSynced === false, { type: "DEPTH_SYNC", severity: "ERROR", payload: { depthStatus: state.depthStatus } }, observedMs);
  }

  normalize(symbolOrObservation, channel, observation) {
    if (symbolOrObservation && typeof symbolOrObservation === "object") return symbolOrObservation;
    return { ...(observation ?? {}), symbol: symbolOrObservation, channel };
  }

  observe(symbolOrObservation, channel = null, observation = {}) {
    const input = this.normalize(symbolOrObservation, channel, observation);
    const symbol = String(input.symbol ?? "SYSTEM").toUpperCase();
    const channelName = String(input.channel ?? "SYSTEM").toUpperCase();
    const state = this.state(symbol, channelName);
    const observedMs = time(input.observedAt ?? input.receivedAt) ?? this.nowMs();
    const eventMs = time(input.eventAt ?? input.sourceTimestamp);
    const latencyMs = finite(input.latencyMs) ?? (eventMs === null ? null : Math.max(0, observedMs - eventMs));
    const ageMs = finite(input.ageMs) ?? (eventMs === null ? null : Math.max(0, this.nowMs() - eventMs));
    const primaryPrice = finite(input.primaryPrice ?? input.referencePrice);
    const comparisonPrice = finite(input.secondaryPrice ?? input.comparisonPrice);
    const divergenceBps = finite(input.divergenceBps) ?? (primaryPrice !== null && primaryPrice !== 0 && comparisonPrice !== null ? Math.abs(primaryPrice - comparisonPrice) / Math.abs(primaryPrice) * 10_000 : null);
    this.push(state.samples.latency, latencyMs);
    this.push(state.samples.age, ageMs);
    this.push(state.samples.divergence, divergenceBps);
    this.push(state.samples.clockOffset, finite(input.clockOffsetMs));
    this.push(state.samples.rtt, finite(input.rttMs));

    const sequence = finite(input.sequence);
    const sequenceStep = finite(input.sequenceStep) ?? 1;
    const detectSequence = input.detectSequence !== false;
    const sequenceDuplicate = detectSequence && sequence !== null && state.lastSequence !== null && sequence === state.lastSequence;
    const sequenceOutOfOrder = detectSequence && sequence !== null && state.lastSequence !== null && sequence < state.lastSequence;
    const sequenceGap = detectSequence && sequence !== null && state.lastSequence !== null && sequence > state.lastSequence + sequenceStep;
    const duplicateIncrement = sequenceDuplicate ? 1 : Number.isFinite(input.duplicates) ? input.duplicates : input.duplicate ? 1 : 0;
    const outOfOrderIncrement = sequenceOutOfOrder ? 1 : Number.isFinite(input.outOfOrder) ? input.outOfOrder : input.outOfOrder ? 1 : 0;
    const gapIncrement = sequenceGap ? 1 : Number.isFinite(input.gaps) ? input.gaps : input.gap ? 1 : 0;
    const missingIncrement = sequenceGap ? Math.max(0, Math.ceil((sequence - state.lastSequence) / sequenceStep) - 1) : Number.isFinite(input.missingMessages) ? input.missingMessages : 0;
    const reconnectIncrement = Number.isFinite(input.reconnects) ? input.reconnects : input.reconnect ? 1 : 0;
    state.duplicates = increment(state.duplicates, duplicateIncrement);
    state.outOfOrder = increment(state.outOfOrder, outOfOrderIncrement);
    state.gaps = increment(state.gaps, gapIncrement);
    state.missingMessages = increment(state.missingMessages, missingIncrement);
    state.reconnects = increment(state.reconnects, reconnectIncrement);
    if (sequence !== null && (state.lastSequence === null || sequence > state.lastSequence)) state.lastSequence = sequence;

    if (input.depthSynced !== undefined || input.depthSync !== undefined) {
      const synced = input.depthSynced ?? input.depthSync;
      state.depthSynced = synced === true;
      state.depthStatus = synced === true ? "SYNCED" : "OUT_OF_SYNC";
      state.depthUpdatedAt = new Date(observedMs).toISOString();
    }
    let failoverTransition = 0;
    if (input.failover !== undefined || input.failoverActive !== undefined) {
      const failover = typeof input.failover === "object" ? input.failover : null;
      const active = input.failoverActive ?? failover?.active ?? input.failover === true;
      if (active === true && state.failoverActive !== true) { state.failovers += 1; failoverTransition = 1; }
      state.failoverActive = active === true;
      state.failover = failover ?? { active: state.failoverActive };
      state.failoverGroup = state.failoverActive ? failoverIdentity(state.failover) : null;
    }
    let stallTransition = 0;
    if (input.watermark !== undefined) {
      const watermark = this.recordWatermark(state, input.watermarkName ?? input.timeframe ?? channelName, input.watermark, observedMs, input.stalled);
      stallTransition = watermark.enteredStall ? 1 : 0;
    }
    if (input.invalidation || input.invalidated) {
      state.invalidations = increment(state.invalidations, Number.isFinite(input.invalidations) ? input.invalidations : true);
      state.lastInvalidation = { reason: input.invalidationReason ?? input.reason ?? null, observedAt: new Date(observedMs).toISOString(), payload: input.invalidationPayload ?? null };
    } else if (Number.isFinite(input.invalidations)) state.invalidations = increment(state.invalidations, input.invalidations);
    this.pushEvent(state.samples.events, {
      observedAt: observedMs,
      duplicates: Math.max(0, duplicateIncrement), outOfOrder: Math.max(0, outOfOrderIncrement), gaps: Math.max(0, gapIncrement),
      missingMessages: Math.max(0, missingIncrement), reconnects: Math.max(0, reconnectIncrement),
      failover: failoverTransition,
      stall: stallTransition,
      invalidations: input.invalidation || input.invalidated ? Math.max(1, finite(input.invalidations) ?? 1) : Math.max(0, finite(input.invalidations) ?? 0),
    });
    state.lastObservedAt = new Date(observedMs).toISOString();
    if (eventMs !== null) state.lastEventAt = new Date(eventMs).toISOString();
    return this.channelStatus(symbol, channelName, observedMs);
  }

  recordWatermark(stateOrSymbol, nameOrChannel, valueOrName, observedOrValue, stalledOrObserved = false, explicitStalled = false) {
    let state; let name; let value; let observedMs; let stalled;
    if (typeof stateOrSymbol === "object") {
      state = stateOrSymbol; name = nameOrChannel; value = valueOrName; observedMs = observedOrValue; stalled = stalledOrObserved;
    } else {
      state = this.state(String(stateOrSymbol).toUpperCase(), String(nameOrChannel).toUpperCase());
      name = valueOrName; value = observedOrValue; observedMs = time(stalledOrObserved) ?? this.nowMs(); stalled = explicitStalled;
    }
    const key = String(name ?? state.channel).toUpperCase();
    const previous = state.watermarks.get(key);
    const valueMs = time(value);
    const advanced = !previous || (valueMs !== null && (previous.valueMs === null || valueMs > previous.valueMs)) || (valueMs === null && value !== previous.value);
    const thresholdMs = this.stallAfterMs + watermarkCadenceMs(key);
    let stalledNow = stalled === true;
    if (!advanced && previous && observedMs - previous.advancedAtMs >= thresholdMs) stalledNow = true;
    const enteredStall = stalledNow && previous?.stalled !== true;
    if (enteredStall) state.stalls += 1;
    state.watermarks.set(key, {
      value, valueMs, observedAt: new Date(observedMs).toISOString(), thresholdMs,
      advancedAtMs: advanced ? observedMs : previous?.advancedAtMs ?? observedMs,
      advancedAt: new Date(advanced ? observedMs : previous?.advancedAtMs ?? observedMs).toISOString(),
      stalled: stalledNow,
      enteredStall,
    });
    return state.watermarks.get(key);
  }

  record(input) { return this.observe(input); }
  latency(symbol, channel, latencyMs, observedAt = null) { return this.observe({ symbol, channel, latencyMs, observedAt }); }
  message(symbol, channel, input = {}) { return this.observe({ ...input, symbol, channel }); }
  reconnect(symbol, channel, input = {}) { return this.observe({ ...input, symbol, channel, reconnect: true }); }
  depth(symbol, channel, synced, input = {}) { return this.observe({ ...input, symbol, channel, depthSynced: synced }); }
  divergence(symbol, channel, divergenceBps, input = {}) { return this.observe({ ...input, symbol, channel, divergenceBps }); }
  failover(symbol, channel, failover, input = {}) { return this.observe({ ...input, symbol, channel, failover }); }
  watermark(symbol, channel, name, value, input = {}) { return this.observe({ ...input, symbol, channel, watermarkName: name, watermark: value }); }
  invalidate(symbol, channel, input = {}) { return this.observe({ ...input, symbol, channel, invalidation: true }); }
  clockSample(symbol, channel, input = {}) {
    let { clockOffsetMs, rttMs } = input;
    const sent = time(input.requestSentAt); const received = time(input.responseReceivedAt); const server = time(input.serverTime);
    if (!Number.isFinite(rttMs) && sent !== null && received !== null) rttMs = Math.max(0, received - sent);
    if (!Number.isFinite(clockOffsetMs) && sent !== null && received !== null && server !== null) clockOffsetMs = server - (sent + received) / 2;
    return this.observe({ ...input, symbol, channel, clockOffsetMs, rttMs, observedAt: input.observedAt ?? input.responseReceivedAt });
  }

  channelStatus(symbol, channel, now = this.nowMs()) {
    const state = this.channels.get(this.key(symbol, channel));
    if (!state) return null;
    const watermarks = {};
    for (const [name, watermark] of state.watermarks) {
      const thresholdMs = watermark.thresholdMs ?? this.stallAfterMs + watermarkCadenceMs(name);
      const stalled = watermark.stalled || now - watermark.advancedAtMs >= thresholdMs;
      if (stalled && watermark.stalled !== true) {
        watermark.stalled = true;
        state.stalls += 1;
        this.pushEvent(state.samples.events, { observedAt: now, duplicates: 0, outOfOrder: 0, gaps: 0, missingMessages: 0, reconnects: 0, failover: 0, stall: 1, invalidations: 0 });
      }
      watermarks[name] = { value: watermark.value, observedAt: watermark.observedAt, advancedAt: watermark.advancedAt, stalled, ageMs: Math.max(0, now - watermark.advancedAtMs), thresholdMs };
    }
    const stalled = Object.values(watermarks).some((item) => item.stalled);
    const window = eventTotals(state.samples.events);
    const status = window.invalidations > 0 || state.depthSynced === false ? "ERROR"
      : stalled || state.failoverActive || window.gaps > 0 || window.outOfOrder > 0 ? "DEGRADED"
        : state.lastObservedAt ? "LIVE" : "UNAVAILABLE";
    this.syncAlerts(state, status, watermarks, window, now);
    return {
      symbol: state.symbol, channel: state.channel, status, lastObservedAt: state.lastObservedAt, lastEventAt: state.lastEventAt,
      latencyMs: distribution(state.samples.latency), ageMs: distribution(state.samples.age), window,
      duplicates: state.duplicates, outOfOrder: state.outOfOrder, gaps: state.gaps, missingMessages: state.missingMessages, reconnects: state.reconnects,
      depth: { status: state.depthStatus, synced: state.depthSynced, updatedAt: state.depthUpdatedAt },
      divergenceBps: distribution(state.samples.divergence),
      clock: { offsetMs: distribution(state.samples.clockOffset), rttMs: distribution(state.samples.rtt) },
      failover: { active: state.failoverActive, count: state.failovers, details: state.failover },
      watermarks, stalls: state.stalls,
      invalidations: state.invalidations, lastInvalidation: state.lastInvalidation,
    };
  }

  status(symbol = null) {
    const normalized = symbol === null ? null : String(symbol).toUpperCase();
    const now = this.nowMs();
    const channels = [...this.channels.values()]
      .filter((state) => normalized === null || state.symbol === normalized)
      .map((state) => this.channelStatus(state.symbol, state.channel, now))
      .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.channel.localeCompare(right.channel));
    const totals = channels.reduce((result, channel) => {
      result.duplicates += channel.duplicates; result.outOfOrder += channel.outOfOrder; result.gaps += channel.gaps;
      result.missingMessages += channel.missingMessages; result.reconnects += channel.reconnects; result.failovers += channel.failover.count;
      result.stalls += channel.stalls; result.invalidations += channel.invalidations;
      return result;
    }, { duplicates: 0, outOfOrder: 0, gaps: 0, missingMessages: 0, reconnects: 0, failovers: 0, stalls: 0, invalidations: 0 });
    const allLatency = channels.flatMap((channel) => {
      const state = this.channels.get(this.key(channel.symbol, channel.channel)); return state?.samples.latency ?? [];
    });
    const allAge = channels.flatMap((channel) => {
      const state = this.channels.get(this.key(channel.symbol, channel.channel)); return state?.samples.age ?? [];
    });
    const overall = !channels.length ? "UNAVAILABLE" : channels.some((channel) => channel.status === "ERROR") ? "ERROR" : channels.some((channel) => channel.status === "DEGRADED") ? "DEGRADED" : "LIVE";
    return {
      symbol: normalized, status: overall, observedAt: new Date(now).toISOString(), windowSize: this.windowSize,
      latencyMs: distribution(allLatency), ageMs: distribution(allAge), totals, channels,
      byChannel: Object.fromEntries(channels.map((channel) => [channel.channel, channel])),
    };
  }
}
