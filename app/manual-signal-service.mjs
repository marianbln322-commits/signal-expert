import { createHash } from "node:crypto";
import { AUTONOMOUS_STRATEGY_VERSION } from "./quant.mjs";

const MARKET_CLASSIFICATION = "SPOT_PROXY";
const SETTLEMENT_CLASSIFICATION = "NOT_EVENT_FUTURES_SETTLEMENT";
const CONFIDENCE_CLASSIFICATION = "SPOT_PROXY_PROSPECTIVE_OUTCOMES_NOT_EVENT_FUTURES_CALIBRATION";

function deterministicId(candidateKey) {
  return `manual_${createHash("sha256").update(candidateKey).digest("hex")}`;
}
function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}
function tickerProvenance(market, observedAt) {
  return {
    classification: MARKET_CLASSIFICATION,
    source: market.source ?? null,
    sourceName: market.sourceName ?? null,
    sourceUrl: market.sourceUrl ?? null,
    sourceTimestamp: market.sourceTimestamp ?? null,
    receivedAt: market.receivedAt ?? null,
    failover: market.failover ?? null,
    observedAt,
  };
}
function candidateDetails(candidate, entryGate = null) {
  return {
    volatilityRegime: candidate.volatilityRegime ?? null,
    confluenceComponents: candidate.confluenceComponents ?? [],
    structureFeatures: candidate.structureFeatures ?? {},
    technicalFeatures: candidate.technicalFeatures ?? {},
    qualityDefinition: candidate.qualityDefinition ?? null,
    entryGate,
  };
}

export class ManualSignalService {
  constructor({ market, database, settings }) {
    this.market = market; this.database = database; this.settings = settings;
    this.timer = null; this.resolutionTimer = null; this.busy = false; this.nextScanAt = null; this.lastScanAt = null; this.lastError = null;
  }
  start() {
    if (!this.settings.enabled) return;
    this.scan();
    this.nextScanAt = new Date(Date.now() + this.settings.scanMs).toISOString();
    this.timer = setInterval(() => {
      try { this.scan(); }
      catch (error) { this.recordError(error); }
    }, this.settings.scanMs);
    const resolutionCheckMs = Math.min(this.settings.scanMs, Math.max(250, Math.floor(this.settings.maxResolutionLagMs / 2)));
    this.resolutionTimer = setInterval(() => {
      try { this.reconcileReady(new Date()); }
      catch (error) { this.recordError(error); }
    }, resolutionCheckMs);
  }
  recordError(error) {
    this.lastError = error instanceof Error ? error.message : "Unknown manual signal scan error";
    console.error(JSON.stringify({ level: "error", event: "manual_signal_scan_failed", message: this.lastError }));
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.resolutionTimer) clearInterval(this.resolutionTimer);
    this.timer = null; this.resolutionTimer = null; this.nextScanAt = null;
  }
  currentEntryGate(signal, now = new Date()) {
    const snapshot = this.market.snapshot(signal.symbol);
    const candidate = snapshot?.analysis?.candidates?.find((item) => item.decisionKey === signal.candidateKey && item.horizonMinutes === signal.horizonMinutes && item.direction === signal.direction);
    if (candidate) return this.market.evaluateEntry(candidate, now);
    return {
      allowed: false,
      classification: "CURRENT_ENTRY_RECHECK_UNAVAILABLE",
      policyVersion: "entry-gates-v0.5.0",
      evaluatedAt: now.toISOString(),
      checks: [{ code: "CURRENT_ENTRY_RECHECK", status: "BLOCKED", reason: "The original candidate is no longer present in the current completed-candle analysis.", evidence: { candidateKey: signal.candidateKey } }],
    };
  }
  present(signal, now = new Date()) {
    if (!signal) return null;
    const deadline = timestamp(signal.entryValidUntil) ?? 0;
    const insideEntryWindow = signal.status === "READY" && this.settings.enabled && now.getTime() < deadline;
    const currentEntryGate = insideEntryWindow ? this.currentEntryGate(signal, now) : null;
    const actionState = signal.status !== "READY"
      ? signal.status
      : !this.settings.enabled ? "DISABLED"
        : now.getTime() >= deadline ? "TRACKING_DO_NOT_ENTER_LATE"
          : currentEntryGate?.allowed ? "ENTER_NOW" : "BLOCKED_CURRENT_GATES";
    return { ...signal, actionState, currentEntryGate };
  }
  ready(symbol = null) { return this.database.currentManualResearchSignals(symbol).map((signal) => this.present(signal)); }
  recent(limit = 50, symbol = null) { return this.database.recentManualResearchSignals(limit, symbol).map((signal) => this.present(signal)); }
  byId(id) { return this.present(this.database.manualResearchSignalById(id)); }
  confidence(symbol = null) {
    const observed = this.database.manualSignalEmpiricalConfidence({ minDecisiveSample: this.settings.minDecisiveSample, payoutRate: this.settings.payoutRate, symbol });
    const bySegment = new Map(observed.filter((item) => item.strategyVersion === AUTONOMOUS_STRATEGY_VERSION).map((item) => [`${item.symbol}:${item.horizonMinutes}`, item]));
    const breakEvenRate = 1 / (1 + this.settings.payoutRate);
    const symbols = symbol ? [symbol] : this.settings.symbols;
    return symbols.flatMap((itemSymbol) => this.settings.horizons.map((horizonMinutes) => bySegment.get(`${itemSymbol}:${horizonMinutes}`) ?? {
      classification: CONFIDENCE_CLASSIFICATION,
      strategyVersion: AUTONOMOUS_STRATEGY_VERSION,
      symbol: itemSymbol,
      horizonMinutes,
      resolved: 0,
      decisiveSample: 0,
      correct: 0,
      incorrect: 0,
      ties: 0,
      unavailable: 0,
      minDecisiveSample: this.settings.minDecisiveSample,
      status: "WARMUP",
      measuredRate: null,
      wilson95: { lower: null, upper: null },
      breakEvenReference: { rate: breakEvenRate, payoutRate: this.settings.payoutRate, source: "USER_CONFIGURED_PAPER_PAYOUT" },
    }));
  }
  latestSegments(symbol = null) {
    const ready = this.ready(symbol);
    const latest = this.recent(200, symbol);
    const selected = new Map();
    for (const signal of [...ready, ...latest]) {
      const key = `${signal.symbol}:${signal.horizonMinutes}`;
      if (!selected.has(key)) selected.set(key, signal);
    }
    return [...selected.values()].sort((left, right) => left.symbol.localeCompare(right.symbol) || left.horizonMinutes - right.horizonMinutes);
  }
  status(symbol = null) {
    return {
      mode: "MANUAL_SIGNALS_ONLY",
      enabled: this.settings.enabled,
      liveExecutionAvailable: false,
      eventFuturesFeed: { status: "UNAVAILABLE", reason: "No verified official Event Futures feed is connected; signals use the explicitly identified underlying Spot proxy." },
      marketClassification: MARKET_CLASSIFICATION,
      settlementClassification: SETTLEMENT_CLASSIFICATION,
      confidenceClassification: CONFIDENCE_CLASSIFICATION,
      schedulerBusy: this.busy,
      nextScanAt: this.nextScanAt,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      current: this.latestSegments(symbol),
      ready: this.ready(symbol),
      recent: this.recent(50, symbol),
      empiricalConfidence: this.confidence(symbol),
      policy: {
        scanMs: this.settings.scanMs,
        entryWindowMs: this.settings.entryWindowMs,
        maxResolutionLagMs: this.settings.maxResolutionLagMs,
        minDecisiveSample: this.settings.minDecisiveSample,
        confidenceGateEnabled: this.settings.confidenceGateEnabled,
        breakEvenReference: { rate: 1 / (1 + this.settings.payoutRate), payoutRate: this.settings.payoutRate, source: "USER_CONFIGURED_PAPER_PAYOUT" },
        outcomeClassification: CONFIDENCE_CLASSIFICATION,
      },
    };
  }
  scan() {
    if (this.busy || !this.settings.enabled) return;
    this.busy = true;
    const now = new Date();
    this.lastScanAt = now.toISOString();
    this.nextScanAt = new Date(now.getTime() + this.settings.scanMs).toISOString();
    try {
      this.reconcileReady(now);
      this.captureCandidates(now);
      this.lastError = null;
    } finally { this.busy = false; }
  }
  reconcileReady(now = new Date()) {
    for (const signal of this.database.currentManualResearchSignals()) {
      const resolvesAt = timestamp(signal.resolvesAt);
      if (resolvesAt === null || now.getTime() < resolvesAt) continue;
      const latestAllowedAt = resolvesAt + this.settings.maxResolutionLagMs;
      const snapshot = this.market.snapshot(signal.symbol);
      const market = snapshot?.market ?? {};
      const sourceTimestamp = timestamp(market.sourceTimestamp);
      const price = market.data?.lastPrice;
      const timelyTicker = market.status === "LIVE" && Number.isFinite(price) && price > 0 && sourceTimestamp !== null && sourceTimestamp >= resolvesAt && sourceTimestamp <= latestAllowedAt;
      if (timelyTicker) {
        const proxyOutcome = price === signal.entryPrice
          ? "PROXY_TIE"
          : signal.direction === "UP" ? (price > signal.entryPrice ? "PROXY_CORRECT" : "PROXY_INCORRECT") : (price < signal.entryPrice ? "PROXY_CORRECT" : "PROXY_INCORRECT");
        this.database.resolveManualResearchSignal(signal.id, {
          proxyOutcome,
          resolutionPrice: price,
          resolutionSource: {
            ...tickerProvenance(market, now.toISOString()),
            settlementClassification: SETTLEMENT_CLASSIFICATION,
            targetResolutionAt: signal.resolvesAt,
            latestAllowedSourceTimestamp: new Date(latestAllowedAt).toISOString(),
          },
          resolvedAt: now.toISOString(),
          expiredAt: now.toISOString(),
        });
      } else if (now.getTime() > latestAllowedAt) {
        this.database.resolveManualResearchSignal(signal.id, {
          proxyOutcome: "NO_TIMELY_OBSERVATION",
          resolutionPrice: null,
          resolutionSource: {
            ...tickerProvenance(market, now.toISOString()),
            settlementClassification: SETTLEMENT_CLASSIFICATION,
            reason: "No LIVE Spot-proxy ticker had a source timestamp inside the permitted resolution window.",
            targetResolutionAt: signal.resolvesAt,
            latestAllowedSourceTimestamp: new Date(latestAllowedAt).toISOString(),
            observedMarketStatus: market.status ?? "UNAVAILABLE",
          },
          resolvedAt: now.toISOString(),
          expiredAt: now.toISOString(),
        });
      }
    }
  }
  captureCandidates(now = new Date()) {
    for (const symbol of this.settings.symbols) {
      const snapshot = this.market.snapshot(symbol);
      const candidates = snapshot?.analysis?.candidates;
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) this.captureCandidate(candidate, snapshot, now);
    }
  }
  captureCandidate(candidate, snapshot, now) {
    const candidateKey = typeof candidate?.decisionKey === "string" && candidate.decisionKey ? candidate.decisionKey : null;
    if (!candidateKey) return;
    const existing = this.database.manualResearchSignalByCandidateKey(candidateKey);
    if (existing && existing.status !== "WAIT") return;
    const market = snapshot.market ?? {};
    const freshTicker = snapshot.health?.dataUsable === true && market.status === "LIVE" && Number.isFinite(market.data?.lastPrice) && market.data.lastPrice > 0 && timestamp(market.sourceTimestamp) !== null && timestamp(market.receivedAt) !== null;
    const directional = candidate.direction === "UP" || candidate.direction === "DOWN";
    const finiteInvalidation = Number.isFinite(candidate.invalidationPrice);
    const activeSignal = directional ? this.database.currentManualResearchSignals(candidate.symbol).find((signal) => signal.horizonMinutes === candidate.horizonMinutes) : null;
    const confidence = this.confidence(candidate.symbol).find((item) => item.strategyVersion === candidate.strategyVersion && item.horizonMinutes === candidate.horizonMinutes);
    const underperforming = this.settings.confidenceGateEnabled && confidence?.status === "UNDERPERFORMING";
    const entryGate = this.market.evaluateEntry(candidate, now);
    const ready = directional && finiteInvalidation && freshTicker && entryGate.allowed && !activeSignal && !underperforming;
    const entryAt = ready ? now.toISOString() : null;
    const reasons = [...(candidate.reasons ?? [])];
    if (!snapshot.health?.dataUsable) reasons.push("Manual signal remains WAIT because snapshot health.dataUsable is false.");
    else if (!freshTicker) reasons.push("Manual signal remains WAIT because a fresh LIVE Spot-proxy ticker is unavailable.");
    if (directional && !finiteInvalidation) reasons.push("Manual signal remains WAIT because finite invalidation is required.");
    if (activeSignal) reasons.push(`Manual signal remains WAIT because READY signal ${activeSignal.id} is stable until resolution.`);
    if (underperforming) reasons.push("Manual signal remains WAIT because this segment's Wilson 95% upper bound is below the configured payout break-even reference.");
    for (const check of entryGate.checks.filter((item) => item.status === "BLOCKED")) reasons.push(`Entry gate ${check.code}: ${check.reason}`);
    const generatedAt = timestamp(snapshot.analysis?.calculatedAt) === null ? now.toISOString() : new Date(snapshot.analysis.calculatedAt).toISOString();
    const record = {
      id: deterministicId(candidateKey),
      candidateKey,
      symbol: candidate.symbol,
      horizonMinutes: candidate.horizonMinutes,
      direction: ["UP", "DOWN", "WAIT"].includes(candidate.direction) ? candidate.direction : "WAIT",
      status: ready ? "READY" : "WAIT",
      qualityScore: candidate.qualityScore,
      qualityBand: candidate.qualityBand,
      reasons,
      details: candidateDetails(candidate, entryGate),
      timeframeCloseWatermarks: candidate.timeframeCloseWatermarks ?? {},
      invalidation: typeof candidate.invalidationDetails === "object" && candidate.invalidationDetails !== null ? candidate.invalidationDetails : { price: candidate.invalidationPrice ?? null, text: candidate.invalidation ?? null },
      invalidationPrice: candidate.invalidationPrice ?? null,
      strategyName: candidate.strategyName,
      strategyVersion: candidate.strategyVersion,
      generatedAt,
      entryPrice: ready ? market.data.lastPrice : null,
      entryAt,
      entryValidUntil: ready ? new Date(Math.min(now.getTime() + this.settings.entryWindowMs, timestamp(candidate.triggerValidUntil))).toISOString() : null,
      resolvesAt: ready ? new Date(now.getTime() + candidate.horizonMinutes * 60_000).toISOString() : null,
      entrySource: ready ? { ...tickerProvenance(market, now.toISOString()), settlementClassification: SETTLEMENT_CLASSIFICATION, entryGate, orderBook: entryGate.orderBook, eventRisk: entryGate.eventRisk } : null,
      candleSources: snapshot.analysis?.sources ?? {},
      createdAt: existing?.createdAt ?? now.toISOString(),
    };
    if (!existing) this.database.createManualResearchSignal(record);
    else if (ready) this.database.promoteManualResearchSignal(existing.id, record);
    else this.database.updateWaitingManualResearchSignal(existing.id, { reasons: record.reasons, details: record.details });
  }
}
