import { randomUUID } from "node:crypto";

const TERMINAL_STATES = Object.freeze({
  CORRECTION: new Set(["UNAVAILABLE", "INSUFFICIENT_DATA", "NO_TREND", "NO_CORRECTION", "CORRECTION_END_CONFIRMED"]),
  LEVEL: new Set(["UNAVAILABLE", "CLEAR"]),
});

export class StructureStateService {
  constructor({ database }) { this.database = database; }
  existing(candidate, machineType, machineKey) { return this.database.strategyState(candidate.symbol, candidate.horizonMinutes, machineType, machineKey); }
  transition({ candidate, machineType, machineKey, state, payload, observedAt }) {
    const transition = this.database.applyStrategyTransition({
      symbol: candidate.symbol, horizonMinutes: candidate.horizonMinutes, machineType, machineKey, state, payload,
      eventKey: `${candidate.decisionKey}:${machineType}:${machineKey}:${state}`, observedAt,
    });
    const episode = this.persistEpisode({ candidate, machineType, machineKey, state: transition.state, payload: transition.payload ?? payload, observedAt });
    return episode ? { ...transition, episode } : transition;
  }
  persistEpisode({ candidate, machineType, machineKey, state, payload, observedAt }) {
    if (typeof this.database.activeStructureEpisode !== "function") return null;
    const scope = { symbol: candidate.symbol, horizonMinutes: candidate.horizonMinutes, machineType, machineKey };
    let active = this.database.activeStructureEpisode(scope);
    const previousLevelPrice = active?.context?.level?.price;
    const incomingLevelPrice = payload?.level?.price;
    if (machineType === "LEVEL" && active && Number.isFinite(previousLevelPrice) && Number.isFinite(incomingLevelPrice) && previousLevelPrice !== incomingLevelPrice) {
      this.database.closeStructureEpisode(active.id, {
        eventKey: `${candidate.decisionKey}:${machineType}:${machineKey}:REPLACED:${previousLevelPrice}:${incomingLevelPrice}`,
        toState: "REPLACED", closeReason: "LEVEL_IDENTITY_CHANGED", context: active.context, evidence: { previousLevelPrice, incomingLevelPrice }, closedAt: observedAt,
      });
      active = null;
    }
    const terminal = TERMINAL_STATES[machineType]?.has(state) ?? false;
    if (terminal) {
      if (!active) return null;
      this.database.closeStructureEpisode(active.id, {
        eventKey: `${candidate.decisionKey}:${machineType}:${machineKey}:CLOSED:${state}`,
        toState: state, closeReason: `TERMINAL_${state}`, context: payload, evidence: payload, closedAt: observedAt,
      });
      return this.database.structureEpisodeByKey(active.episodeKey);
    }
    if (!active) {
      const id = randomUUID();
      const episodeKey = `${candidate.strategyVersion ?? "unknown"}:${candidate.symbol}:${candidate.horizonMinutes}:${machineType}:${machineKey}:${observedAt}`;
      this.database.createStructureEpisode({
        id, episodeKey, ...scope, structureType: machineType === "LEVEL" ? machineKey.split(":")[1]?.toUpperCase() ?? "LEVEL" : "CORRECTION",
        direction: ["UP", "DOWN"].includes(candidate.setupDirection) ? candidate.setupDirection : "NEUTRAL", state,
        strategyName: candidate.strategyName ?? "completed-candle-mtf-entry-gates", strategyVersion: candidate.strategyVersion ?? "0.9.0",
        context: payload, openedAt: observedAt,
      }, { eventKey: `${candidate.decisionKey}:${machineType}:${machineKey}:OPENED:${state}`, eventType: "OPENED", toState: state, evidence: payload, observedAt });
      return this.database.structureEpisodeByKey(episodeKey);
    }
    if (active.state !== state) this.database.recordStructureEpisodeEvent({
      eventKey: `${candidate.decisionKey}:${machineType}:${machineKey}:TRANSITION:${active.state}:${state}`,
      episodeId: active.id, eventType: "TRANSITION", toState: state, evidence: payload, context: payload, observedAt,
    });
    return this.database.structureEpisodeByKey(active.episodeKey);
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
    const previousPrice = previous?.payload?.level?.price;
    const sameLevel = Number.isFinite(previousPrice) && previousPrice === level.price;
    const stickyBreak = sameLevel && previous?.state === "BREAK_CONFIRMED" && !["REJECTED", "TESTING"].includes(incomingState);
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
