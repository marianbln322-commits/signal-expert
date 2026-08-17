const last = (values) => values.at(-1);
const finite = (values) => values.filter(Number.isFinite);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const QUALITY_THRESHOLDS = Object.freeze({ standard: 68, high: 78, exceptional: 88 });
export const STAKE_PROFILES = Object.freeze({ FLAT: "FLAT", ADAPTIVE_CAPPED: "ADAPTIVE_CAPPED", OBSERVED_10_30_90_270: "OBSERVED_10_30_90_270" });
const AUTONOMOUS_STRATEGY = "completed-candle-mtf-entry-gates";
export const AUTONOMOUS_STRATEGY_VERSION = "0.6.0";
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
    rsi14: rsi(closes), ema9: ema(closes, 9), ema20: ema(closes, 20), ema21: ema(closes, 21), ema50: ema(closes, 50), atr14: atr(candles),
    bollingerUpper: bands?.upper ?? null, bollingerMiddle: bands?.middle ?? null, bollingerLower: bands?.lower ?? null,
    relativeVolume20: currentVolume !== undefined && baseline ? currentVolume / baseline : null,
    support: zones.length ? Math.min(...zones.map((candle) => candle.low)) : null,
    resistance: zones.length ? Math.max(...zones.map((candle) => candle.high)) : null,
  };
}

const STRUCTURE_PIVOT_SPAN = 2;
const STRUCTURE_LOOKBACK = 80;
const RECENT_EVENT_BARS = 6;
const FVG_ACTIVE_BARS = 30;

function latestByIndex(items, indexKey = "index") {
  return items.reduce((latest, item) => !latest || item[indexKey] > latest[indexKey] ? item : latest, null);
}
function eventAge(candles, event, indexKey = "index") {
  return event ? candles.length - 1 - event[indexKey] : null;
}
function confirmedSwings(candles) {
  const swings = [];
  const start = Math.max(STRUCTURE_PIVOT_SPAN, candles.length - STRUCTURE_LOOKBACK);
  for (let index = start; index < candles.length - STRUCTURE_PIVOT_SPAN; index += 1) {
    const candle = candles[index];
    const neighbors = candles.slice(index - STRUCTURE_PIVOT_SPAN, index + STRUCTURE_PIVOT_SPAN + 1).filter((_, offset) => offset !== STRUCTURE_PIVOT_SPAN);
    const confirmedIndex = index + STRUCTURE_PIVOT_SPAN;
    if (neighbors.every((item) => candle.high > item.high)) swings.push({ type: "HIGH", price: candle.high, index, occurredAt: new Date(candle.closeTime).toISOString(), confirmedIndex, confirmedAt: new Date(candles[confirmedIndex].closeTime).toISOString() });
    if (neighbors.every((item) => candle.low < item.low)) swings.push({ type: "LOW", price: candle.low, index, occurredAt: new Date(candle.closeTime).toISOString(), confirmedIndex, confirmedAt: new Date(candles[confirmedIndex].closeTime).toISOString() });
  }
  return swings;
}
function structureBias(availableSwings) {
  const highs = availableSwings.filter((swing) => swing.type === "HIGH").slice(-2);
  const lows = availableSwings.filter((swing) => swing.type === "LOW").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "NEUTRAL";
  if (highs[1].price > highs[0].price && lows[1].price > lows[0].price) return "UP";
  if (highs[1].price < highs[0].price && lows[1].price < lows[0].price) return "DOWN";
  return "NEUTRAL";
}
function fairValueGaps(candles) {
  const gaps = [];
  const start = Math.max(2, candles.length - STRUCTURE_LOOKBACK);
  for (let index = start; index < candles.length; index += 1) {
    const first = candles[index - 2]; const third = candles[index];
    let gap = null;
    if (third.low > first.high) gap = { direction: "UP", lower: first.high, upper: third.low };
    if (third.high < first.low) gap = { direction: "DOWN", lower: third.high, upper: first.low };
    if (!gap) continue;
    const feature = { ...gap, index, createdAt: new Date(third.closeTime).toISOString(), retestIndex: null, retestedAt: null, inversionIndex: null, invertedAt: null, inversionDirection: null };
    for (let cursor = index + 1; cursor < candles.length; cursor += 1) {
      const candle = candles[cursor];
      const inverted = gap.direction === "UP" ? candle.close < gap.lower : candle.close > gap.upper;
      if (inverted) {
        feature.inversionIndex = cursor; feature.invertedAt = new Date(candle.closeTime).toISOString(); feature.inversionDirection = gap.direction === "UP" ? "DOWN" : "UP";
        break;
      }
      const touched = candle.low <= gap.upper && candle.high >= gap.lower;
      if (touched && feature.retestIndex === null) { feature.retestIndex = cursor; feature.retestedAt = new Date(candle.closeTime).toISOString(); }
    }
    feature.status = feature.inversionIndex !== null ? "INVERTED" : feature.retestIndex !== null ? "RETESTED" : "ACTIVE";
    gaps.push(feature);
  }
  return gaps;
}
function structureEvents(candles, swings) {
  const sweeps = []; const shifts = []; const consumed = new Set();
  const swingKey = (swing) => `${swing.type}:${swing.index}`;
  const start = Math.max(1, candles.length - STRUCTURE_LOOKBACK);
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index]; const previous = candles[index - 1];
    const available = swings.filter((swing) => swing.confirmedIndex < index);
    const active = available.filter((swing) => !consumed.has(swingKey(swing)));
    const biasBeforeBreak = structureBias(available);
    const terminalEvents = [];
    for (const swing of active) {
      if (swing.type === "LOW" && candle.close < swing.price) terminalEvents.push({ type: "SHIFT", swing, direction: "DOWN" });
      else if (swing.type === "LOW" && candle.low < swing.price && candle.close > swing.price) terminalEvents.push({ type: "SWEEP", swing, direction: "UP" });
      if (swing.type === "HIGH" && candle.close > swing.price) terminalEvents.push({ type: "SHIFT", swing, direction: "UP" });
      else if (swing.type === "HIGH" && candle.high > swing.price && candle.close < swing.price) terminalEvents.push({ type: "SWEEP", swing, direction: "DOWN" });
    }
    terminalEvents.sort((left, right) => right.swing.index - left.swing.index);
    for (const event of terminalEvents) {
      consumed.add(swingKey(event.swing));
      if (event.type === "SWEEP") {
        sweeps.push({ direction: event.direction, index, level: event.swing.price, swingIndex: event.swing.index, sweptSwingAt: event.swing.occurredAt, occurredAt: new Date(candle.closeTime).toISOString() });
      } else if ((event.direction === "UP" && previous.close <= event.swing.price) || (event.direction === "DOWN" && previous.close >= event.swing.price)) {
        shifts.push({ direction: event.direction, index, level: event.swing.price, swingIndex: event.swing.index, kind: biasBeforeBreak === (event.direction === "UP" ? "DOWN" : "UP") ? "CHOCH" : "MSS", priorBias: biasBeforeBreak, occurredAt: new Date(candle.closeTime).toISOString() });
      }
    }
  }
  return { sweeps, shifts, activeSwings: swings.filter((swing) => !consumed.has(swingKey(swing))) };
}
function marketStructure(timeframe, candles) {
  const indicators = calculateIndicators(candles); const current = candles.at(-1);
  if (!current || candles.length < 50 || indicators.ema20 === null || indicators.ema50 === null) {
    return { timeframe, status: "INSUFFICIENT_DATA", structureDirection: "NEUTRAL", structureEvidence: { swingDirection: "NEUTRAL", latestShift: null }, definitions: { pivotSpan: STRUCTURE_PIVOT_SPAN, recentEventBars: RECENT_EVENT_BARS, fvgActiveBars: FVG_ACTIVE_BARS }, latestSwingHigh: null, latestSwingLow: null, recentFvgs: { bullish: null, bearish: null }, fvgRetests: { bullish: null, bearish: null }, invertedFvgs: { bullish: null, bearish: null }, liquiditySweeps: { bullish: null, bearish: null }, marketStructureShifts: { bullish: null, bearish: null }, emaContext: { ema20: indicators.ema20, ema50: indicators.ema50, close: current?.close ?? null, direction: "NEUTRAL", dynamicContext: "UNAVAILABLE" } };
  }
  const swings = confirmedSwings(candles); const gaps = fairValueGaps(candles); const { sweeps, shifts, activeSwings } = structureEvents(candles, swings);
  const latestGap = (direction) => latestByIndex(gaps.filter((gap) => gap.direction === direction && gap.inversionIndex === null && eventAge(candles, gap) <= FVG_ACTIVE_BARS));
  const latestRetest = (direction) => latestByIndex(gaps.filter((gap) => gap.direction === direction && gap.retestIndex !== null && gap.inversionIndex === null && eventAge(candles, gap, "retestIndex") <= RECENT_EVENT_BARS), "retestIndex");
  const latestInversion = (direction) => latestByIndex(gaps.filter((gap) => gap.inversionDirection === direction && eventAge(candles, gap, "inversionIndex") <= FVG_ACTIVE_BARS), "inversionIndex");
  const latestEvent = (items, direction) => latestByIndex(items.filter((item) => item.direction === direction && eventAge(candles, item) <= RECENT_EVENT_BARS));
  const emaDirection = indicators.ema20 > indicators.ema50 && current.close > indicators.ema20 ? "UP" : indicators.ema20 < indicators.ema50 && current.close < indicators.ema20 ? "DOWN" : "NEUTRAL";
  const touchingEma20 = current.low <= indicators.ema20 && current.high >= indicators.ema20;
  const swingDirection = structureBias(swings);
  const latestBullishShift = latestEvent(shifts, "UP"); const latestBearishShift = latestEvent(shifts, "DOWN");
  const latestShift = !latestBullishShift ? latestBearishShift : !latestBearishShift ? latestBullishShift : latestBullishShift.index >= latestBearishShift.index ? latestBullishShift : latestBearishShift;
  const structureDirection = latestShift && latestShift.direction !== emaDirection
    ? "NEUTRAL"
    : swingDirection !== "NEUTRAL" ? (swingDirection === emaDirection ? swingDirection : "NEUTRAL") : emaDirection;
  return {
    timeframe, status: "READY", structureDirection, structureEvidence: { swingDirection, latestShift, emaDirection }, definitions: { pivotSpan: STRUCTURE_PIVOT_SPAN, recentEventBars: RECENT_EVENT_BARS, fvgActiveBars: FVG_ACTIVE_BARS },
    latestSwingHigh: latestByIndex(activeSwings.filter((swing) => swing.type === "HIGH")), latestSwingLow: latestByIndex(activeSwings.filter((swing) => swing.type === "LOW")),
    recentFvgs: { bullish: latestGap("UP"), bearish: latestGap("DOWN") },
    fvgRetests: { bullish: latestRetest("UP"), bearish: latestRetest("DOWN") },
    invertedFvgs: { bullish: latestInversion("UP"), bearish: latestInversion("DOWN") },
    liquiditySweeps: { bullish: latestEvent(sweeps, "UP"), bearish: latestEvent(sweeps, "DOWN") },
    marketStructureShifts: { bullish: latestEvent(shifts, "UP"), bearish: latestEvent(shifts, "DOWN") },
    emaContext: { ema20: indicators.ema20, ema50: indicators.ema50, close: current.close, direction: emaDirection, dynamicContext: touchingEma20 ? "PRICE_TOUCHING_EMA20" : current.close > indicators.ema20 ? "PRICE_ABOVE_EMA20" : "PRICE_BELOW_EMA20" },
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
export function detectOneMinuteTrigger(candles, indicators = calculateIndicators(candles)) {
  const current = candles.at(-1); const previous = candles.at(-2);
  if (!current || !previous || current.closed !== true || indicators.atr14 === null || indicators.atr14 <= 0) return { direction: "NEUTRAL", strength: 0, closed: current?.closed === true, candleCloseTime: Number.isFinite(current?.closeTime) ? new Date(current.closeTime).toISOString() : null, patterns: [], evidence: { reason: "Two completed 1m candles and ATR14 are required." } };
  const range = current.high - current.low; const body = Math.abs(current.close - current.open);
  if (!(range > 0)) return { direction: "NEUTRAL", strength: 0, closed: true, candleCloseTime: new Date(current.closeTime).toISOString(), patterns: [], evidence: { reason: "Latest completed 1m candle has zero range." } };
  const bullishBody = current.close > current.open; const bearishBody = current.close < current.open;
  const upperWick = current.high - Math.max(current.open, current.close); const lowerWick = Math.min(current.open, current.close) - current.low;
  const closeLocation = (current.close - current.low) / range;
  const normalizedImpulse = (current.close - previous.close) / indicators.atr14;
  const relativeVolume = indicators.relativeVolume20 ?? 0;
  const patterns = [];
  const add = (name, direction, weight, evidence) => patterns.push({ name, direction, weight, evidence });
  if (bullishBody && previous.close < previous.open && current.open <= previous.close && current.close >= previous.open) add("BULLISH_ENGULFING", "UP", 3, "Current body fully engulfs the previous bearish body.");
  if (bearishBody && previous.close > previous.open && current.open >= previous.close && current.close <= previous.open) add("BEARISH_ENGULFING", "DOWN", 3, "Current body fully engulfs the previous bullish body.");
  if (bullishBody && body > 0 && lowerWick / body >= 1.8 && closeLocation >= 0.65) add("LOWER_REJECTION", "UP", 2, "Lower wick is at least 1.8x the bullish body and the close is in the upper candle range.");
  if (bearishBody && body > 0 && upperWick / body >= 1.8 && closeLocation <= 0.35) add("UPPER_REJECTION", "DOWN", 2, "Upper wick is at least 1.8x the bearish body and the close is in the lower candle range.");
  if (normalizedImpulse >= 0.55 && relativeVolume >= 1) add("ATR_VOLUME_IMPULSE", "UP", normalizedImpulse >= 1 ? 3 : 2, `${normalizedImpulse.toFixed(2)} ATR upward close impulse with ${relativeVolume.toFixed(2)}x relative volume.`);
  if (normalizedImpulse <= -0.55 && relativeVolume >= 1) add("ATR_VOLUME_IMPULSE", "DOWN", normalizedImpulse <= -1 ? 3 : 2, `${Math.abs(normalizedImpulse).toFixed(2)} ATR downward close impulse with ${relativeVolume.toFixed(2)}x relative volume.`);
  if (bullishBody && body / range >= 0.45 && closeLocation >= 0.7 && indicators.ema9 > indicators.ema21 && current.close > indicators.ema9) add("TREND_CONTINUATION_CLOSE", "UP", 1, "Bullish body closes near its high above aligned EMA9/EMA21.");
  if (bearishBody && body / range >= 0.45 && closeLocation <= 0.3 && indicators.ema9 < indicators.ema21 && current.close < indicators.ema9) add("TREND_CONTINUATION_CLOSE", "DOWN", 1, "Bearish body closes near its low below aligned EMA9/EMA21.");
  const upWeight = patterns.filter((pattern) => pattern.direction === "UP").reduce((sum, pattern) => sum + pattern.weight, 0);
  const downWeight = patterns.filter((pattern) => pattern.direction === "DOWN").reduce((sum, pattern) => sum + pattern.weight, 0);
  const direction = upWeight >= 2 && upWeight > downWeight ? "UP" : downWeight >= 2 && downWeight > upWeight ? "DOWN" : "NEUTRAL";
  return {
    direction,
    strength: direction === "NEUTRAL" ? 0 : clamp(Math.abs(upWeight - downWeight) / 6, 0.25, 1),
    closed: true,
    candleCloseTime: new Date(current.closeTime).toISOString(),
    patterns,
    evidence: { open: current.open, high: current.high, low: current.low, close: current.close, bodyToRange: body / range, closeLocation, normalizedImpulse, relativeVolume, rsi14: indicators.rsi14, bollingerPosition: indicators.bollingerUpper === null || indicators.bollingerLower === null ? null : (current.close - indicators.bollingerLower) / Math.max(indicators.bollingerUpper - indicators.bollingerLower, Number.EPSILON) },
  };
}

export function generateSignals(candles, options = {}) {
  const thresholds = { ...QUALITY_THRESHOLDS, ...(options.thresholds ?? {}) };
  const symbol = options.symbol ?? "UNKNOWN";
  const completed = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, (candles[timeframe] ?? []).filter((candle) => candle.closed === true)]));
  const analyses = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, timeframeAnalysis(timeframe, completed[timeframe])]));
  const structureFeatures = Object.fromEntries(["5m", "15m", "1h"].map((timeframe) => [timeframe, marketStructure(timeframe, completed[timeframe])]));
  const timeframeCloseWatermarks = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, completedWatermark(completed[timeframe])]));
  const triggerCandles = completed["1m"];
  const current = triggerCandles.at(-1);
  const oneMinuteTrigger = detectOneMinuteTrigger(triggerCandles, analyses["1m"].indicators);
  const trigger = oneMinuteTrigger.direction === "UP" ? oneMinuteTrigger.strength : oneMinuteTrigger.direction === "DOWN" ? -oneMinuteTrigger.strength : 0;
  const triggerCloseMs = Number.isFinite(current?.closeTime) ? current.closeTime : null;
  const triggerValidUntil = triggerCloseMs === null ? null : new Date(triggerCloseMs + (options.triggerGraceMs ?? 90000)).toISOString();
  const fiveMinuteDirection = structureFeatures["5m"].structureDirection ?? "NEUTRAL";
  const complete = analysisTimeframes.every((timeframe) => completed[timeframe].length >= 50 && timeframeCloseWatermarks[timeframe]);
  const definitions = [
    { horizonMinutes: 10, weights: { trigger: 0.42, "5m": 0.28, "15m": 0.2, "1h": 0.1 }, emphasis: "1m trigger with 5m/15m context", invalidationTimeframe: "5m" },
    { horizonMinutes: 30, weights: { trigger: 0.15, "5m": 0.2, "15m": 0.3, "1h": 0.35 }, emphasis: "1h/15m structure with 5m confirmation", invalidationTimeframe: "15m" },
  ];
  return definitions.map(({ horizonMinutes, weights, emphasis, invalidationTimeframe }) => {
    const directions = Object.fromEntries(analysisTimeframes.map((timeframe) => [timeframe, regimeDirection(analyses[timeframe])]));
    const signedStrength = trigger * weights.trigger + directions["5m"] * weights["5m"] + directions["15m"] * weights["15m"] + directions["1h"] * weights["1h"];
    const intendedDirection = signedStrength > 0 ? 1 : signedStrength < 0 ? -1 : 0;
    const intendedLabel = intendedDirection > 0 ? "UP" : intendedDirection < 0 ? "DOWN" : "NEUTRAL";
    const structuralAlignment = horizonMinutes === 10
      ? oneMinuteTrigger.direction === intendedLabel && fiveMinuteDirection === intendedLabel && directions["5m"] === intendedDirection && directions["15m"] === intendedDirection && (directions["1h"] === 0 || directions["1h"] === intendedDirection)
      : oneMinuteTrigger.direction === intendedLabel && fiveMinuteDirection === intendedLabel && directions["1h"] === intendedDirection && directions["15m"] === intendedDirection && (directions["5m"] === 0 || directions["5m"] === intendedDirection);
    const confluenceComponents = [];
    const addComponent = (key, label, timeframe, direction, active, weight, details) => confluenceComponents.push({ key, label, timeframe, direction, active, weight, details });
    for (const timeframe of ["5m", "15m", "1h"]) {
      const feature = structureFeatures[timeframe]; const factor = timeframe === "15m" ? 1.25 : timeframe === "1h" ? 1 : 0.9;
      addComponent(`ema20_50_${timeframe}`, "EMA20/EMA50 trend and dynamic price context", timeframe, feature.emaContext.direction, feature.status === "READY" && feature.emaContext.direction !== "NEUTRAL", Math.round(4 * factor), { objective: "Active when EMA20 is on the directional side of EMA50 and the completed close is on the same side of EMA20.", ...feature.emaContext });
      if (timeframe === "1h") continue;
      const directionalFeature = (group, indexKey = "index") => {
        const bullish = group.bullish; const bearish = group.bearish;
        if (!bullish) return bearish;
        if (!bearish) return bullish;
        return bullish[indexKey] >= bearish[indexKey] ? bullish : bearish;
      };
      const gap = directionalFeature(feature.recentFvgs);
      addComponent(`recent_fvg_${timeframe}`, "Recent unviolated fair-value gap", timeframe, gap?.direction ?? "NEUTRAL", Boolean(gap && gap.status !== "INVERTED"), Math.round(3 * factor), { objective: "Three-candle imbalance: bullish when candle three low is above candle one high; bearish when candle three high is below candle one low. Active for 30 completed bars unless closed through.", zone: gap ? { lower: gap.lower, upper: gap.upper } : null, status: gap?.status ?? "NONE", createdAt: gap?.createdAt ?? null });
      const retest = directionalFeature(feature.fvgRetests, "retestIndex");
      addComponent(`fvg_retest_${timeframe}`, "Recent FVG retest", timeframe, retest?.direction ?? "NEUTRAL", Boolean(retest), Math.round(4 * factor), { objective: "A later completed candle overlaps an unviolated FVG zone; event remains recent for six completed bars.", zone: retest ? { lower: retest.lower, upper: retest.upper } : null, retestedAt: retest?.retestedAt ?? null });
      const inversion = directionalFeature(feature.invertedFvgs, "inversionIndex");
      addComponent(`ifvg_${timeframe}`, "Inverted fair-value gap (IFVG)", timeframe, inversion?.inversionDirection ?? "NEUTRAL", Boolean(inversion), Math.round(5 * factor), { objective: "A completed close crosses the far boundary of an earlier FVG, reversing that zone's direction.", originalDirection: inversion?.direction ?? null, zone: inversion ? { lower: inversion.lower, upper: inversion.upper } : null, invertedAt: inversion?.invertedAt ?? null });
      const sweep = directionalFeature(feature.liquiditySweeps);
      addComponent(`liquidity_sweep_${timeframe}`, "Confirmed swing liquidity sweep", timeframe, sweep?.direction ?? "NEUTRAL", Boolean(sweep), Math.round(5 * factor), { objective: "Bullish: low trades below a previously confirmed swing low and closes back above it; bearish is the inverse. Event remains recent for six completed bars.", level: sweep?.level ?? null, occurredAt: sweep?.occurredAt ?? null });
      const shift = directionalFeature(feature.marketStructureShifts);
      addComponent(`market_structure_shift_${timeframe}`, "CHoCH / market-structure shift", timeframe, shift?.direction ?? "NEUTRAL", Boolean(shift), Math.round(7 * factor), { objective: "A completed close crosses a previously confirmed swing after the prior completed close remained on the other side. Opposing prior swing bias labels CHOCH; otherwise MSS.", kind: shift?.kind ?? null, level: shift?.level ?? null, priorBias: shift?.priorBias ?? null, occurredAt: shift?.occurredAt ?? null });
    }
    const alignedStructureWeight = confluenceComponents.filter((item) => item.active && item.direction === intendedLabel).reduce((sum, item) => sum + item.weight, 0);
    const opposingStructureWeight = confluenceComponents.filter((item) => item.active && item.direction !== "NEUTRAL" && item.direction !== intendedLabel).reduce((sum, item) => sum + item.weight, 0);
    const structureAdjustment = intendedDirection === 0 ? 0 : Math.round(clamp((alignedStructureWeight - opposingStructureWeight) * 0.4, -8, 8));
    const structureContradicted = confluenceComponents.some((item) => item.active && item.key === "market_structure_shift_15m" && item.direction !== intendedLabel);
    const price = current?.close ?? 0; const triggerAtr = analyses["1m"].indicators.atr14; const atrFraction = price > 0 && triggerAtr !== null ? triggerAtr / price : Infinity;
    const volatilityRegime = atrFraction > 0.015 ? "EXTREME" : atrFraction > 0.008 ? "HIGH" : "NORMAL";
    const relativeVolume = analyses["1m"].indicators.relativeVolume20;
    const volumeBonus = relativeVolume !== null && relativeVolume >= 1.3 ? 4 : relativeVolume !== null && relativeVolume >= 1.05 ? 2 : 0;
    const patternBonus = oneMinuteTrigger.patterns.reduce((sum, pattern) => sum + pattern.weight, 0) >= 4 ? 4 : oneMinuteTrigger.patterns.length ? 2 : 0;
    const baseQuality = 50 + Math.abs(signedStrength) * 38 + volumeBonus + patternBonus;
    const calculatedQuality = Math.round(clamp(baseQuality + structureAdjustment, 0, 100));
    const qualityScore = complete ? calculatedQuality : 0;
    const band = qualityBand(qualityScore, thresholds);
    const qualifiesBeforeInvalidation = complete && structuralAlignment && oneMinuteTrigger.closed && oneMinuteTrigger.direction === intendedLabel && fiveMinuteDirection === intendedLabel && !structureContradicted && volatilityRegime !== "EXTREME" && qualityScore >= thresholds.standard && intendedDirection !== 0;
    const invalidationFeature = structureFeatures[invalidationTimeframe];
    const invalidationClose = invalidationFeature.emaContext.close;
    const candidateLevels = intendedDirection > 0
      ? [
        { price: invalidationFeature.latestSwingLow?.price, source: "CONFIRMED_SWING_LOW" },
        { price: invalidationFeature.recentFvgs.bullish?.lower, source: "BULLISH_FVG_LOWER_BOUNDARY" },
        { price: invalidationFeature.emaContext.ema20, source: "EMA20_DYNAMIC_SUPPORT" },
      ].filter((level) => Number.isFinite(level.price) && Number.isFinite(invalidationClose) && level.price < invalidationClose)
      : intendedDirection < 0
        ? [
          { price: invalidationFeature.latestSwingHigh?.price, source: "CONFIRMED_SWING_HIGH" },
          { price: invalidationFeature.recentFvgs.bearish?.upper, source: "BEARISH_FVG_UPPER_BOUNDARY" },
          { price: invalidationFeature.emaContext.ema20, source: "EMA20_DYNAMIC_RESISTANCE" },
        ].filter((level) => Number.isFinite(level.price) && Number.isFinite(invalidationClose) && level.price > invalidationClose)
        : [];
    const invalidationLevel = candidateLevels.length
      ? candidateLevels.reduce((nearest, level) => intendedDirection > 0
        ? (level.price > nearest.price ? level : nearest)
        : (level.price < nearest.price ? level : nearest))
      : null;
    const invalidationPrice = invalidationLevel?.price ?? null;
    const qualified = qualifiesBeforeInvalidation && invalidationPrice !== null;
    const direction = qualified ? intendedLabel : "WAIT";
    const invalidationBasis = intendedDirection > 0 ? "nearest active structural support" : intendedDirection < 0 ? "nearest active structural resistance" : "no directional structure";
    const invalidation = intendedDirection === 0
      ? `No directional ${horizonMinutes}m bias exists, so no structural invalidation can be assigned.`
      : invalidationPrice === null
        ? `No unbreached ${invalidationTimeframe} completed-candle structural invalidation level is available; this candidate must remain WAIT.`
        : `${intendedDirection > 0 ? "Bullish" : "Bearish"} ${horizonMinutes}m setup invalidated by a completed ${invalidationTimeframe} close ${intendedDirection > 0 ? "below" : "above"} ${invalidationPrice.toFixed(2)} (${invalidationLevel.source.toLowerCase().replaceAll("_", " ")}).`;
    const invalidationDetails = {
      price: invalidationPrice, text: invalidation, timeframe: invalidationTimeframe,
      source: invalidationLevel?.source ?? null, latestCompletedClose: Number.isFinite(invalidationClose) ? invalidationClose : null,
      condition: intendedDirection > 0 ? "COMPLETED_CLOSE_BELOW" : intendedDirection < 0 ? "COMPLETED_CLOSE_ABOVE" : null,
      basis: invalidationBasis,
    };
    const levelFeature = structureFeatures[invalidationTimeframe];
    const levelIndicators = analyses[invalidationTimeframe].indicators;
    const levelAtr = levelIndicators.atr14;
    const nearestLevel = (items, side) => {
      const eligible = items.filter((item) => Number.isFinite(item.price) && (side === "SUPPORT" ? item.price < price : item.price > price));
      if (!eligible.length || !(price > 0)) return null;
      const selected = eligible.reduce((nearest, item) => side === "SUPPORT" ? (item.price > nearest.price ? item : nearest) : (item.price < nearest.price ? item : nearest));
      const distance = Math.abs(price - selected.price);
      const distanceAtr = Number.isFinite(levelAtr) && levelAtr > 0 ? distance / levelAtr : null;
      return { ...selected, timeframe: invalidationTimeframe, distanceBps: distance / price * 10000, distanceAtr, proximity: distanceAtr !== null && distanceAtr <= 0.5 ? "NEAR" : "CLEAR" };
    };
    const supportLevel = nearestLevel([
      { price: levelFeature.latestSwingLow?.price, source: "CONFIRMED_SWING_LOW" },
      { price: levelIndicators.support, source: "ROLLING_SUPPORT_30" },
      { price: levelFeature.emaContext.ema20, source: "EMA20_DYNAMIC_SUPPORT" },
      { price: levelFeature.recentFvgs.bullish?.lower, source: "BULLISH_FVG_LOWER_BOUNDARY" },
    ], "SUPPORT");
    const resistanceLevel = nearestLevel([
      { price: levelFeature.latestSwingHigh?.price, source: "CONFIRMED_SWING_HIGH" },
      { price: levelIndicators.resistance, source: "ROLLING_RESISTANCE_30" },
      { price: levelFeature.emaContext.ema20, source: "EMA20_DYNAMIC_RESISTANCE" },
      { price: levelFeature.recentFvgs.bearish?.upper, source: "BEARISH_FVG_UPPER_BOUNDARY" },
    ], "RESISTANCE");
    const fifteenMinuteDirection = regimeDirection(analyses["15m"]) > 0 ? "UP" : regimeDirection(analyses["15m"]) < 0 ? "DOWN" : "NEUTRAL";
    const fifteenMinuteAligned = intendedLabel !== "NEUTRAL" && fifteenMinuteDirection === intendedLabel && !structureContradicted;
    const reasons = complete
      ? [`${horizonMinutes}m emphasizes ${emphasis}.`, `Completed 1m trigger ${oneMinuteTrigger.direction} uses ${oneMinuteTrigger.patterns.map((pattern) => pattern.name).join(", ") || "no qualifying pattern"}; explicit 5m structure is ${fiveMinuteDirection}.`, `Completed-candle confluence produced setup quality ${qualityScore}/100 (${band}); quality is an auditable rules score, NOT a probability.`, `Market-structure adjustment is ${structureAdjustment >= 0 ? "+" : ""}${structureAdjustment} points from ${alignedStructureWeight} aligned versus ${opposingStructureWeight} opposing component weight.`, `1m relative volume is ${relativeVolume === null ? "unavailable" : `${relativeVolume.toFixed(2)}x`} and volatility is ${volatilityRegime}.`, !structuralAlignment ? "Entry blocked: the completed 1m trigger is not explicitly confirmed by aligned 5m structure and higher-timeframe context." : structureContradicted ? "A recent opposing 15m CHoCH/market-structure shift blocks entry." : volatilityRegime === "EXTREME" ? "Extreme 1m ATR volatility blocks entry." : invalidationPrice === null ? "A finite, unbreached, direction-appropriate structural invalidation level from the declared timeframe is required before entry." : direction === "WAIT" ? `Quality is below the STANDARD threshold ${thresholds.standard}.` : `${direction} alignment qualifies as ${band}.`, invalidation]
      : ["All four timeframes require at least 50 completed candles and a close watermark for EMA50/structure context.", invalidation];
    const watermarkKey = analysisTimeframes.map((timeframe) => `${timeframe}:${timeframeCloseWatermarks[timeframe] ?? "missing"}`).join("|");
    return {
      decisionKey: `${AUTONOMOUS_STRATEGY_VERSION}:${symbol}:${horizonMinutes}:${watermarkKey}`,
      symbol, horizonMinutes, direction, setupDirection: intendedLabel, actionableDirection: qualified ? intendedLabel : null, qualified,
      qualityScore, qualityBand: band, volatilityRegime, referencePrice: Number.isFinite(price) && price > 0 ? price : null,
      timeframeCloseWatermarks: { ...timeframeCloseWatermarks }, triggerValidUntil, reasons, confluenceComponents,
      technicalFeatures: {
        oneMinuteTrigger,
        fiveMinuteConfirmation: { status: oneMinuteTrigger.direction !== "NEUTRAL" && oneMinuteTrigger.direction === fiveMinuteDirection ? "CONFIRMED" : "NOT_CONFIRMED", direction: fiveMinuteDirection, watermark: timeframeCloseWatermarks["5m"], evidence: structureFeatures["5m"].structureEvidence },
        fifteenMinuteAlignment: { status: fifteenMinuteAligned ? "ALIGNED" : "NOT_ALIGNED", direction: fifteenMinuteDirection, regime: analyses["15m"].regime, watermark: timeframeCloseWatermarks["15m"], evidence: structureFeatures["15m"].structureEvidence },
        higherTimeframeRegimes: { "15m": analyses["15m"].regime, "1h": analyses["1h"].regime },
        relativeVolume20: relativeVolume,
        atrFraction,
      },
      levels: { support: supportLevel, resistance: resistanceLevel, invalidation: invalidationDetails },
      structureFeatures: { ...structureFeatures }, invalidationPrice, invalidation, invalidationDetails,
      qualityDefinition: { classification: "DETERMINISTIC_SETUP_QUALITY_NOT_PROBABILITY", baseQuality: Math.round(clamp(baseQuality, 0, 100)), structureAdjustment, scoreRange: [0, 100] },
      strategyName: AUTONOMOUS_STRATEGY, strategyVersion: AUTONOMOUS_STRATEGY_VERSION,
    };
  });
}

export const autonomousCandidates = generateSignals;

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
  const candidates = generateSignals(completedCandles, options);
  return { direction, upScore, downScore, technicalUpProbability, technicalDownProbability, confidence: Math.abs(difference) >= 30 ? "HIGH" : Math.abs(difference) >= 15 ? "MEDIUM" : "LOW", calibrationStatus: "UNCALIBRATED", breakEvenProbability: breakEven, heuristicProbability, reasons, invalidation, timeframes, candidates, classification: "MODEL_ESTIMATE", modelVersion: "rules-v0.6.0", calculatedAt: now.toISOString() };
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
