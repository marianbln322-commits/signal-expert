function timestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteLevel(level) {
  return level && Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.quantity) && level.quantity > 0;
}

export function deriveOrderBookMetrics(orderBook) {
  const bids = (orderBook?.data?.bids ?? []).filter(finiteLevel);
  const asks = (orderBook?.data?.asks ?? []).filter(finiteLevel);
  if (!bids.length || !asks.length) return { valid: false, reason: "Order book requires at least one positive bid and ask.", bestBid: null, bestAsk: null, spread: null, spreadBps: null, topNotional: null, midPrice: null };
  const bestBidLevel = bids.reduce((best, level) => level.price > best.price ? level : best);
  const bestAskLevel = asks.reduce((best, level) => level.price < best.price ? level : best);
  if (bestBidLevel.price >= bestAskLevel.price) return { valid: false, reason: "Order book is crossed or locked.", bestBid: bestBidLevel.price, bestAsk: bestAskLevel.price, spread: null, spreadBps: null, topNotional: null, midPrice: null };
  const spread = bestAskLevel.price - bestBidLevel.price;
  const midPrice = (bestAskLevel.price + bestBidLevel.price) / 2;
  const depthLevels = 10;
  const nearBidNotional = bids.sort((left, right) => right.price - left.price).slice(0, depthLevels).reduce((sum, level) => sum + level.price * level.quantity, 0);
  const nearAskNotional = asks.sort((left, right) => left.price - right.price).slice(0, depthLevels).reduce((sum, level) => sum + level.price * level.quantity, 0);
  return {
    valid: true,
    reason: "Best bid and ask form a valid positive spread.",
    bestBid: bestBidLevel.price,
    bestAsk: bestAskLevel.price,
    bestBidQuantity: bestBidLevel.quantity,
    bestAskQuantity: bestAskLevel.quantity,
    spread,
    spreadBps: spread / midPrice * 10000,
    bestLevelNotional: Math.min(bestBidLevel.price * bestBidLevel.quantity, bestAskLevel.price * bestAskLevel.quantity),
    topNotional: Math.min(nearBidNotional, nearAskNotional),
    depthLevels,
    midPrice,
  };
}

export function evaluateEntryGates({ snapshot, candidate, policy, now = new Date() }) {
  const checks = [];
  const add = (code, passed, reason, evidence = null, skipped = false) => checks.push({ code, status: skipped ? "SKIPPED" : passed ? "PASS" : "BLOCKED", reason, evidence });
  const direction = candidate?.direction;
  const feed = snapshot?.health?.feed;
  if (policy.feedRequired) add("FEED_HEALTH", feed?.actionReady === true, feed?.actionReady === true ? "All required Binance event-stream channels, including DEPTH, are LIVE." : `Required event stream is ${feed?.status ?? "UNAVAILABLE"}; entry fails closed.`, feed ?? null);
  else add("FEED_HEALTH", true, "Event-stream mode is disabled for this backward-compatible instance.", { status: "DISABLED" }, true);
  const orderFlow = snapshot?.orderFlow;
  const orderFlowReady = orderFlow?.status === "LIVE" && orderFlow?.freshness?.book?.status === "LIVE" && orderFlow?.freshness?.trades?.status === "LIVE";
  const extendedRegime = candidate?.extendedRegime;
  const blockedRegime = ["ABNORMAL_VOLATILITY", "LOW_LIQUIDITY"].includes(extendedRegime?.regime) || extendedRegime?.failClosed === true;
  const engine = candidate?.engine;
  const engineBlockers = candidate?.engineBlockers ?? engine?.blockers ?? [];
  const engineReady = engine && ["UP", "DOWN"].includes(engine.direction) && engineBlockers.length === 0 && engine.direction === candidate?.direction;
  if (policy.feedRequired) {
    add("ORDER_FLOW", orderFlowReady, orderFlowReady ? "Synchronized Binance depth and aggressor trades provide LIVE order flow." : `Order flow is ${orderFlow?.status ?? "UNAVAILABLE"}; REST fallback and mixed-provider flow are never actionable.`, orderFlow ?? null);
    add("EXTENDED_REGIME", Boolean(extendedRegime) && !blockedRegime, !extendedRegime ? "Extended regime is unavailable; entry fails closed." : blockedRegime ? `${extendedRegime.regime} is a canonical fail-closed regime.` : `Extended regime ${extendedRegime.regime} permits engine evaluation.`, extendedRegime ?? null);
    add("HORIZON_ENGINE", Boolean(engineReady), engineReady ? `Canonical ${candidate.horizonMinutes}m engine ${engine.version} confirms ${engine.direction}.` : `Canonical ${candidate?.horizonMinutes ?? "unknown"}m engine is unavailable, WAIT, conflicting, or blocked.`, { version: engine?.version ?? null, direction: engine?.direction ?? null, blockers: engineBlockers });
  } else {
    add("ORDER_FLOW", true, "Deep order-flow gate is inactive because event-stream mode is disabled.", { status: "DISABLED" }, true);
    add("EXTENDED_REGIME", true, "Extended-regime gate is inactive because event-stream mode is disabled.", { status: "DISABLED" }, true);
    add("HORIZON_ENGINE", true, "Deep horizon-engine gate is inactive because event-stream mode is disabled.", { status: "DISABLED" }, true);
  }
  const persistedCorrection = candidate?.persistentState?.correction;
  const correctionEvidence = persistedCorrection ? { ...(persistedCorrection.payload ?? {}), status: persistedCorrection.state, version: persistedCorrection.version, updatedAt: persistedCorrection.updatedAt } : candidate?.correction;
  const correctionStatus = correctionEvidence?.status ?? "UNAVAILABLE";
  const correctionPassed = ["NO_CORRECTION", "CORRECTION_END_CONFIRMED"].includes(correctionStatus);
  add("CORRECTION_STATE", correctionPassed, correctionPassed ? `Persisted correction state permits entry: ${correctionStatus}.` : `Persisted correction state ${correctionStatus} does not permit entry.`, correctionEvidence ?? null);
  const setupDirection = candidate?.setupDirection ?? candidate?.technicalFeatures?.oneMinuteTrigger?.direction;
  const levelKind = setupDirection === "UP" ? "support" : setupDirection === "DOWN" ? "resistance" : null;
  const persistedLevel = levelKind ? candidate?.persistentState?.levels?.[levelKind] : null;
  const relevantLevel = persistedLevel ? { ...(persistedLevel.payload?.interaction ?? {}), status: persistedLevel.state, version: persistedLevel.version, updatedAt: persistedLevel.updatedAt } : levelKind ? candidate?.levelInteractions?.[levelKind] : null;
  const levelPassed = relevantLevel && !["BREAK_PENDING_CONFIRMATION", "BREAK_CONFIRMED"].includes(relevantLevel.status) && relevantLevel.hasConfirmedBreak !== true;
  add("LEVEL_STATE", Boolean(levelPassed), levelPassed ? `${relevantLevel.kind} persisted state ${relevantLevel.status} permits entry.` : "The direction-relevant persisted level is unavailable, pending break confirmation, or confirmed broken.", relevantLevel ?? null);
  add("DIRECTION", direction === "UP" || direction === "DOWN", direction === "UP" || direction === "DOWN" ? `Directional candidate is ${direction}.` : "Candidate is not directional.", { direction });
  add("QUALITY", Number.isFinite(candidate?.qualityScore) && candidate.qualityScore >= policy.qualityThreshold, Number.isFinite(candidate?.qualityScore) ? `Setup quality ${candidate.qualityScore}/100; minimum ${policy.qualityThreshold}.` : "Setup quality is unavailable.", { qualityScore: candidate?.qualityScore ?? null, minimum: policy.qualityThreshold });
  add("FINITE_INVALIDATION", Number.isFinite(candidate?.invalidationPrice), Number.isFinite(candidate?.invalidationPrice) ? `Finite structural invalidation ${candidate.invalidationPrice}.` : "A finite structural invalidation is required.", { invalidationPrice: candidate?.invalidationPrice ?? null });

  const trigger = candidate?.technicalFeatures?.oneMinuteTrigger;
  const confirmation = candidate?.technicalFeatures?.fiveMinuteConfirmation;
  const fifteenMinute = candidate?.technicalFeatures?.fifteenMinuteAlignment;
  const triggerSetupDirection = candidate?.setupDirection ?? trigger?.direction;
  const aligned = trigger?.direction && trigger.direction !== "NEUTRAL" && trigger.direction === confirmation?.direction && confirmation?.status === "CONFIRMED";
  const fifteenAligned = ["UP", "DOWN"].includes(triggerSetupDirection) && fifteenMinute?.status === "ALIGNED" && fifteenMinute.direction === triggerSetupDirection;
  add("COMPLETED_1M_TRIGGER", trigger?.closed === true && ["UP", "DOWN"].includes(trigger?.direction), trigger?.closed === true ? `Completed 1m trigger is ${trigger.direction}.` : "No completed directional 1m candlestick trigger is available.", trigger ?? null);
  add("FIVE_MINUTE_CONFIRMATION", aligned, aligned ? `5m structure confirms ${trigger.direction}.` : `1m ${trigger?.direction ?? "NEUTRAL"} trigger is not confirmed by explicit 5m structure ${confirmation?.direction ?? "NEUTRAL"}.`, confirmation ?? null);
  add("FIFTEEN_MINUTE_ALIGNMENT", fifteenAligned, fifteenAligned ? `Completed 15m trend aligns ${triggerSetupDirection}.` : `Completed 15m trend ${fifteenMinute?.direction ?? "NEUTRAL"} does not align the ${triggerSetupDirection ?? "NEUTRAL"} setup.`, fifteenMinute ?? null);
  const validUntil = timestamp(candidate?.triggerValidUntil);
  add("TRIGGER_FRESHNESS", validUntil !== null && now.getTime() < validUntil, validUntil === null ? "Trigger deadline is unavailable." : now.getTime() < validUntil ? `Trigger remains valid until ${candidate.triggerValidUntil}.` : `Trigger expired at ${candidate.triggerValidUntil}.`, { triggerValidUntil: candidate?.triggerValidUntil ?? null, evaluatedAt: now.toISOString() });

  add("MARKET_FRESHNESS", snapshot?.health?.dataUsable === true && snapshot?.market?.status === "LIVE", snapshot?.health?.dataUsable === true && snapshot?.market?.status === "LIVE" ? "Ticker and all completed-candle feeds are LIVE." : "Ticker or completed-candle data is unavailable/stale.", { market: snapshot?.market?.status ?? "UNAVAILABLE", candles: snapshot?.health?.candles ?? {} });
  const candleBundleCoherent = snapshot?.health?.analysisCoherent === true;
  const actionSourceCoherent = snapshot?.health?.actionSourceCoherent === true;
  add("CANDLE_SOURCE_COHERENCE", candleBundleCoherent && actionSourceCoherent, candleBundleCoherent && actionSourceCoherent
    ? "Candles, ticker and order book came from the same attributed provider."
    : candleBundleCoherent ? "The candle bundle and ticker/order-book bundle came from different providers." : "Completed candle timeframes are missing or mixed across providers.", {
    analysisCoherent: candleBundleCoherent,
    actionSourceCoherent,
    candleSources: snapshot?.analysis?.sources ?? null,
    marketSource: snapshot?.market?.source ?? null,
    orderBookSource: snapshot?.orderBook?.source ?? null,
  });
  const metrics = snapshot?.orderBook?.metrics ?? deriveOrderBookMetrics(snapshot?.orderBook);
  add("ORDER_BOOK_VALID", snapshot?.orderBook?.status === "LIVE" && metrics.valid === true, snapshot?.orderBook?.status === "LIVE" && metrics.valid === true ? "LIVE top-of-book is valid." : metrics.reason ?? "Order book is unavailable or stale.", { status: snapshot?.orderBook?.status ?? "UNAVAILABLE", ...metrics });
  add("SPREAD_LIMIT", metrics.valid === true && metrics.spreadBps <= policy.maxSpreadBps, metrics.valid === true ? `Spot top-of-book spread ${metrics.spreadBps.toFixed(3)} bps; maximum ${policy.maxSpreadBps.toFixed(3)} bps.` : "Spread cannot be calculated from a valid book.", { spreadBps: metrics.spreadBps, maximumBps: policy.maxSpreadBps });
  add("TOP_LIQUIDITY", metrics.valid === true && metrics.topNotional >= policy.minTopNotional, metrics.valid === true ? `Minimum 10-level near-book notional ${metrics.topNotional.toFixed(2)} USDT; required ${policy.minTopNotional.toFixed(2)}.` : "Near-book liquidity cannot be calculated.", { topNotional: metrics.topNotional, bestLevelNotional: metrics.bestLevelNotional ?? null, depthLevels: metrics.depthLevels ?? null, minimum: policy.minTopNotional });
  const marketReceivedAt = timestamp(snapshot?.market?.receivedAt);
  const bookReceivedAt = timestamp(snapshot?.orderBook?.receivedAt);
  const sourceSkewMs = marketReceivedAt === null || bookReceivedAt === null ? null : Math.abs(marketReceivedAt - bookReceivedAt);
  const sameSource = snapshot?.market?.source && snapshot.market.source === snapshot?.orderBook?.source;
  add("SOURCE_COHERENCE", sameSource && sourceSkewMs !== null && sourceSkewMs <= policy.maxSourceSkewMs, sameSource ? sourceSkewMs === null ? "Ticker/order-book receipt timestamps are invalid." : `Ticker/order-book receipt skew ${sourceSkewMs}ms; maximum ${policy.maxSourceSkewMs}ms.` : "Ticker and order book came from different providers.", { sameSource: Boolean(sameSource), receiptSkewMs: sourceSkewMs, maximumMs: policy.maxSourceSkewMs, marketSource: snapshot?.market?.source ?? null, orderBookSource: snapshot?.orderBook?.source ?? null, marketReceivedAt: snapshot?.market?.receivedAt ?? null, orderBookReceivedAt: snapshot?.orderBook?.receivedAt ?? null });

  const eventRisk = snapshot?.eventRisk;
  if (policy.eventRiskEnabled) add("MACRO_NEWS", eventRisk?.status === "CLEAR" && eventRisk.allowed === true, eventRisk?.reason ?? "Economic calendar status is unavailable.", { status: eventRisk?.status ?? "UNAVAILABLE", activeEvents: eventRisk?.activeEvents ?? [], source: eventRisk?.source ?? null });
  else add("MACRO_NEWS", true, "Macro/news gate is disabled and is not claimed as checked.", { status: "DISABLED" }, true);

  return {
    allowed: checks.every((check) => check.status !== "BLOCKED"),
    classification: "AUDITABLE_ENTRY_POLICY_PAPER_AND_MANUAL_ONLY",
    policyVersion: "entry-gates-v0.9.0",
    evaluatedAt: now.toISOString(),
    checks,
    orderBook: metrics,
    eventRisk: eventRisk ?? { status: "UNAVAILABLE" },
  };
}
