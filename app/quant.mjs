const last = (values) => values.at(-1);
const finite = (values) => values.filter(Number.isFinite);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

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
export function analyzeMarket(candles, payoutRate, now = new Date()) {
  const completedCandles = Object.fromEntries(["1m", "5m", "15m", "1h"].map((timeframe) => [timeframe, (candles[timeframe] ?? []).filter((candle) => candle.closed === true)]));
  const timeframes = Object.fromEntries(["1m", "5m", "15m", "1h"].map((timeframe) => [timeframe, timeframeAnalysis(timeframe, completedCandles[timeframe])]));
  let upScore = 50; let downScore = 50; const reasons = []; const invalidation = [];
  const applyRegime = (analysis, weight) => {
    if (analysis.regime === "BULLISH") { upScore += weight; downScore -= weight / 2; reasons.push(`${analysis.timeframe}: bullish structure.`); }
    if (analysis.regime === "BEARISH") { downScore += weight; upScore -= weight / 2; reasons.push(`${analysis.timeframe}: bearish structure.`); }
  };
  applyRegime(timeframes["1h"], 18); applyRegime(timeframes["15m"], 14); applyRegime(timeframes["5m"], 10);
  const current = candles["1m"].at(-1); const previous = candles["1m"].at(-2); const indicators = timeframes["1m"].indicators;
  if (indicators.rsi14 !== null && indicators.rsi14 >= 75) { downScore += 10; reasons.push(`1m RSI ${indicators.rsi14.toFixed(1)} shows extension, not a reversal by itself.`); }
  if (indicators.rsi14 !== null && indicators.rsi14 <= 25) { upScore += 10; reasons.push(`1m RSI ${indicators.rsi14.toFixed(1)} shows extension, not a reversal by itself.`); }
  if (current && previous && indicators.atr14 !== null && indicators.atr14 > 0) {
    const normalized = (current.close - previous.close) / indicators.atr14;
    const strongVolume = (indicators.relativeVolume20 ?? 0) >= 1.3;
    if (normalized >= 1.2) { upScore += strongVolume ? 12 : 5; reasons.push(`1m upward impulse ${normalized.toFixed(2)} ATR${strongVolume ? " with relative volume" : " without strong volume"}.`); }
    if (normalized <= -1.2) { downScore += strongVolume ? 12 : 5; reasons.push(`1m downward impulse ${Math.abs(normalized).toFixed(2)} ATR${strongVolume ? " with relative volume" : " without strong volume"}.`); }
    const body = Math.abs(current.close - current.open);
    if (body > 0 && (current.high - Math.max(current.open, current.close)) / body >= 1.8 && current.close < current.open) { downScore += 12; reasons.push("1m upper rejection confirmed by a bearish body."); }
    if (body > 0 && (Math.min(current.open, current.close) - current.low) / body >= 1.8 && current.close > current.open) { upScore += 12; reasons.push("1m lower rejection confirmed by a bullish body."); }
  }
  upScore = Math.round(clamp(upScore, 0, 100)); downScore = Math.round(clamp(downScore, 0, 100));
  const difference = upScore - downScore; const breakEven = breakEvenProbability(payoutRate);
  const heuristicProbability = candles["1m"].length >= 30 ? clamp(0.5 + Math.abs(difference) / 200, 0.5, 0.72) : null;
  let direction = "WAIT";
  if (heuristicProbability !== null && heuristicProbability >= breakEven + 0.03 && Math.abs(difference) >= 15) direction = difference > 0 ? "UP" : "DOWN";
  if (direction === "WAIT") reasons.push("No sufficient estimated edge over break-even; WAIT.");
  if (indicators.support !== null) invalidation.push(`Bullish scenario invalid below 1m support ${indicators.support.toFixed(2)}.`);
  if (indicators.resistance !== null) invalidation.push(`Bearish scenario invalid above 1m resistance ${indicators.resistance.toFixed(2)}.`);
  return { direction, upScore, downScore, confidence: Math.abs(difference) >= 30 ? "HIGH" : Math.abs(difference) >= 15 ? "MEDIUM" : "LOW", calibrationStatus: "UNCALIBRATED", breakEvenProbability: breakEven, heuristicProbability, reasons, invalidation, timeframes, classification: "MODEL_ESTIMATE", modelVersion: "rules-v0.1.0", calculatedAt: now.toISOString() };
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
