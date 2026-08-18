export const SIGNAL_FEATURES_VERSION = "signal-features-v0.9.0";
export const SIGNAL_TIMEFRAMES = Object.freeze(["1m", "5m", "15m", "1h"]);

export function clamp(value, minimum = -1, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

export function normalizeDirection(value) {
  const direction = String(value ?? "").toUpperCase();
  if (["UP", "BULLISH", "LONG", "BUY"].includes(direction)) return "UP";
  if (["DOWN", "BEARISH", "SHORT", "SELL"].includes(direction)) return "DOWN";
  return "NEUTRAL";
}

export function directionSign(value) {
  const direction = normalizeDirection(value);
  return direction === "UP" ? 1 : direction === "DOWN" ? -1 : 0;
}

export function normalizeStrength(value, fallback = 1) {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.abs(value) > 1 ? Math.abs(value) / 100 : Math.abs(value), 0, 1);
}

export function scoreDirection(direction, strength = 1) {
  return directionSign(direction) * normalizeStrength(strength, 1);
}

export function scoreFeature(feature, options = {}) {
  const source = feature && typeof feature === "object" ? feature : {};
  const unavailableStatuses = new Set(["UNAVAILABLE", "INSUFFICIENT_DATA", "ERROR", "STALE", "INVALID", "REST_FALLBACK"]);
  const status = String(source.status ?? options.status ?? "READY").toUpperCase();
  const explicitlyUnavailable = source.available === false || source.valid === false || unavailableStatuses.has(status);
  const signedCandidate = [source.signedScore, source.signedEvidence, source.score, source.value].find(Number.isFinite);
  const direction = normalizeDirection(source.direction ?? source.structureDirection ?? source.regime ?? options.direction);
  const strength = [source.strength, source.strengthPercent, source.confidence, source.confidencePercent, options.strength].find(Number.isFinite);
  const hasDirectionalInput = direction !== "NEUTRAL" || Number.isFinite(signedCandidate);
  const available = !explicitlyUnavailable && (source.available === true || source.valid === true || hasDirectionalInput || options.neutralIsAvailable === true);
  const signedScore = available
    ? clamp(Number.isFinite(signedCandidate) ? signedCandidate : scoreDirection(direction, strength), -1, 1)
    : 0;
  return {
    available,
    direction: signedScore > 0 ? "UP" : signedScore < 0 ? "DOWN" : direction,
    signedScore,
    status: available ? status : status === "READY" ? "UNAVAILABLE" : status,
  };
}

export function applyWeight(score, weight) {
  if (!Number.isFinite(score) || !Number.isFinite(weight) || weight < 0) return 0;
  return clamp(score, -1, 1) * weight;
}

export function normalizeWeights(weights = {}) {
  const entries = Object.entries(weights).map(([key, value]) => [key, Number.isFinite(value) && value > 0 ? value : 0]);
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return Object.freeze(Object.fromEntries(entries.map(([key, value]) => [key, total > 0 ? value / total : 0])));
}

export function weightedScore(components = []) {
  const available = components.filter((component) => component?.available === true && Number.isFinite(component.signedScore) && Number.isFinite(component.weight) && component.weight >= 0);
  const weight = available.reduce((sum, component) => sum + component.weight, 0);
  if (!(weight > 0)) return { available: false, signedEvidence: 0, availableWeight: 0 };
  const signedEvidence = clamp(available.reduce((sum, component) => sum + applyWeight(component.signedScore, component.weight), 0) / weight, -1, 1);
  return { available: true, signedEvidence, availableWeight: weight };
}

function completedCandles(candles) {
  return Array.isArray(candles) ? candles.filter((candle) => candle?.closed === true) : [];
}

function completedWatermark(candles) {
  const closeTime = candles.at(-1)?.closeTime;
  if (!Number.isFinite(closeTime)) return null;
  const timestamp = new Date(closeTime);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function latestClose(candles) {
  const close = candles.at(-1)?.close;
  return Number.isFinite(close) && close > 0 ? close : null;
}

function analysisDirection(analysis) {
  return normalizeDirection(analysis?.direction ?? analysis?.regime);
}

function analysisScore(analysis) {
  if (!analysis || analysis.regime === "INSUFFICIENT_DATA") return { available: false, direction: "NEUTRAL", signedScore: 0, status: "INSUFFICIENT_DATA" };
  const indicators = analysis.indicators ?? {};
  const atrValue = finiteOrNull(indicators.atr14);
  const separation = Number.isFinite(indicators.ema9) && Number.isFinite(indicators.ema21) && atrValue > 0
    ? Math.abs(indicators.ema9 - indicators.ema21) / atrValue
    : null;
  return scoreFeature({
    status: "READY",
    direction: analysisDirection(analysis),
    strength: separation === null ? 0.5 : clamp(separation / 0.8, 0.2, 1),
  }, { neutralIsAvailable: true });
}

function structureScore(structure) {
  return scoreFeature({
    status: structure?.status,
    direction: structure?.structureDirection,
    strength: structure?.structureEvidence?.latestShift ? 1 : 0.7,
  }, { neutralIsAvailable: structure?.status === "READY" });
}

function orderFlowScore(source) {
  if (!source || typeof source !== "object") return { available: false, direction: "NEUTRAL", signedScore: 0, status: "UNAVAILABLE" };
  const direct = [source.signedScore, source.signedEvidence, source.netImbalance, source.bookImbalance, source.depthImbalance].find(Number.isFinite);
  const nestedImbalance = [10, 5, 20].map((levels) => source.imbalance?.[levels]?.notionalImbalance ?? source.imbalance?.[String(levels)]?.notionalImbalance).find(Number.isFinite);
  const flowWindow = source.aggressorVolume?.["60s"] ?? source.aggressorVolume?.["5m"] ?? source.aggressorVolume?.["30s"];
  const totalAggressorNotional = Number.isFinite(flowWindow?.totalNotional)
    ? flowWindow.totalNotional
    : Number.isFinite(flowWindow?.buyNotional) && Number.isFinite(flowWindow?.sellNotional) ? flowWindow.buyNotional + flowWindow.sellNotional : null;
  const aggressorScore = totalAggressorNotional > 0
    ? clamp((flowWindow.buyNotional - flowWindow.sellNotional) / totalAggressorNotional, -1, 1)
    : null;
  const micropriceScore = Number.isFinite(source.microprice?.deviationBps) ? clamp(source.microprice.deviationBps / 5, -1, 1) : null;
  const nestedParts = [
    { value: nestedImbalance, weight: 0.45 },
    { value: aggressorScore, weight: 0.4 },
    { value: micropriceScore, weight: 0.15 },
  ].filter((part) => Number.isFinite(part.value));
  const nestedScore = nestedParts.length
    ? nestedParts.reduce((sum, part) => sum + part.value * part.weight, 0) / nestedParts.reduce((sum, part) => sum + part.weight, 0)
    : null;
  const buyRatio = [source.buyRatio, source.aggressorBuyRatio].find(Number.isFinite);
  const ratioScore = Number.isFinite(buyRatio) ? clamp((buyRatio - 0.5) * 2, -1, 1) : null;
  return scoreFeature({
    ...source,
    signedScore: [direct, nestedScore, ratioScore].find(Number.isFinite),
    direction: source.direction,
  });
}

function correctionScore(correction) {
  if (!correction || typeof correction !== "object") return { available: false, direction: "NEUTRAL", signedScore: 0, status: "UNAVAILABLE" };
  const status = String(correction.status ?? "UNAVAILABLE").toUpperCase();
  if (["UNAVAILABLE", "INSUFFICIENT_DATA", "NO_TREND"].includes(status)) return { available: false, direction: "NEUTRAL", signedScore: 0, status };
  if (status === "NO_CORRECTION") return { available: true, direction: "NEUTRAL", signedScore: 0, status };
  const trendDirection = normalizeDirection(correction.trendDirection);
  const correctionDirection = normalizeDirection(correction.correctionDirection) !== "NEUTRAL"
    ? normalizeDirection(correction.correctionDirection)
    : trendDirection === "UP" ? "DOWN" : trendDirection === "DOWN" ? "UP" : "NEUTRAL";
  const depth = Number.isFinite(correction.depthAtr) ? clamp(correction.depthAtr / 1.2, 0.2, 1) : 0.5;
  if (status === "CORRECTION_END_CONFIRMED") return scoreFeature({ status, direction: trendDirection, strength: Math.max(0.65, depth) });
  return scoreFeature({ status, direction: correctionDirection, strength: depth });
}

function combineFeatures(left, right, leftWeight = 0.5) {
  const parts = [
    { ...left, weight: leftWeight },
    { ...right, weight: 1 - leftWeight },
  ];
  const combined = weightedScore(parts);
  return {
    available: combined.available,
    signedScore: combined.signedEvidence,
    direction: combined.signedEvidence > 0 ? "UP" : combined.signedEvidence < 0 ? "DOWN" : "NEUTRAL",
    status: combined.available ? "READY" : "UNAVAILABLE",
  };
}

export function normalizeSignalContext(context = {}) {
  const source = context?.context && typeof context.context === "object" ? context.context : context;
  const candleSource = source.completed ?? source.candles ?? {};
  const candles = Object.fromEntries(SIGNAL_TIMEFRAMES.map((timeframe) => [timeframe, completedCandles(candleSource[timeframe])]));
  const analyses = source.analyses ?? source.timeframes ?? source.analysis?.timeframes ?? {};
  const structureFeatures = source.structureFeatures ?? source.structure ?? {};
  const technicalFeatures = source.technicalFeatures ?? {};
  const oneMinuteTrigger = source.oneMinuteTrigger ?? technicalFeatures.oneMinuteTrigger ?? {};
  const oneMinuteFlow = source.oneMinuteFlow ?? technicalFeatures.oneMinuteFlow ?? {};
  const fiveMinuteTrend = source.fiveMinuteTrend ?? technicalFeatures.fiveMinuteTrend ?? {};
  const correction = source.correction ?? technicalFeatures.correction ?? {};
  const orderFlow = source.orderFlow ?? technicalFeatures.orderFlow ?? source.flow ?? source.orderBookFlow ?? {};
  const flowBook = orderFlow?.microprice && orderFlow?.imbalance
    ? {
      valid: orderFlow.status === "LIVE",
      spreadBps: Number.isFinite(orderFlow.microprice.bestBid) && Number.isFinite(orderFlow.microprice.bestAsk) && orderFlow.microprice.midPrice > 0
        ? (orderFlow.microprice.bestAsk - orderFlow.microprice.bestBid) / orderFlow.microprice.midPrice * 10000
        : null,
      topNotional: Number.isFinite(orderFlow.imbalance?.[10]?.bidNotional) && Number.isFinite(orderFlow.imbalance?.[10]?.askNotional)
        ? Math.min(orderFlow.imbalance[10].bidNotional, orderFlow.imbalance[10].askNotional)
        : null,
    }
    : {};
  const orderBookMetrics = source.orderBookMetrics ?? source.orderBook?.metrics ?? source.snapshot?.orderBook?.metrics ?? flowBook;
  const watermarks = Object.fromEntries(SIGNAL_TIMEFRAMES.map((timeframe) => [
    timeframe,
    source.timeframeCloseWatermarks?.[timeframe] ?? completedWatermark(candles[timeframe]),
  ]));

  const triggerFeature = scoreFeature(oneMinuteTrigger, { neutralIsAvailable: oneMinuteTrigger?.closed === true });
  if (oneMinuteTrigger?.closed !== true) triggerFeature.available = false;
  const flowFeature = orderFlowScore(oneMinuteFlow);
  const oneMinuteFeature = combineFeatures(triggerFeature, flowFeature, 0.62);
  const fiveTrendFeature = scoreFeature(fiveMinuteTrend);
  const fiveAnalysisFeature = analysisScore(analyses["5m"]);
  const fiveStructureFeature = structureScore(structureFeatures["5m"]);
  const fiveMinuteFeature = combineFeatures(combineFeatures(fiveTrendFeature, fiveAnalysisFeature, 0.6), fiveStructureFeature, 0.65);
  const higherTimeframeRegimes = technicalFeatures.higherTimeframeRegimes ?? {};
  const fifteenMinuteFeature = analysisScore(analyses["15m"] ?? { regime: higherTimeframeRegimes["15m"] });
  const oneHourFeature = analysisScore(analyses["1h"] ?? { regime: higherTimeframeRegimes["1h"] });
  const structureFeature = combineFeatures(structureScore(structureFeatures["15m"]), structureScore(structureFeatures["1h"]), 0.55);

  const indicators = Object.fromEntries(SIGNAL_TIMEFRAMES.map((timeframe) => [timeframe, analyses[timeframe]?.indicators ?? source.indicators?.[timeframe] ?? {}]));
  const currentPrice = finiteOrNull(source.referencePrice) ?? latestClose(candles["1m"]);
  const atr14 = finiteOrNull(indicators["1m"]?.atr14);
  const atrFraction = finiteOrNull(source.marketRegime?.atrFraction)
    ?? (atr14 !== null && currentPrice !== null ? atr14 / currentPrice : null);

  return {
    version: SIGNAL_FEATURES_VERSION,
    source,
    symbol: source.symbol ?? "UNKNOWN",
    candles,
    analyses,
    indicators,
    structureFeatures,
    technicalFeatures: { ...technicalFeatures, oneMinuteTrigger, oneMinuteFlow, fiveMinuteTrend },
    correction,
    orderFlow,
    orderBookMetrics,
    timeframeCloseWatermarks: watermarks,
    referencePrice: currentPrice,
    atrFraction,
    marketRegime: source.extendedRegime ?? source.marketRegime ?? null,
    features: {
      orderFlow: orderFlowScore(orderFlow),
      oneMinute: oneMinuteFeature,
      fiveMinute: fiveMinuteFeature,
      fifteenMinute: fifteenMinuteFeature,
      oneHour: oneHourFeature,
      structure: structureFeature,
      correction: correctionScore(correction),
    },
  };
}

export const normalizeContext = normalizeSignalContext;
export const score = scoreFeature;
export const weight = applyWeight;


export function evaluateFeatureMatrix(input, configuration) {
  const context = input?.features && input?.timeframeCloseWatermarks ? input : normalizeSignalContext(input);
  const regimeResult = configuration.regimeResult;
  const regime = regimeResult?.regime ?? "LOW_LIQUIDITY";
  const matrix = configuration.matrices[regime] ?? configuration.matrices.RANGE;
  const weights = normalizeWeights(matrix);
  const components = Object.entries(weights).map(([key, componentWeight]) => {
    const feature = context.features[key] ?? { available: false, direction: "NEUTRAL", signedScore: 0, status: "UNAVAILABLE" };
    const signedScore = feature.available === true && Number.isFinite(feature.signedScore) ? clamp(feature.signedScore, -1, 1) : 0;
    return Object.freeze({
      key,
      label: configuration.labels?.[key] ?? key,
      timeframe: configuration.timeframes?.[key] ?? null,
      available: feature.available === true,
      status: feature.status ?? (feature.available === true ? "READY" : "UNAVAILABLE"),
      direction: normalizeDirection(feature.direction),
      signedScore,
      weight: componentWeight,
      weightedEvidence: applyWeight(signedScore, componentWeight),
    });
  });
  const blockers = [];
  if (!regimeResult || regimeResult.failClosed === true) blockers.push(Object.freeze({
    code: "REGIME_FAIL_CLOSED",
    reason: !regimeResult ? "Extended regime classification is unavailable." : `${regime} requires fail-closed handling.`,
    evidence: regimeResult?.evidence ?? null,
  }));
  for (const key of configuration.requiredFeatures ?? []) {
    const feature = context.features[key];
    if (feature?.available !== true) blockers.push(Object.freeze({
      code: `MISSING_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`,
      reason: `${configuration.labels?.[key] ?? key} is unavailable; evaluation fails closed.`,
      evidence: feature ?? null,
    }));
  }
  const correctionStatus = String(context.correction?.status ?? "UNAVAILABLE").toUpperCase();
  if ((configuration.blockedCorrectionStatuses ?? []).includes(correctionStatus)) blockers.push(Object.freeze({
    code: "CORRECTION_BLOCKED",
    reason: `Correction state ${correctionStatus} blocks this horizon.`,
    evidence: context.correction,
  }));
  if (!SIGNAL_TIMEFRAMES.every((timeframe) => context.timeframeCloseWatermarks[timeframe])) blockers.push(Object.freeze({
    code: "INCOMPLETE_TIMEFRAME_WATERMARKS",
    reason: "All 1m, 5m, 15m and 1h completed-candle watermarks are required.",
    evidence: context.timeframeCloseWatermarks,
  }));

  const aggregate = weightedScore(components);
  const rawSignedEvidence = aggregate.available ? aggregate.signedEvidence : 0;
  const signedEvidence = blockers.length ? 0 : rawSignedEvidence;
  const directionalThreshold = configuration.directionalThreshold ?? 0.12;
  const direction = blockers.length || Math.abs(signedEvidence) < directionalThreshold
    ? "WAIT"
    : signedEvidence > 0 ? "UP" : "DOWN";
  const technicalUp = blockers.length ? 50 : Math.round(clamp(50 + signedEvidence * 42, 8, 92));
  const technicalDown = 100 - technicalUp;
  const technical = Object.freeze({
    UP: technicalUp,
    DOWN: technicalDown,
    up: technicalUp,
    down: technicalDown,
    upPercent: technicalUp,
    downPercent: technicalDown,
    total: technicalUp + technicalDown,
    classification: "UNCALIBRATED_TECHNICAL_DIRECTION_SCORE_NOT_PROBABILITY",
  });
  const counterfactualInputs = Object.freeze({
    classification: "DETERMINISTIC_COMPONENT_SENSITIVITY_NOT_OUTCOME_FORECAST",
    currentSignedEvidence: signedEvidence,
    rawSignedEvidence,
    directionalThreshold,
    requiredDeltaToUP: Math.max(0, directionalThreshold - signedEvidence),
    requiredDeltaToDOWN: Math.max(0, directionalThreshold + signedEvidence),
    inputs: Object.freeze(components.map((component) => Object.freeze({
      key: component.key,
      currentSignedScore: component.signedScore,
      weight: component.weight,
      available: component.available,
      allowedSignedScoreRange: Object.freeze([-1, 1]),
      maximumPositiveDelta: component.weight * (1 - component.signedScore),
      maximumNegativeDelta: component.weight * (-1 - component.signedScore),
    }))),
  });

  return {
    horizonMinutes: configuration.horizonMinutes,
    direction,
    regime,
    signedEvidence,
    rawSignedEvidence,
    technical,
    components: Object.freeze(components),
    blockers: Object.freeze(blockers),
    counterfactualInputs,
    timeframeCloseWatermarks: Object.freeze({ ...context.timeframeCloseWatermarks }),
    referencePrice: context.referencePrice,
    version: configuration.version,
  };
}
