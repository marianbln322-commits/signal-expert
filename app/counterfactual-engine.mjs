const INTERVAL_MS = Object.freeze({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 });
const PRIORITY = Object.freeze([
  "FEED_HEALTH", "MARKET_FRESHNESS", "CANDLE_SOURCE_COHERENCE", "CORRECTION_STATE", "LEVEL_STATE",
  "COMPLETED_1M_TRIGGER", "FIVE_MINUTE_CONFIRMATION", "FIFTEEN_MINUTE_ALIGNMENT", "TRIGGER_FRESHNESS",
  "QUALITY", "FINITE_INVALIDATION", "ORDER_BOOK_VALID", "SPREAD_LIMIT", "TOP_LIQUIDITY",
  "SOURCE_COHERENCE", "MACRO_NEWS", "DIRECTION",
]);

function finite(value) { return Number.isFinite(value) ? value : null; }
function timestamp(value) { if (value === null || value === undefined || value === "") return null; const parsed = new Date(value).getTime(); return Number.isFinite(parsed) ? parsed : null; }
function nextClose(candidate, timeframe) {
  const close = timestamp(candidate?.timeframeCloseWatermarks?.[timeframe]);
  return close === null ? null : new Date(close + INTERVAL_MS[timeframe]).toISOString();
}
function scalarRequirement(check, observed, operator, threshold, delta, assumption) {
  return {
    code: check.code,
    status: "BLOCKED",
    reason: check.reason,
    observed,
    operator,
    threshold,
    delta,
    requiredPrice: null,
    priceBasis: null,
    nextCloseAt: null,
    assumptions: [assumption, "All other gate inputs are held unchanged."],
    recomputable: observed !== null && threshold !== null,
  };
}
function observationalRequirement(check, observed, nextCloseAt, assumption) {
  return {
    code: check.code,
    status: "BLOCKED",
    reason: check.reason,
    observed,
    operator: null,
    threshold: null,
    delta: null,
    requiredPrice: null,
    priceBasis: null,
    nextCloseAt,
    assumptions: [assumption, "The complete entry policy must be recomputed after the new observation."],
    recomputable: false,
  };
}

/**
 * Explains blocked entry gates without pretending that a price move can satisfy
 * path-dependent or state-machine rules. Only directly monotone scalar checks
 * receive an operator, threshold and delta.
 */
export function explainCounterfactuals({ candidate, snapshot, checks, policy = {}, now = new Date() }) {
  const blocked = (checks ?? []).filter((check) => check?.status === "BLOCKED");
  const counterfactuals = blocked.map((check) => {
    const evidence = check.evidence ?? {};
    if (check.code === "QUALITY") {
      const observed = finite(evidence.qualityScore ?? candidate?.qualityScore);
      const threshold = finite(evidence.minimum ?? policy.qualityThreshold);
      return scalarRequirement(check, observed, ">=", threshold, observed === null || threshold === null ? null : Math.max(0, threshold - observed), "Setup quality is treated as monotone only within this frozen evaluation.");
    }
    if (check.code === "SPREAD_LIMIT") {
      const observed = finite(evidence.spreadBps ?? snapshot?.orderBook?.metrics?.spreadBps);
      const threshold = finite(evidence.maximumBps ?? policy.maxSpreadBps);
      return scalarRequirement(check, observed, "<=", threshold, observed === null || threshold === null ? null : Math.max(0, observed - threshold), "Spread is treated as monotone only within this frozen order-book observation.");
    }
    if (check.code === "TOP_LIQUIDITY") {
      const observed = finite(evidence.topNotional ?? snapshot?.orderBook?.metrics?.topNotional);
      const threshold = finite(evidence.minimum ?? policy.minTopNotional);
      return scalarRequirement(check, observed, ">=", threshold, observed === null || threshold === null ? null : Math.max(0, threshold - observed), "Top-of-book liquidity is treated as monotone only within this frozen order-book observation.");
    }

    const correction = candidate?.persistentState?.correction;
    const setupDirection = candidate?.setupDirection ?? candidate?.technicalFeatures?.oneMinuteTrigger?.direction;
    const levelKind = setupDirection === "UP" ? "support" : setupDirection === "DOWN" ? "resistance" : null;
    const observedByCode = {
      FEED_HEALTH: snapshot?.health?.feed ?? "UNAVAILABLE",
      MARKET_FRESHNESS: { dataUsable: snapshot?.health?.dataUsable ?? null, market: snapshot?.market?.status ?? "UNAVAILABLE", candles: snapshot?.health?.candles ?? null },
      CANDLE_SOURCE_COHERENCE: evidence,
      CORRECTION_STATE: correction ? { state: correction.state, payload: correction.payload ?? null } : candidate?.correction ?? "UNAVAILABLE",
      LEVEL_STATE: levelKind ? candidate?.persistentState?.levels?.[levelKind] ?? evidence : evidence,
      COMPLETED_1M_TRIGGER: candidate?.technicalFeatures?.oneMinuteTrigger ?? evidence,
      FIVE_MINUTE_CONFIRMATION: candidate?.technicalFeatures?.fiveMinuteConfirmation ?? evidence,
      FIFTEEN_MINUTE_ALIGNMENT: candidate?.technicalFeatures?.fifteenMinuteAlignment ?? evidence,
      TRIGGER_FRESHNESS: evidence,
      FINITE_INVALIDATION: evidence,
      ORDER_BOOK_VALID: evidence,
      SOURCE_COHERENCE: evidence,
      MACRO_NEWS: evidence,
      DIRECTION: evidence,
    };
    const timeframeByCode = {
      COMPLETED_1M_TRIGGER: "1m", TRIGGER_FRESHNESS: "1m", CORRECTION_STATE: "1m", LEVEL_STATE: "1m",
      FIVE_MINUTE_CONFIRMATION: "5m", FIFTEEN_MINUTE_ALIGNMENT: "15m", FINITE_INVALIDATION: candidate?.invalidationDetails?.timeframe ?? null,
    };
    const timeframe = timeframeByCode[check.code];
    const assumption = timeframe
      ? `${check.code} is path-dependent and can only be evaluated from a newly completed ${timeframe} observation.`
      : `${check.code} is discrete, path-dependent, or depends on multiple inputs; no truthful one-variable threshold is available.`;
    return observationalRequirement(check, Object.hasOwn(observedByCode, check.code) ? observedByCode[check.code] : evidence, timeframe ? nextClose(candidate, timeframe) : null, assumption);
  });

  counterfactuals.sort((left, right) => {
    const leftRank = PRIORITY.indexOf(left.code); const rightRank = PRIORITY.indexOf(right.code);
    return (leftRank < 0 ? PRIORITY.length : leftRank) - (rightRank < 0 ? PRIORITY.length : rightRank);
  });
  const evaluatedAt = new Date(now).toISOString();
  return {
    ready: counterfactuals.length === 0,
    blockedCount: counterfactuals.length,
    closestBlocker: counterfactuals[0] ?? null,
    counterfactuals,
    requirements: counterfactuals,
    evaluatedAt,
    classification: "COUNTERFACTUAL_REQUIREMENTS_NOT_ENTRY_INSTRUCTION",
    policy: {
      qualityThreshold: finite(policy.qualityThreshold),
      maxSpreadBps: finite(policy.maxSpreadBps),
      minTopNotional: finite(policy.minTopNotional),
    },
  };
}
