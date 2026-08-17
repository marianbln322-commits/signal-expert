export class StructureStateService {
  constructor({ database }) { this.database = database; }
  existing(candidate, machineType, machineKey) { return this.database.strategyState(candidate.symbol, candidate.horizonMinutes, machineType, machineKey); }
  transition({ candidate, machineType, machineKey, state, payload, observedAt }) {
    return this.database.applyStrategyTransition({
      symbol: candidate.symbol, horizonMinutes: candidate.horizonMinutes, machineType, machineKey, state, payload,
      eventKey: `${candidate.decisionKey}:${machineType}:${machineKey}:${state}`, observedAt,
    });
  }
  correctionTransition(candidate, observedAt) {
    const machineKey = `correction:${candidate.horizonMinutes}`; const previous = this.existing(candidate, "CORRECTION", machineKey);
    const incomingState = candidate.correction?.status ?? "UNAVAILABLE";
    const stickyBreak = previous?.state === "LOCAL_LEVEL_BREAK_CONFIRMED" && incomingState !== "CORRECTION_END_CONFIRMED";
    return this.transition({ candidate, machineType: "CORRECTION", machineKey, state: stickyBreak ? previous.state : incomingState, payload: stickyBreak ? previous.payload : candidate.correction ?? {}, observedAt });
  }
  levelTransition(candidate, kind, observedAt) {
    const level = candidate.levels?.[kind]; const interaction = candidate.levelInteractions?.[kind];
    if (!Number.isFinite(level?.price)) return null;
    const machineKey = `level:${kind}:${level.timeframe ?? "UNKNOWN"}`; const previous = this.existing(candidate, "LEVEL", machineKey);
    const incomingState = interaction?.status ?? "UNAVAILABLE";
    const stickyBreak = previous?.state === "BREAK_CONFIRMED" && !["REJECTED", "TESTING"].includes(incomingState);
    return this.transition({ candidate, machineType: "LEVEL", machineKey, state: stickyBreak ? previous.state : incomingState, payload: stickyBreak ? previous.payload : { kind: kind.toUpperCase(), level, interaction }, observedAt });
  }
  apply(candidate) {
    const observedAt = candidate.timeframeCloseWatermarks?.["1m"] ?? new Date().toISOString();
    const correction = this.correctionTransition(candidate, observedAt);
    const levels = { support: this.levelTransition(candidate, "support", observedAt), resistance: this.levelTransition(candidate, "resistance", observedAt) };
    const persistedCorrection = correction ? { ...(correction.payload ?? {}), status: correction.state } : candidate.correction;
    const persistedInteractions = Object.fromEntries(["support", "resistance"].map((kind) => {
      const persisted = levels[kind]; return [kind, persisted ? { ...(persisted.payload?.interaction ?? {}), status: persisted.state } : candidate.levelInteractions?.[kind] ?? null];
    }));
    const persistedLevels = Object.fromEntries(["support", "resistance"].map((kind) => [kind, levels[kind]?.payload?.level ?? candidate.levels?.[kind] ?? null]));
    return { ...candidate, correction: persistedCorrection, levels: persistedLevels, levelInteractions: persistedInteractions, persistentState: { correction, levels, classification: "PERSISTED_COMPLETED_CANDLE_STATE_MACHINE" } };
  }
}
