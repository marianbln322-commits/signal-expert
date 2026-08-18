import { clamp, directionSign, normalizeDirection, normalizeSignalContext } from "./signal-features.mjs";

export const REGIME_ENGINE_VERSION = "regime-engine-v0.9.0";
export const EXTENDED_REGIMES = Object.freeze([
  "LOW_LIQUIDITY",
  "ABNORMAL_VOLATILITY",
  "HIGH_VOLATILITY",
  "COMPRESSION",
  "BREAKOUT",
  "STRONG_TREND",
  "WEAK_TREND",
  "RANGE",
]);

export const DEFAULT_REGIME_THRESHOLDS = Object.freeze({
  maxSpreadBps: 8,
  minTopNotional: 10000,
  minBestLevelNotional: 500,
  minRelativeVolume: 0.35,
  abnormalAtrFraction: 0.015,
  abnormalVolatilityPercentile: 0.95,
  abnormalRelativeExpansion: 2.5,
  highAtrFraction: 0.008,
  highVolatilityPercentile: 0.85,
  highRelativeExpansion: 1.5,
  compressionVolatilityPercentile: 0.25,
  compressionRelativeExpansion: 0.75,
  compressionBollingerWidthFraction: 0.006,
  breakoutRelativeVolume: 1.2,
  breakoutAtrDisplacement: 0.35,
  strongTrendMinimumAligned: 3,
  strongTrendMinimumStrength: 0.62,
  weakTrendMinimumAligned: 2,
  weakTrendMinimumStrength: 0.28,
});

function finite(...values) {
  return values.find(Number.isFinite) ?? null;
}

function boolean(value) {
  return value === true ? true : value === false ? false : null;
}

function thresholdSet(source) {
  const overrides = source?.regimeThresholds ?? source?.thresholds?.regime ?? source?.thresholds ?? {};
  return Object.freeze(Object.fromEntries(Object.entries(DEFAULT_REGIME_THRESHOLDS).map(([key, fallback]) => [
    key,
    Number.isFinite(overrides[key]) ? overrides[key] : fallback,
  ])));
}

function volatilityMetrics(context) {
  const oneMinute = context.indicators["1m"] ?? {};
  const candles = context.candles["1m"] ?? [];
  const atrFraction = finite(context.atrFraction, context.source.marketRegime?.atrFraction);
  const volatilityPercentile = finite(context.source.volatilityPercentile, context.source.marketRegime?.volatilityPercentile);
  let relativeExpansion = finite(context.source.relativeExpansion, context.source.marketRegime?.relativeExpansion);
  if (relativeExpansion === null && candles.length >= 20) {
    const ranges = candles.slice(-20).map((candle) => candle.close > 0 ? (candle.high - candle.low) / candle.close : null).filter(Number.isFinite);
    const currentRange = ranges.at(-1);
    const sorted = [...ranges.slice(0, -1)].sort((left, right) => left - right);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    relativeExpansion = Number.isFinite(currentRange) && median > 0 ? currentRange / median : null;
  }
  const bollingerWidthFraction = Number.isFinite(oneMinute.bollingerUpper) && Number.isFinite(oneMinute.bollingerLower) && context.referencePrice > 0
    ? (oneMinute.bollingerUpper - oneMinute.bollingerLower) / context.referencePrice
    : finite(context.source.bollingerWidthFraction);
  return { atrFraction, volatilityPercentile, relativeExpansion, bollingerWidthFraction };
}

function liquidityMetrics(context) {
  const metrics = context.orderBookMetrics ?? {};
  const relativeVolume = finite(
    context.indicators["1m"]?.relativeVolume20,
    context.technicalFeatures?.relativeVolume20,
    context.source.relativeVolume20,
  );
  return {
    valid: boolean(metrics.valid),
    spreadBps: finite(metrics.spreadBps),
    topNotional: finite(metrics.topNotional),
    bestLevelNotional: finite(metrics.bestLevelNotional),
    relativeVolume,
  };
}

function breakoutMetrics(context, thresholds) {
  const latest = context.candles["1m"]?.at(-1);
  const previous = context.candles["1m"]?.at(-2);
  const indicators = context.indicators["1m"] ?? {};
  const atrValue = finite(indicators.atr14);
  const support = finite(context.source.levels?.support?.price, indicators.support);
  const resistance = finite(context.source.levels?.resistance?.price, indicators.resistance);
  const explicitDirection = normalizeDirection(context.source.breakout?.direction ?? context.source.breakoutDirection);
  const close = finite(latest?.close, context.referencePrice);
  const previousClose = finite(previous?.close);
  const upwardBreak = close !== null && resistance !== null && close > resistance && (previousClose === null || previousClose <= resistance);
  const downwardBreak = close !== null && support !== null && close < support && (previousClose === null || previousClose >= support);
  const direction = explicitDirection !== "NEUTRAL" ? explicitDirection : upwardBreak ? "UP" : downwardBreak ? "DOWN" : "NEUTRAL";
  const brokenLevel = direction === "UP" ? resistance : direction === "DOWN" ? support : null;
  const atrDisplacement = close !== null && brokenLevel !== null && atrValue > 0 ? Math.abs(close - brokenLevel) / atrValue : null;
  const relativeVolume = finite(context.indicators["1m"]?.relativeVolume20, context.source.relativeVolume20);
  const structureShift = ["5m", "15m"].some((timeframe) => {
    const shift = context.structureFeatures[timeframe]?.structureEvidence?.latestShift;
    return normalizeDirection(shift?.direction) === direction;
  });
  const confirmed = direction !== "NEUTRAL"
    && (context.source.breakout?.confirmed === true
      || structureShift
      || ((relativeVolume ?? 0) >= thresholds.breakoutRelativeVolume && (atrDisplacement ?? 0) >= thresholds.breakoutAtrDisplacement));
  return { direction, confirmed, brokenLevel, atrDisplacement, relativeVolume, structureShift };
}

function trendMetrics(context) {
  const featureEntries = [
    ["5m", context.features.fiveMinute],
    ["15m", context.features.fifteenMinute],
    ["1h", context.features.oneHour],
  ].filter(([, feature]) => feature?.available === true);
  const scores = featureEntries.map(([, feature]) => feature.signedScore).filter(Number.isFinite);
  const net = scores.reduce((sum, score) => sum + score, 0);
  const direction = net > 0 ? "UP" : net < 0 ? "DOWN" : "NEUTRAL";
  const sign = directionSign(direction);
  const aligned = featureEntries.filter(([, feature]) => Math.sign(feature.signedScore) === sign && Math.abs(feature.signedScore) >= 0.1);
  const opposing = featureEntries.filter(([, feature]) => Math.sign(feature.signedScore) === -sign && Math.abs(feature.signedScore) >= 0.1);
  const averageStrength = aligned.length ? aligned.reduce((sum, [, feature]) => sum + Math.abs(feature.signedScore), 0) / aligned.length : 0;
  const emaStrengths = ["5m", "15m", "1h"].map((timeframe) => {
    const indicators = context.indicators[timeframe] ?? {};
    if (!Number.isFinite(indicators.ema9) || !Number.isFinite(indicators.ema21) || !(indicators.atr14 > 0)) return null;
    return clamp(Math.abs(indicators.ema9 - indicators.ema21) / indicators.atr14, 0, 1);
  }).filter(Number.isFinite);
  const emaStrength = emaStrengths.length ? emaStrengths.reduce((sum, value) => sum + value, 0) / emaStrengths.length : null;
  return {
    direction,
    alignedTimeframes: aligned.map(([timeframe]) => timeframe),
    opposingTimeframes: opposing.map(([timeframe]) => timeframe),
    alignedCount: aligned.length,
    availableCount: featureEntries.length,
    averageStrength: emaStrength === null ? averageStrength : (averageStrength + emaStrength) / 2,
  };
}

function result(regime, failClosed, evidence, thresholds) {
  return Object.freeze({
    regime,
    classification: regime,
    direction: evidence.trend.direction,
    evidence: Object.freeze(evidence),
    thresholds,
    version: REGIME_ENGINE_VERSION,
    failClosed,
  });
}

export function classifyExtendedRegime(input = {}) {
  const context = normalizeSignalContext(input);
  const thresholds = thresholdSet(context.source);
  const volatility = volatilityMetrics(context);
  const liquidity = liquidityMetrics(context);
  const breakout = breakoutMetrics(context, thresholds);
  const trend = trendMetrics(context);
  const missingInputs = [];
  if (!(context.referencePrice > 0)) missingInputs.push("referencePrice");
  if (volatility.atrFraction === null) missingInputs.push("atrFraction");
  const missingLiquidityFields = [];
  if (liquidity.valid !== true) missingLiquidityFields.push("synchronizedBookValid");
  if (liquidity.spreadBps === null) missingLiquidityFields.push("spreadBps");
  if (liquidity.topNotional === null) missingLiquidityFields.push("topNotional");
  if (liquidity.bestLevelNotional === null) missingLiquidityFields.push("bestLevelNotional");
  if (missingLiquidityFields.length) missingInputs.push("liquidity");
  if (trend.availableCount < 2) missingInputs.push("multiTimeframeTrend");

  const lowLiquidityReasons = [];
  if (liquidity.valid === false) lowLiquidityReasons.push("order_book_invalid");
  if (liquidity.spreadBps !== null && liquidity.spreadBps > thresholds.maxSpreadBps) lowLiquidityReasons.push("spread_above_limit");
  if (liquidity.topNotional !== null && liquidity.topNotional < thresholds.minTopNotional) lowLiquidityReasons.push("top_notional_below_minimum");
  if (liquidity.bestLevelNotional !== null && liquidity.bestLevelNotional < thresholds.minBestLevelNotional) lowLiquidityReasons.push("best_level_notional_below_minimum");
  if (liquidity.relativeVolume !== null && liquidity.relativeVolume < thresholds.minRelativeVolume) lowLiquidityReasons.push("relative_volume_below_minimum");

  const abnormalVolatility = (volatility.atrFraction ?? -Infinity) >= thresholds.abnormalAtrFraction
    || ((volatility.volatilityPercentile ?? -Infinity) >= thresholds.abnormalVolatilityPercentile
      && (volatility.relativeExpansion ?? -Infinity) >= thresholds.abnormalRelativeExpansion);
  const highVolatility = (volatility.atrFraction ?? -Infinity) >= thresholds.highAtrFraction
    || ((volatility.volatilityPercentile ?? -Infinity) >= thresholds.highVolatilityPercentile
      && (volatility.relativeExpansion ?? -Infinity) >= thresholds.highRelativeExpansion);
  const compression = (volatility.volatilityPercentile !== null && volatility.volatilityPercentile <= thresholds.compressionVolatilityPercentile)
    || (volatility.relativeExpansion !== null && volatility.relativeExpansion <= thresholds.compressionRelativeExpansion)
    || (volatility.bollingerWidthFraction !== null && volatility.bollingerWidthFraction <= thresholds.compressionBollingerWidthFraction);
  const strongTrend = trend.alignedCount >= thresholds.strongTrendMinimumAligned
    && trend.opposingTimeframes.length === 0
    && trend.averageStrength >= thresholds.strongTrendMinimumStrength;
  const weakTrend = trend.alignedCount >= thresholds.weakTrendMinimumAligned
    && trend.averageStrength >= thresholds.weakTrendMinimumStrength;

  const checks = Object.freeze({
    lowLiquidity: lowLiquidityReasons.length > 0,
    abnormalVolatility,
    highVolatility,
    compression,
    breakout: breakout.confirmed,
    strongTrend,
    weakTrend,
  });
  const evidence = {
    liquidity: Object.freeze({ ...liquidity, missingCriticalFields: Object.freeze(missingLiquidityFields), reasons: Object.freeze(lowLiquidityReasons) }),
    volatility: Object.freeze(volatility),
    breakout: Object.freeze(breakout),
    trend: Object.freeze(trend),
    checks,
    missingInputs: Object.freeze(missingInputs),
  };

  if (missingInputs.length) return result("LOW_LIQUIDITY", true, evidence, thresholds);
  if (checks.lowLiquidity) return result("LOW_LIQUIDITY", true, evidence, thresholds);
  if (abnormalVolatility) return result("ABNORMAL_VOLATILITY", true, evidence, thresholds);
  if (highVolatility) return result("HIGH_VOLATILITY", false, evidence, thresholds);
  if (breakout.confirmed) return result("BREAKOUT", false, evidence, thresholds);
  if (compression) return result("COMPRESSION", false, evidence, thresholds);
  if (strongTrend) return result("STRONG_TREND", false, evidence, thresholds);
  if (weakTrend) return result("WEAK_TREND", false, evidence, thresholds);
  return result("RANGE", false, evidence, thresholds);
}
