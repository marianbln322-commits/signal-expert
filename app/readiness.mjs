const timestamp = (value) => { const parsed = new Date(value).getTime(); return Number.isFinite(parsed) ? parsed : null; };

export function explainReadiness({ candidate, snapshot, checks, policy, now = new Date() }) {
  const requirements = [];
  const candidateCorrection = candidate?.persistentState?.correction?.payload ?? candidate?.correction;
  const add = (code, status, current, required, delta, condition, nextObservableAt, reason) => requirements.push({ code, status, current, required, delta, condition, nextObservableAt, reason });
  for (const check of checks ?? []) {
    if (check.status !== "BLOCKED") continue;
    const evidence = check.evidence ?? {};
    if (check.code === "QUALITY") add(check.code, "MISSING", evidence.qualityScore, evidence.minimum, Number.isFinite(evidence.qualityScore) ? evidence.minimum - evidence.qualityScore : null, `quality >= ${evidence.minimum}`, null, check.reason);
    else if (check.code === "SPREAD_LIMIT") add(check.code, "MISSING", evidence.spreadBps, evidence.maximumBps, Number.isFinite(evidence.spreadBps) ? Math.max(0, evidence.spreadBps - evidence.maximumBps) : null, `spread <= ${evidence.maximumBps} bps`, null, check.reason);
    else if (check.code === "TOP_LIQUIDITY") add(check.code, "MISSING", evidence.topNotional, evidence.minimum, Number.isFinite(evidence.topNotional) ? evidence.minimum - evidence.topNotional : null, `10-level liquidity >= ${evidence.minimum} USDT`, null, check.reason);
    else if (check.code === "TRIGGER_FRESHNESS" || check.code === "COMPLETED_1M_TRIGGER") {
      const close = timestamp(candidate?.timeframeCloseWatermarks?.["1m"]); const next = close === null ? null : new Date(close + 60_000).toISOString();
      add(check.code, "MISSING", evidence.triggerValidUntil ?? candidate?.triggerValidUntil ?? null, "new completed directional 1m trigger", null, "wait for a new closed 1m trigger", next, check.reason);
    } else if (check.code === "FIVE_MINUTE_CONFIRMATION") {
      const close = timestamp(candidate?.timeframeCloseWatermarks?.["5m"]); add(check.code, "MISSING", evidence.direction ?? "NEUTRAL", candidate?.setupDirection ?? "directional", null, "completed 5m structure must align", close === null ? null : new Date(close + 300_000).toISOString(), check.reason);
    } else if (check.code === "CORRECTION_STATE") {
      const trend = candidateCorrection?.trendDirection; const condition = trend === "UP" ? "completed 1m trigger must resume UP above the previous high" : trend === "DOWN" ? "completed 1m trigger must resume DOWN below the previous low" : "establish a directional 5m trend, then observe NO_CORRECTION or a confirmed correction end";
      add(check.code, "MISSING", candidate?.persistentState?.correction?.state ?? candidateCorrection?.status ?? "UNAVAILABLE", "NO_CORRECTION or CORRECTION_END_CONFIRMED", null, condition, null, check.reason);
    }
    else if (check.code === "FEED_HEALTH") add(check.code, "MISSING", snapshot?.health?.feed?.status ?? "UNAVAILABLE", "LIVE", null, "all required Binance stream channels must be LIVE or stream mode disabled", null, check.reason);
    else add(check.code, "MISSING", evidence, "PASS", null, check.reason, null, check.reason);
  }
  const priority = ["FEED_HEALTH", "MARKET_FRESHNESS", "CANDLE_SOURCE_COHERENCE", "CORRECTION_STATE", "LEVEL_STATE", "COMPLETED_1M_TRIGGER", "FIVE_MINUTE_CONFIRMATION", "FIFTEEN_MINUTE_ALIGNMENT", "TRIGGER_FRESHNESS", "QUALITY", "FINITE_INVALIDATION", "ORDER_BOOK_VALID", "SPREAD_LIMIT", "TOP_LIQUIDITY", "SOURCE_COHERENCE", "DIRECTION"];
  requirements.sort((left, right) => {
    const leftRank = priority.indexOf(left.code); const rightRank = priority.indexOf(right.code);
    return (leftRank === -1 ? priority.length : leftRank) - (rightRank === -1 ? priority.length : rightRank);
  });
  return { ready: requirements.length === 0, blockedCount: requirements.length, closestBlocker: requirements[0] ?? null, requirements, evaluatedAt: now.toISOString(), classification: "COUNTERFACTUAL_REQUIREMENTS_NOT_ENTRY_INSTRUCTION", policy: { qualityThreshold: policy.qualityThreshold, maxSpreadBps: policy.maxSpreadBps, minTopNotional: policy.minTopNotional } };
}
