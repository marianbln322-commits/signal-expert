export const ALERT_TYPES = Object.freeze({
  DIRECTION: "DIRECTION",
  REGIME: "REGIME",
  CORRECTION: "CORRECTION",
  LEVEL: "LEVEL",
  READY: "READY",
  FEED: "FEED",
  FAILOVER: "FAILOVER",
  CALIBRATION: "CALIBRATION",
});

function part(value, fallback) {
  const normalized = String(value ?? fallback).trim().toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_");
  return normalized || fallback;
}
function milliseconds(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
function asIso(value) { return new Date(milliseconds(value) ?? Date.now()).toISOString(); }
function parsePayload(row) {
  if (!row || !Object.hasOwn(row, "payloadJson")) return row;
  const { payloadJson, ...rest } = row;
  try { return { ...rest, payload: JSON.parse(payloadJson) }; }
  catch { return { ...rest, payload: {} }; }
}
function severityFor(type, state) {
  const normalized = part(state, "UNKNOWN");
  if (type === ALERT_TYPES.FEED && ["ERROR", "GAP", "STALE"].includes(normalized)) return "ERROR";
  if (type === ALERT_TYPES.FEED && ["RECOVERING", "DISCONNECTED"].includes(normalized)) return "WARN";
  if (type === ALERT_TYPES.FAILOVER && ["ACTIVE", "TRUE", "FAILOVER"].includes(normalized)) return "WARN";
  if (type === ALERT_TYPES.CALIBRATION && ["UNDERPERFORMING", "DRIFT", "ERROR"].includes(normalized)) return "WARN";
  return "INFO";
}

export class AlertService {
  constructor({ database = null, db = null, cooldownMs = 60_000, hysteresisMs = 0, clock = () => new Date() }) {
    this.database = database ?? db;
    if (!this.database) throw new TypeError("AlertService requires a database.");
    this.cooldownMs = Math.max(0, Number.isFinite(cooldownMs) ? cooldownMs : 60_000);
    this.hysteresisMs = Math.max(0, Number.isFinite(hysteresisMs) ? hysteresisMs : 0);
    this.clock = clock;
    this.lastEmission = new Map();
    this.transitions = new Map();
  }

  fingerprint({ type, alertType, scope, entity, state }) {
    return [part(type ?? alertType, "OPERATIONAL"), part(scope, "SYSTEM"), part(entity, "SYSTEM"), part(state, "OPEN")].join(":");
  }

  open(input = {}) {
    const observedAt = input.observedAt ?? asIso(this.clock());
    const observedMs = milliseconds(observedAt) ?? Date.now();
    const type = part(input.type ?? input.alertType, "OPERATIONAL");
    const scope = part(input.scope ?? input.provider, "SYSTEM");
    const entity = part(input.entity ?? input.symbol, "SYSTEM");
    const state = part(input.state, "OPEN");
    const fingerprint = input.fingerprint ?? this.fingerprint({ type, scope, entity, state });
    const cooldownMs = Math.max(0, Number.isFinite(input.cooldownMs) ? input.cooldownMs : this.cooldownMs);
    const lastEmission = this.lastEmission.get(fingerprint);
    const coolingDown = Number.isFinite(lastEmission) && observedMs - lastEmission < cooldownMs;
    const alreadyOpen = this.database.operationalAlerts({ status: "OPEN", limit: 500 }).find((alert) => alert.fingerprint === fingerprint);
    if (alreadyOpen) {
      if (!Number.isFinite(lastEmission)) this.lastEmission.set(fingerprint, milliseconds(alreadyOpen.lastSeenAt) ?? observedMs);
      const effectiveLastEmission = this.lastEmission.get(fingerprint);
      const notificationSuppressed = Number.isFinite(effectiveLastEmission) && observedMs - effectiveLastEmission < cooldownMs;
      const row = this.database.upsertOperationalAlert({
        fingerprint,
        alertType: type,
        provider: part(input.provider ?? scope, "SYSTEM"),
        symbol: part(input.symbol ?? entity, "SYSTEM"),
        channel: part(input.channel ?? scope, "SYSTEM"),
        severity: part(input.severity, severityFor(type, state)),
        status: "OPEN",
        observedAt: new Date(observedMs).toISOString(),
        payload: { scope, entity, state, ...(input.payload ?? {}) },
      });
      if (!notificationSuppressed) this.lastEmission.set(fingerprint, observedMs);
      const persisted = parsePayload(row);
      return notificationSuppressed
        ? { ...persisted, lifecycleStatus: "OPEN", suppressed: true, notificationSuppressed: true, duplicate: true, retryAt: new Date(effectiveLastEmission + cooldownMs).toISOString() }
        : { ...persisted, lifecycleStatus: "OPEN", suppressed: false, notificationSuppressed: false, duplicate: true };
    }
    const row = this.database.upsertOperationalAlert({
      fingerprint,
      alertType: type,
      provider: part(input.provider ?? scope, "SYSTEM"),
      symbol: part(input.symbol ?? entity, "SYSTEM"),
      channel: part(input.channel ?? scope, "SYSTEM"),
      severity: part(input.severity, severityFor(type, state)),
      status: "OPEN",
      observedAt: new Date(observedMs).toISOString(),
      payload: { scope, entity, state, ...(input.payload ?? {}) },
    });
    if (!coolingDown) this.lastEmission.set(fingerprint, observedMs);
    const persisted = parsePayload(row);
    return coolingDown ? { ...persisted, suppressed: true, notificationSuppressed: true, retryAt: new Date(lastEmission + cooldownMs).toISOString() } : persisted;
  }

  refresh(fingerprint, payload = {}, observedAt = asIso(this.clock())) {
    return this.database.refreshOperationalAlert?.(fingerprint, asIso(observedAt), payload) ?? false;
  }

  resolve(input, payload = {}) {
    if (typeof input === "string") {
      const resolvedAt = asIso(this.clock());
      return this.database.resolveOperationalAlert(input, resolvedAt, payload);
    }
    const descriptor = input ?? {};
    const type = part(descriptor.type ?? descriptor.alertType, "OPERATIONAL");
    const scope = part(descriptor.scope ?? descriptor.provider, "SYSTEM");
    const entity = part(descriptor.entity ?? descriptor.symbol, "SYSTEM");
    const state = part(descriptor.state, "OPEN");
    const fingerprint = descriptor.fingerprint ?? this.fingerprint({ type, scope, entity, state });
    const resolvedAt = descriptor.resolvedAt ?? asIso(this.clock());
    return this.database.resolveOperationalAlert(fingerprint, asIso(resolvedAt), descriptor.payload ?? payload);
  }

  persistedOpen(type, scope, entity) {
    const prefix = [type, scope, entity].join(":") + ":";
    const matching = this.database.operationalAlerts({ limit: 500 }).filter((alert) => alert.fingerprint?.startsWith(prefix));
    for (const alert of matching) {
      const lastSeen = milliseconds(alert.lastSeenAt);
      const prior = this.lastEmission.get(alert.fingerprint);
      if (lastSeen !== null && (!Number.isFinite(prior) || lastSeen > prior)) this.lastEmission.set(alert.fingerprint, lastSeen);
    }
    return matching.filter((alert) => alert.status === "OPEN").map((alert) => ({ ...alert, state: alert.fingerprint.slice(prefix.length) }));
  }

  transition(input = {}) {
    const type = part(input.type ?? input.alertType, "OPERATIONAL");
    const scope = part(input.scope ?? input.provider, "SYSTEM");
    const entity = part(input.entity ?? input.symbol, "SYSTEM");
    const state = part(input.state ?? input.to, "UNKNOWN");
    const observedAt = input.observedAt ?? asIso(this.clock());
    const observedMs = milliseconds(observedAt) ?? Date.now();
    const key = [type, scope, entity].join(":");
    let tracker = this.transitions.get(key);
    if (!tracker) {
      const persisted = this.persistedOpen(type, scope, entity);
      const persistedCurrent = persisted.find((alert) => alert.state === state);
      const explicitInitial = input.previousState ?? input.from;
      if (explicitInitial === undefined && persistedCurrent) {
        for (const alert of persisted) if (alert.fingerprint !== persistedCurrent.fingerprint) this.resolve(alert.fingerprint, { reconciledTo: state, resolvedAt: new Date(observedMs).toISOString() });
        tracker = { stable: state, pending: null, pendingSince: null };
        this.transitions.set(key, tracker);
        const alert = this.open({ ...input, type, scope, entity, state, observedAt: new Date(observedMs).toISOString() });
        return { transitioned: false, initialized: true, reconciled: persisted.length > 1, type, scope, entity, state, alert };
      }
      const initial = persisted[0]?.state ?? explicitInitial;
      tracker = { stable: initial === undefined ? state : part(initial, "UNKNOWN"), pending: null, pendingSince: null };
      this.transitions.set(key, tracker);
      for (const alert of persisted.slice(1)) this.resolve(alert.fingerprint, { reconciledFrom: alert.state, reconciledTo: state, resolvedAt: new Date(observedMs).toISOString() });
      if (initial === undefined || tracker.stable === state) return { transitioned: false, initialized: true, type, scope, entity, state };
    }
    if (state === tracker.stable) {
      tracker.pending = null; tracker.pendingSince = null;
      const alert = this.open({ ...input, type, scope, entity, state, observedAt: new Date(observedMs).toISOString() });
      return { transitioned: false, type, scope, entity, state, alert };
    }
    if (tracker.pending !== state) { tracker.pending = state; tracker.pendingSince = observedMs; }
    const hysteresisMs = Math.max(0, Number.isFinite(input.hysteresisMs) ? input.hysteresisMs : this.hysteresisMs);
    if (observedMs - tracker.pendingSince < hysteresisMs) {
      return { transitioned: false, pending: true, type, scope, entity, from: tracker.stable, to: state, stableAt: new Date(tracker.pendingSince + hysteresisMs).toISOString() };
    }

    const from = tracker.stable;
    this.resolve({ type, scope, entity, state: from, resolvedAt: new Date(observedMs).toISOString(), payload: { from, to: state, transitionResolvedAt: new Date(observedMs).toISOString() } });
    tracker.stable = state; tracker.pending = null; tracker.pendingSince = null;
    const alert = this.open({
      ...input, type, scope, entity, state, observedAt: new Date(observedMs).toISOString(),
      severity: input.severity ?? severityFor(type, state),
      payload: { from, to: state, transitionedAt: new Date(observedMs).toISOString(), ...(input.payload ?? {}) },
    });
    return { transitioned: true, type, scope, entity, from, to: state, alert };
  }

  emit(input = {}) {
    const kind = part(input.kind ?? input.type ?? input.alertType, "OPERATIONAL");
    if (Object.hasOwn(ALERT_TYPES, kind)) return this.transition({ ...input, type: ALERT_TYPES[kind] });
    return this.transition({ ...input, type: kind });
  }

  direction(input) { return this.transition({ ...input, type: ALERT_TYPES.DIRECTION }); }
  regime(input) { return this.transition({ ...input, type: ALERT_TYPES.REGIME }); }
  correction(input) { return this.transition({ ...input, type: ALERT_TYPES.CORRECTION }); }
  level(input) { return this.transition({ ...input, type: ALERT_TYPES.LEVEL }); }
  ready(input) { return this.transition({ ...input, type: ALERT_TYPES.READY }); }
  feed(input) { return this.transition({ ...input, type: ALERT_TYPES.FEED }); }
  failover(input) { return this.transition({ ...input, type: ALERT_TYPES.FAILOVER }); }
  calibration(input) { return this.transition({ ...input, type: ALERT_TYPES.CALIBRATION }); }
  emitDirection(input) { return this.direction(input); }
  emitRegime(input) { return this.regime(input); }
  emitCorrection(input) { return this.correction(input); }
  emitLevel(input) { return this.level(input); }
  emitReady(input) { return this.ready(input); }
  emitFeed(input) { return this.feed(input); }
  emitFailover(input) { return this.failover(input); }
  emitCalibration(input) { return this.calibration(input); }

  list(options = {}) { return this.database.operationalAlerts(options); }
  alerts(options = {}) { return this.list(options); }
}
