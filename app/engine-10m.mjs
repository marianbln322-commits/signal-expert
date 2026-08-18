import { classifyExtendedRegime } from "./regime-engine.mjs";
import { evaluateFeatureMatrix, normalizeSignalContext } from "./signal-features.mjs";

export const ENGINE_10M_VERSION = "engine-10m-v0.9.0";

export const REGIME_MATRIX_10M = Object.freeze({
  LOW_LIQUIDITY: Object.freeze({ orderFlow: 0.25, oneMinute: 0.25, fiveMinute: 0.2, correction: 0.15, fifteenMinute: 0.07, oneHour: 0.02, structure: 0.06 }),
  ABNORMAL_VOLATILITY: Object.freeze({ orderFlow: 0.18, oneMinute: 0.18, fiveMinute: 0.27, correction: 0.16, fifteenMinute: 0.1, oneHour: 0.03, structure: 0.08 }),
  HIGH_VOLATILITY: Object.freeze({ orderFlow: 0.16, oneMinute: 0.18, fiveMinute: 0.28, correction: 0.17, fifteenMinute: 0.13, oneHour: 0.03, structure: 0.05 }),
  COMPRESSION: Object.freeze({ orderFlow: 0.21, oneMinute: 0.24, fiveMinute: 0.22, correction: 0.13, fifteenMinute: 0.1, oneHour: 0.03, structure: 0.07 }),
  BREAKOUT: Object.freeze({ orderFlow: 0.26, oneMinute: 0.23, fiveMinute: 0.22, correction: 0.1, fifteenMinute: 0.09, oneHour: 0.03, structure: 0.07 }),
  STRONG_TREND: Object.freeze({ orderFlow: 0.16, oneMinute: 0.2, fiveMinute: 0.27, correction: 0.12, fifteenMinute: 0.12, oneHour: 0.05, structure: 0.08 }),
  WEAK_TREND: Object.freeze({ orderFlow: 0.2, oneMinute: 0.22, fiveMinute: 0.26, correction: 0.13, fifteenMinute: 0.09, oneHour: 0.03, structure: 0.07 }),
  RANGE: Object.freeze({ orderFlow: 0.24, oneMinute: 0.27, fiveMinute: 0.19, correction: 0.16, fifteenMinute: 0.07, oneHour: 0.02, structure: 0.05 }),
});

const LABELS = Object.freeze({
  orderFlow: "Order-flow imbalance",
  oneMinute: "Completed 1m trigger and flow",
  fiveMinute: "Completed 5m trend and structure",
  correction: "Completed-candle correction state",
  fifteenMinute: "15m directional context",
  oneHour: "1h directional context",
  structure: "15m/1h market structure",
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

export function evaluate10m(input = {}) {
  const context = normalizeSignalContext(input);
  const regimeResult = classifyExtendedRegime(context.source);
  const evaluation = evaluateFeatureMatrix(context, {
    horizonMinutes: 10,
    version: ENGINE_10M_VERSION,
    regimeResult,
    matrices: REGIME_MATRIX_10M,
    labels: LABELS,
    timeframes: TIMEFRAMES,
    requiredFeatures: ["orderFlow", "oneMinute", "fiveMinute", "correction"],
    blockedCorrectionStatuses: ["CORRECTION_STARTING", "CORRECTION_ACTIVE", "LOCAL_LEVEL_BREAK_CONFIRMED"],
    directionalThreshold: 0.12,
  });
  return Object.freeze({
    ...evaluation,
    emphasis: Object.freeze(["orderFlow", "oneMinute", "fiveMinute", "correction"]),
    regimeDetails: regimeResult,
  });
}

export const evaluateTenMinute = evaluate10m;
export const evaluate10MinuteSignal = evaluate10m;
