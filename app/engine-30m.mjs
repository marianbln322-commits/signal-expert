import { classifyExtendedRegime } from "./regime-engine.mjs";
import { evaluateFeatureMatrix, normalizeSignalContext } from "./signal-features.mjs";

export const ENGINE_30M_VERSION = "engine-30m-v0.9.0";

export const REGIME_MATRIX_30M = Object.freeze({
  LOW_LIQUIDITY: Object.freeze({ orderFlow: 0.02, oneMinute: 0.04, fiveMinute: 0.2, correction: 0.03, fifteenMinute: 0.28, oneHour: 0.25, structure: 0.18 }),
  ABNORMAL_VOLATILITY: Object.freeze({ orderFlow: 0.02, oneMinute: 0.03, fiveMinute: 0.2, correction: 0.03, fifteenMinute: 0.27, oneHour: 0.27, structure: 0.18 }),
  HIGH_VOLATILITY: Object.freeze({ orderFlow: 0.02, oneMinute: 0.04, fiveMinute: 0.22, correction: 0.04, fifteenMinute: 0.27, oneHour: 0.24, structure: 0.17 }),
  COMPRESSION: Object.freeze({ orderFlow: 0.03, oneMinute: 0.05, fiveMinute: 0.2, correction: 0.04, fifteenMinute: 0.28, oneHour: 0.22, structure: 0.18 }),
  BREAKOUT: Object.freeze({ orderFlow: 0.04, oneMinute: 0.07, fiveMinute: 0.25, correction: 0.04, fifteenMinute: 0.25, oneHour: 0.18, structure: 0.17 }),
  STRONG_TREND: Object.freeze({ orderFlow: 0.01, oneMinute: 0.03, fiveMinute: 0.2, correction: 0.03, fifteenMinute: 0.27, oneHour: 0.28, structure: 0.18 }),
  WEAK_TREND: Object.freeze({ orderFlow: 0.02, oneMinute: 0.04, fiveMinute: 0.22, correction: 0.04, fifteenMinute: 0.27, oneHour: 0.24, structure: 0.17 }),
  RANGE: Object.freeze({ orderFlow: 0.03, oneMinute: 0.05, fiveMinute: 0.22, correction: 0.04, fifteenMinute: 0.28, oneHour: 0.21, structure: 0.17 }),
});

const LABELS = Object.freeze({
  orderFlow: "Order-flow confirmation",
  oneMinute: "Completed 1m timing",
  fiveMinute: "Completed 5m confirmation",
  correction: "Completed-candle correction state",
  fifteenMinute: "15m trend and structure",
  oneHour: "1h trend and structure",
  structure: "Higher-timeframe market structure",
});

const TIMEFRAMES = Object.freeze({
  orderFlow: "tick/order-book",
  oneMinute: "1m",
  fiveMinute: "5m",
  correction: "1m/5m",
  fifteenMinute: "15m",
  oneHour: "1h",
  structure: "15m/1h",
});

export function evaluate30m(input = {}) {
  const context = normalizeSignalContext(input);
  const regimeResult = classifyExtendedRegime(context.source);
  const evaluation = evaluateFeatureMatrix(context, {
    horizonMinutes: 30,
    version: ENGINE_30M_VERSION,
    regimeResult,
    matrices: REGIME_MATRIX_30M,
    labels: LABELS,
    timeframes: TIMEFRAMES,
    requiredFeatures: ["fiveMinute", "fifteenMinute", "oneHour", "structure"],
    blockedCorrectionStatuses: ["LOCAL_LEVEL_BREAK_CONFIRMED"],
    directionalThreshold: 0.1,
  });
  return Object.freeze({
    ...evaluation,
    emphasis: Object.freeze(["fiveMinute", "fifteenMinute", "oneHour", "structure"]),
    regimeDetails: regimeResult,
  });
}

export const evaluateThirtyMinute = evaluate30m;
export const evaluate30MinuteSignal = evaluate30m;
