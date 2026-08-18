import { createHash } from "node:crypto";
import { AUTONOMOUS_STRATEGY_VERSION } from "./quant.mjs";
import { CalibrationService } from "./calibration-service.mjs";

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
function segmentLabel(value) {
  if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
  if (value && typeof value === "object") {
    for (const key of ["segment", "regime", "label", "state", "status", "classification"]) if (typeof value[key] === "string" && value[key].trim()) return value[key].trim().toUpperCase();
  }
  return "UNSEGMENTED";
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
    setupDirection: candidate.setupDirection ?? null,
    actionableDirection: candidate.actionableDirection ?? null,
    referencePrice: candidate.referencePrice ?? null,
    forecast: candidate.forecast ?? null,
    correction: candidate.correction ?? null,
    levelInteractions: candidate.levelInteractions ?? null,
    levels: candidate.levels ?? {},
    volatilityRegime: candidate.volatilityRegime ?? null,
    marketRegime: candidate.marketRegime ?? null,
    persistentState: candidate.persistentState ?? null,
    confluenceComponents: candidate.confluenceComponents ?? [],
    structureFeatures: candidate.structureFeatures ?? {},
    technicalFeatures: candidate.technicalFeatures ?? {},
    reactionZones: candidate.reactionZones ?? null,
    engineBlockers: candidate.engineBlockers ?? [],
    canonicalVerdict: candidate.canonicalVerdict ?? null,
    qualityDefinition: candidate.qualityDefinition ?? null,
    entryGate,
  };
}

export class ManualSignalService {
  constructor({ market, database, settings, calibrationService = undefined, alertService = null, operationalService = null }) {
    this.market = market; this.database = database; this.settings = settings; this.alertService = alertService; this.operationalService = operationalService;
    const calibrationCapable = ["forecastObservationsForCalibration", "createCalibrationModel", "activeCalibrationModel", "createCalibrationMetricSnapshot"].every((method) => typeof database?.[method] === "function");
    this.calibrationService = calibrationService === undefined && calibrationCapable
      ? new CalibrationService({ database, minSample: settings.forecastCalibrationMinSample })
      : calibrationService;
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
      policyVersion: "entry-gates-v0.9.0",
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
  forecastCalibration(symbol = null) {
    const prospective = this.calibrationService?.status(symbol) ?? [];
    if (prospective.length) return prospective;
    const observed = this.database.forecastCalibration({ minSample: this.settings.forecastCalibrationMinSample, symbol });
    const bySegment = new Map(observed.filter((item) => item.strategyVersion === AUTONOMOUS_STRATEGY_VERSION).map((item) => [`${item.symbol}:${item.horizonMinutes}`, item]));
    const symbols = symbol ? [symbol] : this.settings.symbols;
    return symbols.flatMap((itemSymbol) => this.settings.horizons.map((horizonMinutes) => bySegment.get(`${itemSymbol}:${horizonMinutes}`) ?? {
      classification: "PROSPECTIVE_UNSELECTED_SPOT_PROXY_CALIBRATION",
      strategyVersion: AUTONOMOUS_STRATEGY_VERSION,
      symbol: itemSymbol,
      horizonMinutes,
      resolved: 0,
      decisiveSample: 0,
      directionalSample: 0,
      brierSample: 0,
      correct: 0,
      measuredAccuracy: null,
      brierScore: null,
      status: "WARMUP",
      minSample: this.settings.forecastCalibrationMinSample,
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
  terminal(symbol, now = new Date()) {
    if (!symbol) return null;
    const snapshot = this.market.snapshot(symbol);
    const candidates = snapshot?.analysis?.candidates ?? [];
    const signals = new Map(this.latestSegments(symbol).map((signal) => [signal.horizonMinutes, signal]));
    const confidence = new Map(this.confidence(symbol).map((item) => [item.horizonMinutes, item]));
    const blockerPriority = ["CURRENT_ENTRY_RECHECK", "FEED_HEALTH", "MARKET_FRESHNESS", "CANDLE_SOURCE_COHERENCE", "ORDER_FLOW", "EXTENDED_REGIME", "HORIZON_ENGINE", "CORRECTION_STATE", "LEVEL_STATE", "COMPLETED_1M_TRIGGER", "FIVE_MINUTE_CONFIRMATION", "FIFTEEN_MINUTE_ALIGNMENT", "TRIGGER_FRESHNESS", "QUALITY", "FINITE_INVALIDATION", "ORDER_BOOK_VALID", "SPREAD_LIMIT", "TOP_LIQUIDITY", "SOURCE_COHERENCE", "MACRO_NEWS", "DIRECTION"];
    const source = snapshot?.market ?? {};
    const rounds = this.settings.horizons.map((horizonMinutes) => {
      const candidate = candidates.find((item) => item.horizonMinutes === horizonMinutes) ?? null;
      const latestSignal = signals.get(horizonMinutes) ?? null;
      const activeSignal = latestSignal?.status === "READY" ? latestSignal : null;
      const matchingSignal = candidate && latestSignal?.candidateKey === candidate.decisionKey ? latestSignal : null;
      const signal = activeSignal ?? matchingSignal ?? (!candidate ? latestSignal : null);
      const details = signal?.details ?? candidate ?? {};
      const gate = signal?.currentEntryGate ?? (!signal && candidate ? this.market.evaluateEntry(candidate, now) : signal?.details?.entryGate ?? null);
      const checks = gate?.checks ?? [];
      const blocked = blockerPriority.map((code) => checks.find((check) => check.code === code && check.status === "BLOCKED")).find(Boolean) ?? null;
      const actionState = !this.settings.enabled
        ? "DISABLED"
        : signal?.actionState ?? (candidate && gate?.allowed && ["UP", "DOWN"].includes(candidate.direction) ? "READY_PENDING_CAPTURE" : blocked ? "BLOCKED" : "WAIT");
      const actionable = actionState === "ENTER_NOW";
      const tracking = actionState === "TRACKING_DO_NOT_ENTER_LATE";
      const resolved = signal?.status === "EXPIRED";
      const disabled = actionState === "DISABLED";
      const state = actionable ? "ENTER_NOW" : tracking ? "TRACKING" : resolved ? "RESOLVED" : disabled ? "DISABLED" : ["BLOCKED_CURRENT_GATES", "BLOCKED"].includes(actionState) || blocked ? "BLOCKED" : "WAIT";
      const displayDetails = tracking || resolved ? details : candidate ?? details;
      const noCurrentCandidateBlocker = !candidate ? {
        code: "NO_CURRENT_CANDIDATE",
        source: "MANUAL_SIGNAL_TERMINAL",
        timeframe: `${horizonMinutes}m`,
        observed: 0,
        required: 1,
        reason: `No current ${horizonMinutes}m canonical candidate is available for ${symbol}.`,
        evidence: { symbol, horizonMinutes, analysisCalculatedAt: snapshot?.analysis?.calculatedAt ?? null },
      } : null;
      const setupDirection = displayDetails.setupDirection ?? (signal?.direction === "WAIT" ? "NEUTRAL" : signal?.direction) ?? "NEUTRAL";
      const oneMinute = displayDetails.technicalFeatures?.oneMinuteTrigger ?? null;
      const oneMinuteFlow = displayDetails.technicalFeatures?.oneMinuteFlow ?? null;
      const fiveMinuteTrend = displayDetails.technicalFeatures?.fiveMinuteTrend ?? null;
      const fiveMinute = displayDetails.technicalFeatures?.fiveMinuteConfirmation ?? null;
      const fifteenMinute = displayDetails.technicalFeatures?.fifteenMinuteAlignment ?? null;
      const levels = displayDetails.levels ?? {};
      const primaryBlocker = state === "TRACKING"
        ? { code: "ENTRY_WINDOW_CLOSED", text: "Entry window closed. Track the recorded call only; do not enter late." }
        : state === "RESOLVED"
          ? { code: signal?.proxyOutcome ?? "RESOLVED", text: "The proxy observation is finished; this is history, not a new entry." }
          : state === "DISABLED"
            ? { code: "SIGNAL_DESK_DISABLED", text: "Manual signal scanning is disabled; no current setup can be acted on." }
            : noCurrentCandidateBlocker ? { code: noCurrentCandidateBlocker.code, text: noCurrentCandidateBlocker.reason, metadata: noCurrentCandidateBlocker }
              : blocked ? { code: blocked.code, text: blocked.reason }
                : state === "WAIT" ? { code: "WAIT_FOR_SETUP", text: displayDetails.reasons?.find((reason) => reason.startsWith("Entry blocked")) ?? displayDetails.reasons?.at(-2) ?? "Waiting for completed 1m, 5m and 15m alignment." } : null;
      const qualityScore = displayDetails.qualityScore ?? signal?.qualityScore ?? 0;
      const watermarks = displayDetails.timeframeCloseWatermarks ?? signal?.timeframeCloseWatermarks ?? {};
      const fallbackForecast = {
        upPercent: null,
        downPercent: null,
        leader: "NEUTRAL",
        edgePercent: null,
        confidence: "LOW",
        available: false,
        availability: { status: "UNAVAILABLE", blockers: [noCurrentCandidateBlocker].filter(Boolean), observedAt: now.toISOString() },
        classification: "UNCALIBRATED_TECHNICAL_DIRECTION_ESTIMATE_NOT_WIN_PROBABILITY",
      };
      const currentAnalysisAvailable = Boolean(candidate) || tracking || resolved;
      return {
        roundId: `${symbol}:${horizonMinutes}:${signal?.candidateKey ?? candidate?.decisionKey ?? "waiting"}`,
        classification: "MANUAL_EVENT_FUTURES_SIGNAL_USING_SPOT_PROXY",
        symbol,
        horizonMinutes,
        state,
        setupDirection,
        forecast: currentAnalysisAvailable ? displayDetails.forecast ?? fallbackForecast : fallbackForecast,
        marketFlow: { oneMinute: oneMinuteFlow, fiveMinute: fiveMinuteTrend },
        correction: displayDetails.correction ?? null,
        levelInteractions: displayDetails.levelInteractions ?? null,
        actionable: { allowed: actionable, direction: actionable ? signal?.direction ?? null : null, entryValidUntil: signal?.entryValidUntil ?? null, primaryBlocker, blockedCount: checks.filter((check) => check.status === "BLOCKED").length },
        timing: { generatedAt: signal?.generatedAt ?? snapshot?.analysis?.calculatedAt ?? null, entryValidUntil: signal?.entryValidUntil ?? candidate?.triggerValidUntil ?? null, targetAt: signal?.resolvesAt ?? null },
        prices: {
          reference: { value: displayDetails.referencePrice ?? null, basis: "LATEST_COMPLETED_1M_CLOSE", observedAt: watermarks["1m"] ?? null },
          entry: { value: signal?.entryPrice ?? null, observedAt: signal?.entryAt ?? null },
          current: { value: source.data?.lastPrice ?? null, observedAt: source.sourceTimestamp ?? null },
        },
        confirmations: {
          oneMinute: { status: checks.find((check) => check.code === "COMPLETED_1M_TRIGGER")?.status ?? "BLOCKED", direction: oneMinute?.direction ?? "NEUTRAL", completedAt: oneMinute?.candleCloseTime ?? null, strength: oneMinute?.strength ?? 0, patterns: oneMinute?.patterns ?? [] },
          fiveMinute: { status: checks.find((check) => check.code === "FIVE_MINUTE_CONFIRMATION")?.status ?? "BLOCKED", direction: fiveMinute?.direction ?? "NEUTRAL", completedAt: fiveMinute?.watermark ?? null, evidence: fiveMinute?.evidence ?? null },
          fifteenMinute: { status: checks.find((check) => check.code === "FIFTEEN_MINUTE_ALIGNMENT")?.status ?? "BLOCKED", direction: fifteenMinute?.direction ?? "NEUTRAL", regime: fifteenMinute?.regime ?? "INSUFFICIENT_DATA", completedAt: fifteenMinute?.watermark ?? null, evidence: fifteenMinute?.evidence ?? null },
        },
        levels: { support: levels.support ?? null, resistance: levels.resistance ?? null, invalidation: levels.invalidation ?? signal?.invalidation ?? displayDetails.invalidationDetails ?? null },
        quality: { score: qualityScore, band: displayDetails.qualityBand ?? signal?.qualityBand ?? "BELOW_STANDARD", minimum: this.settings.qualityThreshold ?? 68, passed: checks.find((check) => check.code === "QUALITY")?.status === "PASS", classification: "DETERMINISTIC_SETUP_QUALITY_NOT_PROBABILITY" },
        confidence: confidence.get(horizonMinutes) ?? null,
        readiness: gate?.readiness ?? null,
        marketRegime: displayDetails.marketRegime ?? null,
        persistentState: displayDetails.persistentState ?? null,
        reactionZones: currentAnalysisAvailable ? displayDetails.reactionZones ?? null : null,
        details: { checks, reasons: displayDetails.reasons ?? signal?.reasons ?? [], confluenceComponents: displayDetails.confluenceComponents ?? [], volatilityRegime: displayDetails.volatilityRegime ?? null, marketRegime: displayDetails.marketRegime ?? null, persistentState: displayDetails.persistentState ?? null, timeframeWatermarks: watermarks, entrySource: signal?.entrySource ?? null, noCurrentCandidate: noCurrentCandidateBlocker },
      };
    });
    return {
      classification: "MANUAL_EVENT_FUTURES_TERMINAL_USING_ATTRIBUTED_SPOT_PROXY",
      observedAt: now.toISOString(), symbol,
      source: { status: source.status ?? "UNAVAILABLE", source: source.source ?? null, sourceName: source.sourceName ?? null, sourceTimestamp: source.sourceTimestamp ?? null, receivedAt: source.receivedAt ?? null, fallback: source.failover ?? null, feed: snapshot?.health?.feed ?? null, candleSources: snapshot?.analysis?.sources ?? null, candleStatuses: snapshot?.health?.candles ?? null, analysisCalculatedAt: snapshot?.analysis?.calculatedAt ?? null, completedOneMinuteAt: snapshot?.candles?.["1m"]?.latestCompletedCloseTime ?? null, completedFiveMinuteAt: snapshot?.candles?.["5m"]?.latestCompletedCloseTime ?? null, analysisCoherent: snapshot?.health?.analysisCoherent ?? false, actionSourceCoherent: snapshot?.health?.actionSourceCoherent ?? false, entryCoherent: snapshot?.health?.entryCoherent ?? false },
      currentPrice: { value: source.data?.lastPrice ?? null, observedAt: source.sourceTimestamp ?? null },
      rounds,
    };
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
      terminal: this.terminal(symbol),
      current: this.latestSegments(symbol),
      ready: this.ready(symbol),
      recent: this.recent(50, symbol),
      empiricalConfidence: this.confidence(symbol),
      forecastCalibration: this.forecastCalibration(symbol),
      policy: {
        scanMs: this.settings.scanMs,
        entryWindowMs: this.settings.entryWindowMs,
        maxResolutionLagMs: this.settings.maxResolutionLagMs,
        minDecisiveSample: this.settings.minDecisiveSample,
        forecastCalibrationMinSample: this.settings.forecastCalibrationMinSample,
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
      this.captureCandidates();
      this.lastError = null;
    } finally { this.busy = false; }
  }
  reconcileReady(now = new Date()) {
    this.reconcileForecastObservations(now);
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
  firstCompleteOneMinuteCandle(snapshot, resolvesAt, now = new Date()) {
    const target = timestamp(resolvesAt); const observed = timestamp(now);
    if (target === null || observed === null) return null;
    const envelope = snapshot?.candles?.["1m"];
    const candidates = (envelope?.data ?? [])
      .filter((candle) => candle?.closed === true && Number.isFinite(candle.openTime) && Number.isFinite(candle.close) && candle.close > 0)
      .map((candle) => ({ candle, openAt: candle.openTime, closeAt: candle.openTime + 60_000 }))
      .filter((item) => item.openAt <= target && target < item.closeAt && item.closeAt <= observed)
      .sort((left, right) => left.closeAt - right.closeAt);
    const selected = candidates[0];
    if (!selected) return null;
    return {
      price: selected.candle.close,
      openAt: new Date(selected.openAt).toISOString(),
      closeAt: new Date(selected.closeAt).toISOString(),
      source: {
        classification: MARKET_CLASSIFICATION,
        source: envelope?.source ?? null,
        sourceName: envelope?.sourceName ?? null,
        sourceUrl: envelope?.sourceUrl ?? null,
        sourceTimestamp: envelope?.sourceTimestamp ?? null,
        receivedAt: envelope?.receivedAt ?? null,
        failover: envelope?.failover ?? null,
        observedAt: new Date(observed).toISOString(),
      },
    };
  }
  reconcileForecastObservations(now = new Date()) {
    for (const observation of this.database.pendingForecastObservations(now.toISOString(), 2000)) {
      const resolvesAt = timestamp(observation.resolvesAt); if (resolvesAt === null) continue;
      const snapshot = this.market.snapshot(observation.symbol);
      if (observation.resolutionPolicy === "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON") {
        const resolution = this.firstCompleteOneMinuteCandle(snapshot, resolvesAt, now);
        if (!resolution) {
          const latestExpectedCloseAt = resolvesAt + 60_000;
          const unavailableAfter = latestExpectedCloseAt + this.settings.maxResolutionLagMs;
          if (now.getTime() > unavailableAfter) {
            this.database.resolveForecastObservation(observation.id, {
              outcome: "NO_COMPLETE_1M_OBSERVATION",
              actualDirection: "UNAVAILABLE",
              resolutionPrice: null,
              resolutionSource: {
                classification: MARKET_CLASSIFICATION,
                settlementClassification: SETTLEMENT_CLASSIFICATION,
                targetResolutionAt: observation.resolvesAt,
                unavailableAfter: new Date(unavailableAfter).toISOString(),
                observedAt: now.toISOString(),
                reason: "The authoritative first complete 1m candle after the horizon was not available inside the bounded resolution window; this outcome is excluded from calibration.",
              },
              resolvedAt: now.toISOString(),
            });
          }
          continue;
        }
        const actualDirection = resolution.price === observation.entryPrice ? "TIE" : resolution.price > observation.entryPrice ? "UP" : "DOWN";
        const outcome = actualDirection === "TIE" ? "TIE" : observation.predictedDirection === "NEUTRAL" ? "UNSCORED_DIRECTION" : observation.predictedDirection === actualDirection ? "CORRECT" : "INCORRECT";
        this.database.resolveForecastObservation(observation.id, {
          outcome,
          actualDirection,
          resolutionPrice: resolution.price,
          resolutionCandleOpenAt: resolution.openAt,
          resolutionCandleCloseAt: resolution.closeAt,
          resolutionSource: { ...resolution.source, targetResolutionAt: observation.resolvesAt, settlementClassification: SETTLEMENT_CLASSIFICATION },
          resolvedAt: now.toISOString(),
        });
        continue;
      }
      const latestAllowedAt = resolvesAt + this.settings.maxResolutionLagMs;
      const market = snapshot?.market ?? {};
      const sourceTimestamp = timestamp(market.sourceTimestamp); const price = market.data?.lastPrice;
      const timely = market.status === "LIVE" && Number.isFinite(price) && price > 0 && sourceTimestamp !== null && sourceTimestamp >= resolvesAt && sourceTimestamp <= latestAllowedAt;
      if (timely) {
        const actualDirection = price === observation.entryPrice ? "TIE" : price > observation.entryPrice ? "UP" : "DOWN";
        const outcome = actualDirection === "TIE" ? "TIE" : observation.predictedDirection === "NEUTRAL" ? "UNSCORED_DIRECTION" : observation.predictedDirection === actualDirection ? "CORRECT" : "INCORRECT";
        this.database.resolveForecastObservation(observation.id, {
          outcome,
          actualDirection,
          resolutionPrice: price,
          resolutionSource: { ...tickerProvenance(market, now.toISOString()), targetResolutionAt: observation.resolvesAt, latestAllowedSourceTimestamp: new Date(latestAllowedAt).toISOString() },
          resolvedAt: now.toISOString(),
        });
      } else if (now.getTime() > latestAllowedAt) {
        this.database.resolveForecastObservation(observation.id, {
          outcome: "NO_TIMELY_OBSERVATION", actualDirection: "UNAVAILABLE", resolutionPrice: null,
          resolutionSource: { ...tickerProvenance(market, now.toISOString()), targetResolutionAt: observation.resolvesAt, reason: "No LIVE Spot-proxy ticker was observed inside the allowed resolution window." },
          resolvedAt: now.toISOString(),
        });
      }
    }
  }
  captureForecastObservation(candidate, snapshot, now) {
    const generatedMs = timestamp(now);
    if (generatedMs === null) return;
    const generatedAt = new Date(generatedMs).toISOString();
    const entryPrice = candidate?.referencePrice; const forecast = candidate?.forecast;
    if (!candidate?.decisionKey || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(forecast?.upPercent) || !Number.isFinite(forecast?.downPercent)) return;
    const predictedDirection = ["UP", "DOWN"].includes(forecast.leader) ? forecast.leader : forecast.upPercent >= forecast.downPercent ? "UP" : "DOWN";
    const calibration = this.calibrationService?.prepareForecast({ ...candidate, predictedDirection }, generatedAt) ?? null;
    if (calibration) this.alertService?.calibration({ scope: "CALIBRATION", entity: `${candidate.symbol}.${candidate.horizonMinutes}M.${predictedDirection}`, symbol: candidate.symbol, channel: "CALIBRATION", previousState: "UNINITIALIZED", state: calibration.status ?? "UNAVAILABLE", observedAt: generatedAt, payload: { classification: "PAPER_RESEARCH_CALIBRATION_ALERT", liveExecutionAvailable: false, horizonMinutes: candidate.horizonMinutes, direction: predictedDirection, method: calibration.calibrationMethod, modelId: calibration.calibrationModelId, sampleSize: calibration.sampleSize, minSample: calibration.minSample } });
    const observationKey = `${candidate.decisionKey}:prospective-unselected`;
    const entryGate = this.market.evaluateEntry(candidate, now);
    const rawProbabilityUp = calibration?.rawProbabilityUp ?? null;
    this.database.createForecastObservation({
      id: `forecast_${createHash("sha256").update(observationKey).digest("hex")}`,
      observationKey, strategyName: candidate.strategyName, strategyVersion: candidate.strategyVersion,
      forecastModelName: calibration?.forecastModelName ?? candidate.forecastModelName ?? "TECHNICAL_DIRECTION_SCORE",
      forecastModelVersion: calibration?.forecastModelVersion ?? candidate.forecastModelVersion ?? candidate.strategyVersion ?? "UNVERSIONED",
      symbol: candidate.symbol, horizonMinutes: candidate.horizonMinutes,
      generatedAt, resolvesAt: new Date(generatedMs + candidate.horizonMinutes * 60_000).toISOString(),
      entryPrice, predictedDirection,
      upScore: forecast.upPercent, downScore: forecast.downPercent, qualityScore: candidate.qualityScore ?? 0,
      volatilitySegment: calibration?.volatilitySegment ?? segmentLabel(candidate.volatilityRegime),
      regimeSegment: calibration?.regimeSegment ?? segmentLabel(candidate.marketRegime),
      calibrationMethod: calibration?.calibrationMethod ?? "RAW",
      calibrationModelId: calibration?.calibrationModelId ?? null,
      rawProbabilityUp,
      calibratedProbabilityUp: calibration?.calibrationMethod && calibration.calibrationMethod !== "RAW" ? calibration.calibratedProbabilityUp : null,
      resolutionPolicy: "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON",
      readiness: entryGate.readiness ?? { ready: entryGate.allowed, checks: entryGate.checks }, regime: candidate.marketRegime ?? {},
      features: {
        decisionAt: generatedAt,
        featureCloseWatermarks: candidate.timeframeCloseWatermarks ?? null,
        setupDirection: candidate.setupDirection,
        correction: candidate.correction,
        levelInteractions: candidate.levelInteractions,
        technicalFeatures: candidate.technicalFeatures,
        rawForecast: { upScore: forecast.upPercent, downScore: forecast.downPercent, classification: "UNCALIBRATED_TECHNICAL_DIRECTION_SCORE_NOT_PROBABILITY", probability: null },
        calibration: calibration ? { status: calibration.status, classification: calibration.classification, sampleSize: calibration.sampleSize, minSample: calibration.minSample, probabilityUp: calibration.probabilityUp, trainedThrough: calibration.trainedThrough } : { status: "UNAVAILABLE", probabilityUp: null },
      },
      source: { market: tickerProvenance(snapshot.market ?? {}, now.toISOString()), candles: snapshot.analysis?.sources ?? {}, classification: "PAPER_RESEARCH_ONLY" },
    });
  }
  captureCandidates() {
    for (const symbol of this.settings.symbols) {
      const snapshot = this.market.snapshot(symbol);
      const candidates = snapshot?.analysis?.candidates;
      if (!Array.isArray(candidates)) continue;
      for (const candidate of candidates) this.captureCandidate(candidate, snapshot, new Date());
    }
  }
  captureCandidate(candidate, snapshot, now) {
    const candidateKey = typeof candidate?.decisionKey === "string" && candidate.decisionKey ? candidate.decisionKey : null;
    if (!candidateKey) return;
    this.captureForecastObservation(candidate, snapshot, now);
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
    this.alertService?.ready({ scope: "MANUAL_SIGNAL", entity: `${candidate.symbol}.${candidate.horizonMinutes}M`, symbol: candidate.symbol, channel: "MANUAL_SIGNAL", previousState: "UNINITIALIZED", state: ready ? "READY" : "WAIT", observedAt: now.toISOString(), payload: { classification: "PAPER_RESEARCH_READY_ALERT", liveExecutionAvailable: false, horizonMinutes: candidate.horizonMinutes, decisionKey: candidate.decisionKey, direction: candidate.direction, blockers: entryGate.checks?.filter((check) => check.status === "BLOCKED").map((check) => check.code) ?? [] } });
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
