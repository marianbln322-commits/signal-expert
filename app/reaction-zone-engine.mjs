const CLASSIFICATION = "CONSERVATIVE_REACTION_ZONE_NOT_REVERSAL_OR_STAKE_ADVICE";
const DISCLAIMER = "Not guaranteed, not an exact reversal level, and never a reason to increase stake.";
const STATUSES = Object.freeze(["UNAVAILABLE", "MONITORING", "TESTING_ZONE", "REJECTION_CONFIRMED", "BREAKOUT_CONFIRMED"]);

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function isoTimestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function blocker(code, timeframe, observed, required, reason, evidence = null) {
  return { code, source: "REACTION_ZONE_ENGINE", timeframe, observed, required, reason, evidence };
}

function structuralEvidence(candidate, timeframe) {
  const structure = candidate?.structureFeatures?.[timeframe] ?? null;
  if (!structure) return null;
  return {
    recentFvgs: structure.recentFvgs ?? null,
    fvgRetests: structure.fvgRetests ?? null,
    invertedFvgs: structure.invertedFvgs ?? null,
    liquiditySweeps: structure.liquiditySweeps ?? null,
    marketStructureShifts: structure.marketStructureShifts ?? null,
  };
}

function buildSide({ side, candidate, completedOneMinuteCandles, atrValue, referencePrice, orderFlow, orderBookMetrics, observedAt }) {
  const ceiling = side === "ceiling";
  const levelKey = ceiling ? "resistance" : "support";
  const role = ceiling ? "CEILING" : "FLOOR";
  const potentialDirection = ceiling ? "DOWN" : "UP";
  const rejectionPattern = ceiling ? "UPPER_REJECTION" : "LOWER_REJECTION";
  const farEdgeName = ceiling ? "upper" : "lower";
  const level = candidate?.levels?.[levelKey] ?? null;
  const anchor = level?.price;
  const source = typeof level?.source === "string" && level.source ? level.source : null;
  const timeframe = typeof level?.timeframe === "string" && level.timeframe ? level.timeframe : null;
  const candles = Array.isArray(completedOneMinuteCandles)
    ? completedOneMinuteCandles.filter((candle) => candle?.closed === true)
    : [];
  const latest = candles.at(-1) ?? null;
  const latestCloseAt = isoTimestamp(latest?.closeTime);
  const blockers = [];
  if (!finitePositive(anchor)) blockers.push(blocker("MISSING_ZONE_ANCHOR", timeframe, anchor ?? null, "finite positive nearest level", `Nearest ${levelKey} anchor is required.`, level));
  if (!finitePositive(referencePrice)) blockers.push(blocker("MISSING_REFERENCE_PRICE", timeframe, referencePrice ?? null, "finite positive completed 1m reference", "A completed 1m reference price is required for exact distance.", { referencePrice }));
  if (!finitePositive(atrValue)) blockers.push(blocker("MISSING_ATR", "1m", atrValue ?? null, "finite positive ATR14", "Completed 1m ATR14 is required to construct the conservative zone.", { atrValue }));
  if (!source) blockers.push(blocker("MISSING_LEVEL_SOURCE", timeframe, source, "attributed level source", `Nearest ${levelKey} source metadata is required.`, level));
  if (!timeframe) blockers.push(blocker("MISSING_LEVEL_TIMEFRAME", null, timeframe, "level timeframe", `Nearest ${levelKey} timeframe metadata is required.`, level));
  if (!latest || !latestCloseAt) blockers.push(blocker("MISSING_COMPLETED_1M_CANDLE", "1m", latestCloseAt, "latest completed 1m candle", "A completed 1m candle is required to evaluate zone interaction.", { completedCandles: candles.length }));

  const candidateDirection = candidate?.direction ?? candidate?.canonicalVerdict?.rawDirection ?? candidate?.setupDirection ?? "NEUTRAL";
  const base = {
    classification: CLASSIFICATION,
    role,
    potentialDirection,
    status: "UNAVAILABLE",
    anchor: finitePositive(anchor) ? anchor : null,
    zone: { lower: null, upper: null, midpoint: finitePositive(anchor) ? anchor : null, widthAtr: 0.15 },
    reference: { price: finitePositive(referencePrice) ? referencePrice : null, observedAt: observedAt ?? latestCloseAt, relation: null, distanceToZone: { price: null, bps: null, atr: null }, distanceToAnchor: { price: null, bps: null, atr: null }, distanceBps: null, distanceAtr: null },
    source,
    timeframe,
    confirmations: {
      zoneTouch: { status: "UNAVAILABLE", confirmed: false, observedAt: latestCloseAt, evidence: latest },
      rejection: { status: "UNAVAILABLE", confirmed: false, requiredPattern: rejectionPattern, observedPattern: null, evidence: [] },
      orderFlow: { status: "UNAVAILABLE", confirmed: false, requiredDirection: potentialDirection, observedDirection: "NEUTRAL", live: orderFlow?.status === "LIVE", evidence: null },
      breakout: { status: "UNAVAILABLE", confirmed: false, evidence: null },
    },
    potentialSetup: {
      available: false,
      direction: potentialDirection,
      candidateDirection,
      requirements: [],
      notGuaranteed: true,
    },
    invalidation: { condition: ceiling ? "COMPLETED_1M_CLOSE_ABOVE_ZONE_UPPER" : "COMPLETED_1M_CLOSE_BELOW_ZONE_LOWER", price: null, timeframe: "1m", triggered: false },
    blockers,
    nextAction: "Wait for complete attributed zone inputs; do not infer a reversal.",
    disclaimer: DISCLAIMER,
    observedAt: observedAt ?? latestCloseAt,
    evidence: {
      levelInteraction: candidate?.levelInteractions?.[levelKey] ?? level?.interaction ?? null,
      structural: structuralEvidence(candidate, timeframe),
      triggerPatterns: candidate?.technicalFeatures?.oneMinuteTrigger?.patterns ?? [],
      orderBook: orderBookMetrics ?? null,
    },
  };
  if (blockers.length) return base;

  const halfWidth = atrValue * 0.15;
  const lower = anchor - halfWidth;
  const upper = anchor + halfWidth;
  const midpointDistance = Math.abs(referencePrice - anchor);
  const insideZone = referencePrice >= lower && referencePrice <= upper;
  const relation = insideZone ? "INSIDE" : referencePrice < lower ? "BELOW" : "ABOVE";
  const distanceToZone = insideZone ? 0 : referencePrice < lower ? lower - referencePrice : referencePrice - upper;
  const touched = latest.low <= upper && latest.high >= lower;
  const trigger = candidate?.technicalFeatures?.oneMinuteTrigger ?? {};
  const triggerMatchesLatest = isoTimestamp(trigger.candleCloseTime) === latestCloseAt;
  const matchingPatterns = triggerMatchesLatest
    ? (trigger.patterns ?? []).filter((pattern) => pattern?.name === rejectionPattern && pattern?.direction === potentialDirection)
    : [];
  const rejectionConfirmed = touched && matchingPatterns.length > 0;
  const engineOrderFlow = (candidate?.technicalFeatures?.engine?.components ?? []).find((component) => component?.key === "orderFlow") ?? null;
  const orderFlowLive = orderFlow?.status === "LIVE";
  const orderFlowConfirmed = orderFlowLive && engineOrderFlow?.available === true && engineOrderFlow.direction === potentialDirection;
  const interaction = candidate?.levelInteractions?.[levelKey] ?? level?.interaction ?? null;
  const correctionInteraction = candidate?.correction?.levelInteraction ?? null;
  const correctionKindMatches = correctionInteraction?.kind === level?.role || correctionInteraction?.kind === role.replace("CEILING", "RESISTANCE").replace("FLOOR", "SUPPORT");
  const correctionBreak = correctionKindMatches && [correctionInteraction?.status, candidate?.correction?.status]
    .some((status) => ["BREAK_CONFIRMED", "LOCAL_LEVEL_BREAK_CONFIRMED"].includes(status));
  const interactionBreak = [interaction?.status, level?.interaction?.status]
    .some((status) => ["BREAK_CONFIRMED", "LOCAL_LEVEL_BREAK_CONFIRMED"].includes(status)) || correctionBreak;
  const lastTwo = candles.slice(-2);
  const latestCloseBeyond = ceiling ? latest.close > upper : latest.close < lower;
  const twoClosesBeyond = lastTwo.length === 2 && lastTwo.every((candle) => ceiling ? candle.close > upper : candle.close < lower);
  const breakoutConfirmed = interactionBreak || twoClosesBeyond;
  const pendingBreakout = !breakoutConfirmed && latestCloseBeyond;
  const strictReaction = !breakoutConfirmed && !pendingBreakout && touched && rejectionConfirmed && orderFlowConfirmed;
  const status = breakoutConfirmed ? "BREAKOUT_CONFIRMED" : strictReaction ? "REJECTION_CONFIRMED" : touched || pendingBreakout ? "TESTING_ZONE" : "MONITORING";
  const requirements = [
    { code: "ZONE_TOUCH", satisfied: touched, required: "latest completed 1m candle overlaps the zone", observed: touched },
    { code: "EXPLICIT_REJECTION_PATTERN", satisfied: rejectionConfirmed, required: rejectionPattern, observed: matchingPatterns.map((pattern) => pattern.name) },
    { code: "LIVE_ORDER_FLOW_DIRECTION", satisfied: orderFlowConfirmed, required: `LIVE order flow confirming ${potentialDirection}`, observed: { status: orderFlow?.status ?? "UNAVAILABLE", direction: engineOrderFlow?.direction ?? "NEUTRAL" } },
    { code: "NO_CONFIRMED_BREAKOUT", satisfied: !breakoutConfirmed, required: "no confirmed completed-close breakout", observed: breakoutConfirmed },
  ];
  const confirmationBlockers = [];
  if (breakoutConfirmed) confirmationBlockers.push(blocker("REACTION_ZONE_INVALIDATED_BY_BREAKOUT", "1m", { interactionStatus: interaction?.status ?? null, twoClosesBeyond }, "no confirmed breakout beyond far edge", `${role} reaction monitoring is invalidated by a confirmed breakout.`, { interaction, correctionInteraction, lastTwoCloses: lastTwo.map((candle) => candle.close), farEdge: ceiling ? upper : lower }));
  else {
    if (!touched) confirmationBlockers.push(blocker("ZONE_NOT_TOUCHED", "1m", { low: latest.low, high: latest.high }, { lower, upper }, "Latest completed 1m candle has not overlapped the zone.", latest));
    if (!rejectionConfirmed) confirmationBlockers.push(blocker("REJECTION_PATTERN_NOT_CONFIRMED", "1m", matchingPatterns.map((pattern) => pattern.name), rejectionPattern, `Latest completed 1m candle does not contain the required ${rejectionPattern} pattern while overlapping the zone.`, { triggerMatchesLatest, patterns: trigger.patterns ?? [] }));
    if (!orderFlowConfirmed) confirmationBlockers.push(blocker("ORDER_FLOW_REACTION_NOT_CONFIRMED", "LIVE_ORDER_FLOW", { status: orderFlow?.status ?? "UNAVAILABLE", direction: engineOrderFlow?.direction ?? "NEUTRAL" }, { status: "LIVE", direction: potentialDirection }, `LIVE canonical order flow does not confirm the potential ${potentialDirection} reaction.`, { orderFlowStatus: orderFlow?.status ?? null, engineComponent: engineOrderFlow, orderBook: orderBookMetrics ?? null }));
  }
  const nextAction = status === "REJECTION_CONFIRMED"
    ? `Reaction confirmed descriptively; wait for the existing candidate and entry gates, never increase stake because of this zone.`
    : status === "BREAKOUT_CONFIRMED"
      ? `Stop treating this ${role.toLowerCase()} as a reaction zone; wait for completed-candle structure to establish a new attributed level.`
      : pendingBreakout
        ? `One completed 1m close crossed the far edge; wait for a second completed close to confirm breakout or a completed reclaim back into the zone before considering a reaction.`
        : status === "TESTING_ZONE"
          ? `Wait for ${rejectionPattern} on the latest completed 1m candle together with LIVE ${potentialDirection} order-flow confirmation.`
          : `Monitor for a completed 1m overlap; then require ${rejectionPattern} and LIVE ${potentialDirection} order-flow confirmation.`;

  return {
    ...base,
    status,
    zone: { lower, upper, midpoint: anchor, widthAtr: 0.15 },
    reference: { price: referencePrice, observedAt: observedAt ?? latestCloseAt, relation, distanceToZone: { price: distanceToZone, bps: distanceToZone / referencePrice * 10000, atr: distanceToZone / atrValue }, distanceToAnchor: { price: midpointDistance, bps: midpointDistance / referencePrice * 10000, atr: midpointDistance / atrValue }, distanceBps: distanceToZone / referencePrice * 10000, distanceAtr: distanceToZone / atrValue },
    confirmations: {
      zoneTouch: { status: touched ? "CONFIRMED" : "WAITING", confirmed: touched, observedAt: latestCloseAt, evidence: latest },
      rejection: { status: rejectionConfirmed ? "CONFIRMED" : "WAITING", confirmed: rejectionConfirmed, requiredPattern: rejectionPattern, observedPattern: matchingPatterns[0]?.name ?? null, evidence: matchingPatterns },
      orderFlow: { status: orderFlowConfirmed ? "CONFIRMED" : orderFlowLive ? "DIRECTION_NOT_CONFIRMED" : "NOT_LIVE", confirmed: orderFlowConfirmed, requiredDirection: potentialDirection, observedDirection: engineOrderFlow?.direction ?? "NEUTRAL", live: orderFlowLive, evidence: { canonicalComponent: engineOrderFlow, rawStatus: orderFlow?.status ?? null, freshness: orderFlow?.freshness ?? null, orderBook: orderBookMetrics ?? null } },
      breakout: { status: breakoutConfirmed ? "CONFIRMED" : pendingBreakout ? "PENDING_CONFIRMATION" : "NOT_CONFIRMED", confirmed: breakoutConfirmed, pending: pendingBreakout, evidence: { interactionStatus: interaction?.status ?? null, correctionStatus: candidate?.correction?.status ?? null, latestCloseBeyond, twoClosesBeyond, farEdge: ceiling ? upper : lower, lastTwoCloses: lastTwo.map((candle) => candle.close) } },
    },
    potentialSetup: { available: strictReaction, direction: potentialDirection, candidateDirection, requirements, notGuaranteed: true },
    invalidation: { condition: ceiling ? "COMPLETED_1M_CLOSE_ABOVE_ZONE_UPPER" : "COMPLETED_1M_CLOSE_BELOW_ZONE_LOWER", price: ceiling ? upper : lower, timeframe: "1m", triggered: latestCloseBeyond, observedClose: latest.close, observedAt: latestCloseAt },
    blockers: confirmationBlockers,
    nextAction,
  };
}

export function buildReactionZones(input = {}) {
  const observedAt = input.observedAt ?? isoTimestamp(input.completedOneMinuteCandles?.at(-1)?.closeTime);
  const shared = { ...input, observedAt };
  const result = {
    classification: CLASSIFICATION,
    observedAt,
    ceiling: buildSide({ ...shared, side: "ceiling" }),
    floor: buildSide({ ...shared, side: "floor" }),
  };
  if (!STATUSES.includes(result.ceiling.status) || !STATUSES.includes(result.floor.status)) throw new Error("Invalid reaction-zone status.");
  return result;
}

export { CLASSIFICATION as REACTION_ZONE_CLASSIFICATION };
