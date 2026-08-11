const last = (values) => values.at(-1);
const finite = (values) => values.filter(Number.isFinite);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const QUALITY_THRESHOLDS = Object.freeze({ standard: 68, high: 78, exceptional: 88 });
export const STAKE_PROFILES = Object.freeze({ FLAT: "FLAT", ADAPTIVE_CAPPED: "ADAPTIVE_CAPPED", OBSERVED_10_30_90_270: "OBSERVED_10_30_90_270" });
const AUTONOMOUS_STRATEGY = "completed-candle-horizons";
export const AUTONOMOUS_STRATEGY_VERSION = "0.2.0";
const analysisTimeframes = ["1m", "5m", "15m", "1h"];

export function sma(values, period) {
  const sample = finite(values).slice(-period);
  if (period <= 0 || sample.length < period) return null;
  return sample.reduce((sum, value) => sum + value, 0) / period;
}
export function ema(values, period) {
  const sample = finite(values);
  if (period <= 0 || sample.length < period) return null;
  const seed = sample.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  return sample.slice(period).reduce((result, value) => (value - result) * multiplier + result, seed);
}
export function rsi(values, period = 14) {
  const sample = finite(values);
  if (sample.length <= period) return null;
  const changes = sample.slice(1).map((value, index) => value - sample[index]);
  const window = changes.slice(-period);
  const gains = window.reduce((sum, change) => sum + Math.max(0, change), 0) / period;
  const losses = window.reduce((sum, change) => sum + Math.max(0, -change), 0) / period;
  if (losses === 0) return gains === 0 ? 50 : 100;
  return 100 - 100 / (1 + gains / losses);
}
export function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = candles.slice(1).map((candle, index) => {
    const previous = candles[index];
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  });
  return sma(ranges, period);
}
export function bollinger(values, period = 20, deviations = 2) {
  const sample = finite(values).slice(-period);
  const middle = sma(sample, period);
  if (middle === null) return null;
  const variance = sample.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const deviation = Math.sqrt(variance) * deviations;
  return { upper: middle + deviation, middle, lower: middle - deviation };
}
export function calculateIndicators(candles) {
  const closes = candles.map((candle) => candle.close);
  const bands = bollinger(closes);
  const currentVolume = last(candles)?.volume;
  const baseline = sma(candles.slice(-21, -1).map((candle) => candle.volume), 20);
  const zones = candles.slice(-30, -1);
  return {
    rsi14: rsi(closes), ema9: ema(closes, 9), ema21: ema(closes, 21), atr14: atr(candles),
    bollingerUpper: bands?.upper ?? null, bollingerMiddle: bands?.middle ?? null, bollingerLower: bands?.lower ?? null,
    relativeVolume20: currentVolume !== undefined && baseline ? currentVolume / baseline : null,
    support: zones.length ? Math.min(...zones.map((candle) => candle.low)) : null,
    resistance: zones.length ? Math.max(...zones.map((candle) => candle.high)) : null,
  };
}
function timeframeAnalysis(timeframe, candles) {
  const indicators = calculateIndicators(candles);
  if (candles.length < 30 || indicators.ema9 === null || indicators.ema21 === null) {
    return { timeframe, regime: "INSUFFICIENT_DATA", indicators, reasons: ["Minimum 30 validated candles required."] };
  }
  const threshold = (indicators.atr14 ?? 0) * 0.08;
  const separation = Math.abs(indicators.ema9 - indicators.ema21);
  const regime = separation <= threshold ? "RANGE" : indicators.ema9 > indicators.ema21 ? "BULLISH" : "BEARISH";
  return { timeframe, regime, indicators, reasons: [`EMA9 is ${indicators.ema9 > indicators.ema21 ? "above" : "below"} EMA21.`] };
}
export function breakEvenProbability(payoutRate) {
  return Number.isFinite(payoutRate) && payoutRate > 0 ? 1 / (1 + payoutRate) : 1;
}

function qualityBand(score, thresholds) {
  if (score >= thresholds.exceptional) return "EXCEPTIONAL";
  if (score >= thresholds.high) return "HIGH";
  if (score >= thresholds.standard) return "STANDARD";
  return "BELOW_STANDARD";
}
function regimeDirection(analysis) {
  if (analysis.regime === "BULLISH") return 1;
  if (analysis.regime === "BEARISH") return -1;
  return 0;
}
function completedWatermark(candles) {
  const closeTime = candles.at(-1)?.closeTime;
  return Number.isFinite(closeTime) ? new Date(closeTime).toISOString() : null;
}
export function autonomousCandidates(candles, options = {}) {
  const thresholds = { ...QUALITY_THRESHOLDS, ...(options.thresholds ?? {}) };
  const symbol = options.symbol ?? "UNKNOWN";
  const completed = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, (candles[timeframe] ?? []).filter((candle) => candle.closed === true)]));
  const analyses = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, timeframeAnalysis(timeframe, completed[timeframe])]));
  const timeframeCloseWatermarks = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, completedWatermark(completed[timeframe])]));
  const triggerCandles = completed["1m"];
  const current = triggerCandles.at(-1); const previous = triggerCandles.at(-2); const triggerAtr = analyses["1m"].indicators.atr14;
  let trigger = regimeDirection(analyses["1m"]);
  if (current && previous && triggerAtr > 0) trigger = clamp((current.close - previous.close) / triggerAtr, -1, 1);
  const complete = analysisTimeframes.every((timeframe) => completed[timeframe].length >= 30 && timeframeCloseWatermarks[timeframe]);
  const definitions = [
    { horizonMinutes: 10, weights: { trigger: 0.42, "5m": 0.28, "15m": 0.2, "1h": 0.1 }, emphasis: "1m trigger with 5m/15m context" },
    { horizonMinutes: 30, weights: { trigger: 0.15, "5m": 0.2, "15m": 0.3, "1h": 0.35 }, emphasis: "1h/15m structure with 5m confirmation" },
  ];
  return definitions.map(({ horizonMinutes, weights, emphasis }) => {
    const directions = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, regimeDirection(analyses[timeframe])]));
    const signedStrength = trigger * weights.trigger + directions["5m"] * weights["5m"] + directions["15m"] * weights["15m"] + directions["1h"] * weights["1h"];
    const intendedDirection = signedStrength > 0 ? 1 : signedStrength < 0 ? -1 : 0;
    const structuralAlignment = horizonMinutes === 10
      ? directions["5m"] !== 0 && directions["5m"] === directions["15m"] && trigger * directions["5m"] > 0 && (directions["1h"] === 0 || directions["1h"] === directions["5m"])
      : directions["1h"] !== 0 && directions["1h"] === directions["15m"] && (directions["5m"] === 0 || directions["5m"] === directions["1h"]) && trigger * directions["1h"] >= 0;
    const price = current?.close ?? 0; const atrFraction = price > 0 && triggerAtr !== null ? triggerAtr / price : Infinity;
    const volatilityRegime = atrFraction > 0.015 ? "EXTREME" : atrFraction > 0.008 ? "HIGH" : "NORMAL";
    const relativeVolume = analyses["1m"].indicators.relativeVolume20;
    const volumeBonus = relativeVolume !== null && relativeVolume >= 1.3 ? 5 : relativeVolume !== null && relativeVolume >= 1.05 ? 2 : 0;
    const calculatedQuality = Math.round(clamp(50 + Math.abs(signedStrength) * 45 + volumeBonus, 0, 100));
    const qualityScore = complete ? calculatedQuality : 0;
    const band = qualityBand(qualityScore, thresholds);
    const qualified = complete && structuralAlignment && volatilityRegime !== "EXTREME" && qualityScore >= thresholds.standard && intendedDirection !== 0;
    const direction = qualified ? (intendedDirection > 0 ? "UP" : "DOWN") : "WAIT";
    const reasons = complete
      ? [`${horizonMinutes}m emphasizes ${emphasis}.`, `Completed-candle confluence produced setup quality ${qualityScore}/100 (${band}); this is not a calibrated win probability.`, `1m relative volume is ${relativeVolume === null ? "unavailable" : `${relativeVolume.toFixed(2)}x`} and volatility is ${volatilityRegime}.`, !structuralAlignment ? "Required multi-timeframe alignment is absent or contradicted." : volatilityRegime === "EXTREME" ? "Extreme 1m ATR volatility blocks entry." : direction === "WAIT" ? `Quality is below the STANDARD threshold ${thresholds.standard}.` : `${direction} alignment qualifies as ${band}.`]
      : ["All four timeframes require at least 30 completed candles and a close watermark."];
    const watermarkKey = analysisTimeframes.map((timeframe) => `${timeframe}:${timeframeCloseWatermarks[timeframe] ?? "missing"}`).join("|");
    const invalidation = intendedDirection >= 0
      ? analyses["1m"].indicators.support === null ? [] : [`Setup invalid below 1m support ${analyses["1m"].indicators.support.toFixed(2)}.`]
      : analyses["1m"].indicators.resistance === null ? [] : [`Setup invalid above 1m resistance ${analyses["1m"].indicators.resistance.toFixed(2)}.`];
    return {
      decisionKey: `${AUTONOMOUS_STRATEGY_VERSION}:${symbol}:${horizonMinutes}:${watermarkKey}`,
      symbol, horizonMinutes, direction, qualityScore, qualityBand: band, volatilityRegime,
      timeframeCloseWatermarks: { ...timeframeCloseWatermarks }, reasons, invalidation,
      strategyName: AUTONOMOUS_STRATEGY, strategyVersion: AUTONOMOUS_STRATEGY_VERSION,
    };
  });
}

export function analyzeMarket(candles, payoutRate, now = new Date(), options = {}) {
  const completedCandles = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, (candles[timeframe] ?? []).filter((candle) => candle.closed === true)]));
  const timeframes = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, timeframeAnalysis(timeframe, completedCandles[timeframe])]));
  let upEvidence = 50; let downEvidence = 50; const reasons = []; const invalidation = [];
  const applyRegime = (analysis, weight) => {
    if (analysis.regime === "BULLISH") { upEvidence += weight; downEvidence -= weight / 2; reasons.push(`${analysis.timeframe}: bullish structure.`); }
    if (analysis.regime === "BEARISH") { downEvidence += weight; upEvidence -= weight / 2; reasons.push(`${analysis.timeframe}: bearish structure.`); }
  };
  applyRegime(timeframes["1h"], 18); applyRegime(timeframes["15m"], 14); applyRegime(timeframes["5m"], 10);
  const current = completedCandles["1m"].at(-1); const previous = completedCandles["1m"].at(-2); const indicators = timeframes["1m"].indicators;
  if (indicators.rsi14 !== null && indicators.rsi14 >= 75) { downEvidence += 10; reasons.push(`1m RSI ${indicators.rsi14.toFixed(1)} shows extension, not a reversal by itself.`); }
  if (indicators.rsi14 !== null && indicators.rsi14 <= 25) { upEvidence += 10; reasons.push(`1m RSI ${indicators.rsi14.toFixed(1)} shows extension, not a reversal by itself.`); }
  if (current && previous && indicators.atr14 !== null && indicators.atr14 > 0) {
    const normalized = (current.close - previous.close) / indicators.atr14;
    const strongVolume = (indicators.relativeVolume20 ?? 0) >= 1.3;
    if (normalized >= 1.2) { upEvidence += strongVolume ? 12 : 5; reasons.push(`1m upward impulse ${normalized.toFixed(2)} ATR${strongVolume ? " with relative volume" : " without strong volume"}.`); }
    if (normalized <= -1.2) { downEvidence += strongVolume ? 12 : 5; reasons.push(`1m downward impulse ${Math.abs(normalized).toFixed(2)} ATR${strongVolume ? " with relative volume" : " without strong volume"}.`); }
    const body = Math.abs(current.close - current.open);
    if (body > 0 && (current.high - Math.max(current.open, current.close)) / body >= 1.8 && current.close < current.open) { downEvidence += 12; reasons.push("1m upper rejection confirmed by a bearish body."); }
    if (body > 0 && (Math.min(current.open, current.close) - current.low) / body >= 1.8 && current.close > current.open) { upEvidence += 12; reasons.push("1m lower rejection confirmed by a bullish body."); }
  }
  const rawUpScore = Math.round(clamp(upEvidence, 0, 100)); const rawDownScore = Math.round(clamp(downEvidence, 0, 100));
  const difference = rawUpScore - rawDownScore; const breakEven = breakEvenProbability(payoutRate);
  const technicalUpProbability = completedCandles["1m"].length >= 30 ? clamp(0.5 + difference / 200, 0.28, 0.72) : 0.5;
  const technicalDownProbability = 1 - technicalUpProbability;
  const heuristicProbability = completedCandles["1m"].length >= 30 ? Math.max(technicalUpProbability, technicalDownProbability) : null;
  const upScore = Math.round(technicalUpProbability * 100); const downScore = 100 - upScore;
  let direction = "WAIT";
  if (heuristicProbability !== null && heuristicProbability >= breakEven + 0.03 && Math.abs(difference) >= 15) direction = technicalUpProbability > technicalDownProbability ? "UP" : "DOWN";
  if (direction === "WAIT") reasons.push("No sufficient estimated edge over break-even; WAIT.");
  if (indicators.support !== null) invalidation.push(`Bullish scenario invalid below 1m support ${indicators.support.toFixed(2)}.`);
  if (indicators.resistance !== null) invalidation.push(`Bearish scenario invalid above 1m resistance ${indicators.resistance.toFixed(2)}.`);
  const candidates = autonomousCandidates(completedCandles, options);
  return { direction, upScore, downScore, technicalUpProbability, technicalDownProbability, confidence: Math.abs(difference) >= 30 ? "HIGH" : Math.abs(difference) >= 15 ? "MEDIUM" : "LOW", calibrationStatus: "UNCALIBRATED", breakEvenProbability: breakEven, heuristicProbability, reasons, invalidation, timeframes, candidates, classification: "MODEL_ESTIMATE", modelVersion: "rules-v0.2.0", calculatedAt: now.toISOString() };
}
export function adaptiveStake(input) {
  const reasons = []; const breakEven = breakEvenProbability(input.payoutRate);
  const target = Math.max(input.baseStake * input.payoutRate, input.targetProfit);
  const requiredRecoveryStake = Math.ceil(((Math.max(0, input.cumulativeLoss) + target) / input.payoutRate) * 100) / 100;
  const limit = Math.min(input.maxStake, input.bankroll * input.maxBankrollFraction);
  if (!input.dataHealthy) reasons.push("Market data is unavailable or stale.");
  if (input.dailyLoss >= input.dailyLossLimit) reasons.push("Daily loss limit reached.");
  if (input.openPositions >= input.maxOpenPositions) reasons.push("Maximum open positions reached.");
  if (input.volatilityRegime === "EXTREME") reasons.push("Extreme volatility blocks progressive recovery.");
  if (input.correlatedExposureFraction > 0.35) reasons.push("Correlated exposure exceeds 35% of equity.");
  if (requiredRecoveryStake > limit) reasons.push(`Required stake ${requiredRecoveryStake.toFixed(2)} exceeds risk cap ${limit.toFixed(2)}.`);
  let expectedValue = null;
  if (input.estimatedProbability === null) reasons.push("No calibrated probability is available for position sizing.");
  else { expectedValue = input.estimatedProbability * requiredRecoveryStake * input.payoutRate - (1 - input.estimatedProbability) * requiredRecoveryStake; if (input.estimatedProbability <= breakEven || expectedValue <= 0) reasons.push("Estimated edge is not positive after payout."); }
  return { allowed: reasons.length === 0, stake: reasons.length ? null : requiredRecoveryStake, requiredRecoveryStake, expectedValue, breakEvenProbability: breakEven, reasons: reasons.length ? reasons : ["Stake respects configured risk limits."], classification: "CALCULATED" };
}


function centsUp(value) { return Math.ceil((value - Number.EPSILON) * 100) / 100; }
function canonicalProfile(profile) {
  const normalized = String(profile ?? STAKE_PROFILES.ADAPTIVE_CAPPED).trim().toUpperCase();
  if (normalized === "ADAPTIVE") return STAKE_PROFILES.ADAPTIVE_CAPPED;
  if (normalized === "OBSERVED") return STAKE_PROFILES.OBSERVED_10_30_90_270;
  return normalized;
}
export function planAutonomousStake(input) {
  const profile = canonicalProfile(input.profile);
  const thresholds = { ...QUALITY_THRESHOLDS, ...(input.thresholds ?? {}) };
  const observedLadder = input.observedLadder ?? [10, 30, 90, 270];
  const reasons = [];
  const bankroll = input.bankroll;
  const qualityScore = input.candidate?.qualityScore ?? input.qualityScore;
  const direction = input.candidate?.direction ?? input.direction;
  const stage = input.stage ?? 0;
  const payoutRate = input.payoutRate;
  const baseFraction = input.baseFraction ?? 0.005;
  const maxFraction = input.maxFraction ?? 0.02;
  const absoluteCap = input.absoluteCap ?? 25;
  const available = input.available ?? Infinity;
  const exposureHeadroom = input.exposureHeadroom ?? Infinity;
  const dailyLossHeadroom = input.dailyLossHeadroom ?? Infinity;
  const previousLoss = input.previousLoss ?? 0;
  const validProfile = Object.values(STAKE_PROFILES).includes(profile);
  if (!validProfile) reasons.push(`Unknown stake profile ${profile}.`);
  if (!Number.isFinite(bankroll) || bankroll <= 0) reasons.push("Bankroll must be positive.");
  if (!Number.isFinite(payoutRate) || payoutRate <= 0) reasons.push("Payout rate must be positive.");
  if (!Number.isInteger(stage) || stage < 0) reasons.push("Recovery stage must be a nonnegative integer.");
  if (!Number.isFinite(previousLoss) || previousLoss < 0) reasons.push("Previous loss must be nonnegative.");
  if (!Number.isFinite(qualityScore) || qualityScore < 0 || qualityScore > 100) reasons.push("Candidate quality must be between 0 and 100.");
  if (!["UP", "DOWN"].includes(direction) || qualityScore < thresholds.standard) reasons.push("A current STANDARD-or-better setup is required; a previous loss never creates a setup.");
  const multiplier = qualityScore >= thresholds.exceptional ? 2 : qualityScore >= thresholds.high ? 1.5 : 1;
  const baseStake = Number.isFinite(bankroll) ? bankroll * baseFraction : NaN;
  const target = baseStake * multiplier * payoutRate;
  let requestedStake = baseStake * multiplier;
  if (profile === STAKE_PROFILES.ADAPTIVE_CAPPED && stage === 1) requestedStake = (previousLoss + target) / payoutRate;
  if (profile === STAKE_PROFILES.ADAPTIVE_CAPPED && stage > 1) reasons.push("ADAPTIVE_CAPPED permits at most one recovery stage.");
  if (profile === STAKE_PROFILES.OBSERVED_10_30_90_270) {
    if (stage >= observedLadder.length) reasons.push("The observed ladder has no further stage.");
    else requestedStake = observedLadder[stage];
  }
  const hardCap = Math.min(absoluteCap, bankroll * maxFraction, available, exposureHeadroom, dailyLossHeadroom);
  const roundedStake = centsUp(requestedStake);
  if (!Number.isFinite(hardCap) || hardCap < 0) reasons.push("Stake headroom is invalid.");
  if (Number.isFinite(roundedStake) && roundedStake > hardCap) reasons.push(`Exact required stake ${roundedStake.toFixed(2)} exceeds hard cap ${Math.max(0, hardCap).toFixed(2)}; it is blocked, not clamped.`);
  return {
    allowed: reasons.length === 0,
    stake: reasons.length === 0 ? roundedStake : null,
    requestedStake: Number.isFinite(roundedStake) ? roundedStake : null,
    hardCap: Number.isFinite(hardCap) ? Math.max(0, hardCap) : null,
    baseStake: Number.isFinite(baseStake) ? centsUp(baseStake) : null,
    qualityMultiplier: multiplier, profile, stage,
    reasons: reasons.length ? reasons : [`${profile} stake is within every hard cap.`],
    classification: "DETERMINISTIC_RISK_PLAN",
  };
}
