import { randomUUID } from "node:crypto";
import { AUTONOMOUS_STRATEGY_VERSION, planAutonomousStake, STAKE_PROFILES } from "./quant.mjs";

export class AutonomousService {
  constructor({ market, paper, database, settings }) {
    this.market = market; this.paper = paper; this.database = database; this.settings = settings;
    this.state = null; this.timer = null; this.busy = false; this.nextScanAt = null; this.unsubscribeSettlement = null;
  }
  start() {
    this.state = this.database.autonomousState(this.settings.profile);
    this.resumeExpiredDailyPause(); this.reconcileSettlements(); this.reconcileConfiguredProfile();
    this.unsubscribeSettlement = this.paper.onSettlement((position) => this.handleSettlement(position));
    if (this.settings.enabled) {
      this.nextScanAt = new Date(Date.now() + this.settings.scanMs).toISOString();
      this.timer = setInterval(() => this.scan().catch((error) => console.error(JSON.stringify({ level: "error", event: "autonomous_scan_failed", message: error instanceof Error ? error.message : "Unknown error" }))), this.settings.scanMs);
    }
  }
  reconcileConfiguredProfile() {
    if (!this.state || this.state.profile === this.settings.profile || this.database.openAutonomousPosition()) return;
    const exhausted = this.state.pauseReason?.startsWith("Observed ladder final stage lost");
    this.persistState({ profile: this.settings.profile, recoveryStage: 0, previousLoss: 0, ...(exhausted ? { status: "RUNNING", pauseReason: null } : {}) });
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.nextScanAt = null;
    if (this.unsubscribeSettlement) this.unsubscribeSettlement();
    this.unsubscribeSettlement = null;
  }
  persistState(patch = {}) {
    this.state = this.database.saveAutonomousState({ ...this.state, ...patch, updatedAt: new Date().toISOString() });
    return this.state;
  }
  pause(reason = "Paused by operator.") { return this.persistState({ status: "PAUSED", pauseReason: reason }); }
  resume() {
    const exhausted = this.state?.pauseReason?.startsWith("Observed ladder final stage lost");
    return this.persistState({ status: "RUNNING", pauseReason: null, ...(exhausted ? { recoveryStage: 0, previousLoss: 0 } : {}) });
  }
  resumeExpiredDailyPause() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state?.status === "PAUSED" && this.state.updatedAt?.slice(0, 10) !== today && this.state.pauseReason?.startsWith("Daily autonomous paper")) this.resume();
  }
  setAction(action) {
    if (action === "pause") this.pause();
    else if (action === "resume") this.resume();
    else throw new Error("Invalid autonomous state action");
    return this.status();
  }
  reconcileSettlements() {
    const positions = this.database.autonomousPositions();
    const open = positions.find((position) => position.status === "OPEN");
    if (open && this.state.currentPositionId !== open.id) this.persistState({ currentPositionId: open.id });
    if (!open && this.state.currentPositionId) {
      const settled = positions.find((position) => position.id === this.state.currentPositionId);
      if (settled && settled.status !== "OPEN") this.handleSettlement(settled);
      else this.persistState({ currentPositionId: null });
    }
  }
  handleSettlement(position) {
    if (position.origin !== "AUTONOMOUS" || this.state?.lastSettledPositionId === position.id) return;
    const patch = { currentPositionId: null, lastSettledPositionId: position.id };
    if (position.status === "WON") Object.assign(patch, { recoveryStage: 0, previousLoss: 0 });
    if (position.status === "LOST") {
      const loss = Math.abs(position.pnl ?? position.stake);
      if (this.state.profile === STAKE_PROFILES.OBSERVED_10_30_90_270) {
        if (this.state.recoveryStage >= this.settings.observedLadder.length - 1) Object.assign(patch, { status: "PAUSED", pauseReason: "Observed ladder final stage lost; operator resume is required.", previousLoss: loss });
        else Object.assign(patch, { recoveryStage: this.state.recoveryStage + 1, previousLoss: loss });
      } else if (this.state.profile === STAKE_PROFILES.ADAPTIVE_CAPPED) {
        Object.assign(patch, this.state.recoveryStage === 0 ? { recoveryStage: 1, previousLoss: loss } : { recoveryStage: 0, previousLoss: 0 });
      } else Object.assign(patch, { recoveryStage: 0, previousLoss: loss });
    }
    this.persistState(patch); this.reconcileConfiguredProfile();
  }
  scopedPerformance() { return this.database.autonomousPerformance({ profile: this.state?.profile ?? this.settings.profile, strategyVersion: AUTONOMOUS_STRATEGY_VERSION }); }
  performance() {
    return { ...this.scopedPerformance(), targets: { dailyProfit: this.settings.dailyProfitTarget, dailyLoss: this.settings.dailyLossLimit } };
  }
  status() {
    const openPosition = this.database.openAutonomousPosition();
    const latestDecision = openPosition?.decisionId ? this.database.autonomousDecisionById(openPosition.decisionId) : this.database.latestAutonomousDecision();
    return {
      mode: "PAPER_ONLY", liveExecutionAvailable: false, enabled: this.settings.enabled, schedulerBusy: this.busy,
      nextScanAt: this.nextScanAt, state: this.state, openPosition, latestDecision,
      policy: {
        profile: this.state?.profile ?? this.settings.profile, strategyVersion: AUTONOMOUS_STRATEGY_VERSION, symbols: this.settings.symbols, horizonsMinutes: this.settings.horizons,
        scanMs: this.settings.scanMs, baseStakeFraction: this.settings.baseFraction, maxStakeFraction: this.settings.maxFraction,
        absoluteStakeCap: this.settings.absoluteCap, qualityThresholds: this.settings.thresholds, observedLadder: this.settings.observedLadder,
        dailyProfitTarget: this.settings.dailyProfitTarget, dailyLossLimit: this.settings.dailyLossLimit,
      },
    };
  }
  async scan() {
    if (this.busy) return;
    this.busy = true;
    this.nextScanAt = new Date(Date.now() + this.settings.scanMs).toISOString();
    try {
      this.resumeExpiredDailyPause(); this.reconcileSettlements(); this.reconcileConfiguredProfile();
      if (!this.settings.enabled || this.state.status === "PAUSED") return;
      const performance = this.scopedPerformance();
      if (performance.daily.pnl >= this.settings.dailyProfitTarget) { this.pause("Daily autonomous paper profit target reached."); return; }
      if (performance.combinedDaily.grossLoss >= this.settings.dailyLossLimit) { this.pause("Daily autonomous paper loss stop reached across all profiles."); return; }
      const existingOpen = this.database.openAutonomousPosition();
      if (existingOpen) {
        if (this.state.currentPositionId !== existingOpen.id) this.persistState({ currentPositionId: existingOpen.id });
        return;
      }
      const candidates = [];
      for (const symbol of this.settings.symbols) {
        const snapshot = this.market.snapshot(symbol);
        if (!snapshot?.health.dataUsable || !snapshot.analysis?.candidates) continue;
        for (const candidate of snapshot.analysis.candidates) if (this.settings.horizons.includes(candidate.horizonMinutes)) candidates.push(candidate);
      }
      candidates.sort((left, right) => right.qualityScore - left.qualityScore || this.settings.symbols.indexOf(left.symbol) - this.settings.symbols.indexOf(right.symbol) || this.settings.horizons.indexOf(left.horizonMinutes) - this.settings.horizons.indexOf(right.horizonMinutes) || left.decisionKey.localeCompare(right.decisionKey));
      const fresh = [];
      for (const candidate of candidates) {
        const now = new Date().toISOString(); const id = randomUUID();
        const created = this.database.createAutonomousDecision({ ...candidate, id, profile: this.state.profile, stage: this.state.recoveryStage, action: "WAIT", stake: null, reasons: candidate.reasons, createdAt: now, updatedAt: now });
        if (created) fresh.push({ ...candidate, id });
      }
      const eligible = fresh.filter((item) => item.direction === "UP" || item.direction === "DOWN");
      if (!eligible.length) return;
      const account = this.paper.account(); const exposureHeadroom = Math.max(0, account.equity * 0.35 - account.locked);
      const dailyLossHeadroom = Math.max(0, this.settings.dailyLossLimit - performance.combinedDaily.grossLoss);
      for (let index = 0; index < eligible.length; index += 1) {
        const candidate = eligible[index];
        const plan = planAutonomousStake({
          candidate, profile: this.state.profile, stage: this.state.recoveryStage, previousLoss: this.state.previousLoss,
          bankroll: account.equity, payoutRate: this.settings.payoutRate, available: account.available, exposureHeadroom, dailyLossHeadroom,
          baseFraction: this.settings.baseFraction, maxFraction: this.settings.maxFraction, absoluteCap: this.settings.absoluteCap,
          thresholds: this.settings.thresholds, observedLadder: this.settings.observedLadder,
        });
        if (!plan.allowed) {
          this.database.updateAutonomousDecision(candidate.id, { action: "BLOCKED", reasons: [...candidate.reasons, ...plan.reasons], updatedAt: new Date().toISOString() });
          continue;
        }
        try {
          const decisionReasons = [...candidate.reasons, ...plan.reasons];
          const position = this.paper.openAutonomous({ symbol: candidate.symbol, direction: candidate.direction, horizonMinutes: candidate.horizonMinutes, stake: plan.stake }, {
            decisionId: candidate.id, strategyName: candidate.strategyName, strategyVersion: candidate.strategyVersion,
            qualityScore: candidate.qualityScore, stakeProfile: this.state.profile, recoveryStage: this.state.recoveryStage,
            decisionReasons, state: this.state,
          });
          this.state = { ...this.state, currentPositionId: position.id, updatedAt: position.openedAt };
          const skippedAt = new Date().toISOString();
          for (const skipped of eligible.slice(index + 1)) this.database.updateAutonomousDecision(skipped.id, { action: "BLOCKED", reasons: [...skipped.reasons, "Not selected because a higher-ranked autonomous setup opened first."], updatedAt: skippedAt });
          return;
        } catch (error) {
          this.database.updateAutonomousDecision(candidate.id, { action: "BLOCKED", reasons: [...candidate.reasons, error instanceof Error ? error.message : "Paper open failed."], updatedAt: new Date().toISOString() });
        }
      }
    } finally { this.busy = false; }
  }
}
