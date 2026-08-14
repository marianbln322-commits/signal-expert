import { randomUUID } from "node:crypto";
import { adaptiveStake } from "./quant.mjs";
const MAX_SETTLEMENT_LAG_MS = 30_000;

export class PaperService {
  constructor({ market, database, settings }) {
    this.market = market; this.database = database; this.settings = settings;
    this.positions = new Map(); this.timer = null; this.settlementListeners = new Set();
  }
  initialize() {
    this.positions.clear();
    for (const position of this.database.positions()) this.positions.set(position.id, position);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.settleDue(), 1000);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  onSettlement(listener) { this.settlementListeners.add(listener); return () => this.settlementListeners.delete(listener); }
  account() {
    const positions = [...this.positions.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt)); const today = new Date().toISOString().slice(0, 10);
    const realizedPnl = positions.reduce((sum, position) => sum + (position.pnl ?? 0), 0);
    const dailyLoss = positions.filter((position) => position.settledAt?.startsWith(today) && (position.pnl ?? 0) < 0).reduce((sum, position) => sum - position.pnl, 0);
    const open = positions.filter((position) => position.status === "OPEN"); const locked = open.reduce((sum, position) => sum + position.stake, 0);
    return { mode: "PAPER", persistence: this.database.health(), initialBankroll: this.settings.initialBankroll, equity: this.settings.initialBankroll + realizedPnl, available: this.settings.initialBankroll + realizedPnl - locked, realizedPnl, dailyLoss, locked, openPositions: open.length, dailyLossLimit: this.settings.dailyLossLimit, payout: { value: this.settings.payoutRate, source: "USER_CONFIGURATION", live: false }, positions };
  }
  validateOpen(input, account) {
    const maxStake = input.symbol === "BTCUSDT" ? this.settings.btcMaxStake : this.settings.ethMaxStake;
    if (account.dailyLoss >= this.settings.dailyLossLimit) throw new Error("Daily paper loss limit reached.");
    if (account.openPositions >= this.settings.maxOpenPositions) throw new Error("Maximum paper positions reached.");
    if (!Number.isFinite(input.stake) || input.stake <= 0 || input.stake > maxStake) throw new Error(`Stake must be between 0 and ${maxStake} USDT.`);
    if (input.stake > account.available) throw new Error("Insufficient paper balance.");
    if ((account.locked + input.stake) / Math.max(account.equity, 1) > 0.35) throw new Error("Correlated paper exposure would exceed 35% of equity.");
  }
  executeTrade(input, metadata) {
    const account = this.account(); this.validateOpen(input, account);
    if (metadata.origin === "AUTONOMOUS" && this.database.openAutonomousPosition()) throw new Error("An autonomous paper position is already open.");
    const snapshot = this.market.snapshot(input.symbol);
    if (!snapshot || !snapshot.health.dataUsable || !snapshot.market.data) throw new Error("Required market/timeframe data is unavailable or stale.");
    const candidate = metadata.candidate ?? snapshot.analysis?.candidates?.find((item) => item.horizonMinutes === input.horizonMinutes && item.direction === input.direction);
    if (!candidate) throw new Error("Entry blocked: no current completed-candle candidate matches this direction and horizon.");
    const now = new Date();
    const entryGate = this.market.evaluateEntry(candidate, now);
    if (!entryGate.allowed) {
      const blocked = entryGate.checks.filter((check) => check.status === "BLOCKED").map((check) => `${check.code}: ${check.reason}`);
      throw new Error(`Entry blocked by current risk policy — ${blocked.join("; ")}`);
    }
    const position = {
      id: randomUUID(), symbol: input.symbol, direction: input.direction, horizonMinutes: input.horizonMinutes, stake: input.stake,
      payoutRate: this.settings.payoutRate, entryPrice: snapshot.market.data.lastPrice, openedAt: now.toISOString(), resolvesAt: new Date(now.getTime() + input.horizonMinutes * 60000).toISOString(),
      status: "OPEN", settlementPrice: null, settledAt: null, pnl: null, settlementReason: null,
      signalVersion: snapshot.analysis?.modelVersion ?? "manual-paper", sourceName: snapshot.market.source, sourceTimestamp: snapshot.market.sourceTimestamp,
      origin: metadata.origin, decisionId: metadata.decisionId ?? null, strategyName: metadata.strategyName ?? null,
      strategyVersion: metadata.strategyVersion ?? null, qualityScore: metadata.qualityScore ?? null,
      stakeProfile: metadata.stakeProfile ?? null, recoveryStage: metadata.recoveryStage ?? null,
      entryGate,
    };
    if (metadata.origin === "AUTONOMOUS") {
      this.database.commitAutonomousOpen(position, { reasons: metadata.decisionReasons, state: metadata.state, updatedAt: now.toISOString() });
    } else this.database.upsertPosition(position);
    this.positions.set(position.id, position);
    return position;
  }
  open(input) { return this.executeTrade(input, { origin: "MANUAL" }); }
  openAutonomous(input, metadata) {
    if (!metadata || typeof metadata.decisionId !== "string" || !metadata.decisionId || !Number.isInteger(metadata.qualityScore) || !metadata.strategyName || !metadata.strategyVersion || !metadata.stakeProfile || !Number.isInteger(metadata.recoveryStage) || !metadata.state || !Array.isArray(metadata.decisionReasons) || !metadata.candidate) throw new Error("Invalid trusted autonomous position metadata.");
    return this.executeTrade(input, { ...metadata, origin: "AUTONOMOUS" });
  }
  riskQuote(input) {
    const account = this.account(); const snapshot = this.market.snapshot(input.symbol); const analysis = snapshot?.analysis;
    const calibratedProbability = analysis?.calibrationStatus === "CALIBRATED" ? analysis.calibratedProbability : null;
    const price = snapshot?.market.data?.lastPrice ?? 0; const atr = analysis?.timeframes?.["1m"]?.indicators?.atr14 ?? 0; const atrFraction = price > 0 ? atr / price : Infinity;
    return adaptiveStake({ bankroll: account.equity, baseStake: input.baseStake, cumulativeLoss: input.cumulativeLoss, targetProfit: input.targetProfit, payoutRate: this.settings.payoutRate, estimatedProbability: calibratedProbability, maxStake: input.symbol === "BTCUSDT" ? this.settings.btcMaxStake : this.settings.ethMaxStake, maxBankrollFraction: 0.15, dailyLoss: account.dailyLoss, dailyLossLimit: this.settings.dailyLossLimit, openPositions: account.openPositions, maxOpenPositions: this.settings.maxOpenPositions, dataHealthy: snapshot?.health.dataUsable === true, volatilityRegime: atrFraction > 0.015 ? "EXTREME" : atrFraction > 0.008 ? "HIGH" : "NORMAL", correlatedExposureFraction: account.locked / Math.max(account.equity, 1) });
  }
  settleDue() {
    const now = Date.now();
    for (const position of this.positions.values()) {
      const resolvesAt = new Date(position.resolvesAt).getTime(); if (position.status !== "OPEN" || resolvesAt > now) continue;
      const snapshot = this.market.snapshot(position.symbol); if (!snapshot?.market.data || snapshot.health.market !== "LIVE") continue;
      const sourceTime = new Date(snapshot.market.sourceTimestamp).getTime(); if (!Number.isFinite(sourceTime) || sourceTime < resolvesAt) continue;
      const lag = sourceTime - resolvesAt; const settlement = snapshot.market.data.lastPrice;
      const settled = { ...position, settledAt: new Date().toISOString(), settlementPrice: settlement };
      if (lag > MAX_SETTLEMENT_LAG_MS) { settled.status = "REFUNDED"; settled.pnl = 0; settled.settlementReason = `No verified ticker within ${MAX_SETTLEMENT_LAG_MS / 1000}s of resolution.`; }
      else {
        const tied = settlement === position.entryPrice; const won = position.direction === "UP" ? settlement > position.entryPrice : settlement < position.entryPrice;
        settled.status = tied ? "REFUNDED" : won ? "WON" : "LOST"; settled.pnl = tied ? 0 : won ? position.stake * position.payoutRate : -position.stake;
        settled.settlementReason = tied ? "Entry and settlement prices were equal." : "Settled from first verified ticker within the allowed lag.";
      }
      this.database.upsertPosition(settled);
      this.positions.set(settled.id, settled);
      for (const listener of this.settlementListeners) {
        try { listener(settled); } catch (error) { console.error(JSON.stringify({ level: "error", event: "paper_settlement_listener_failed", message: error instanceof Error ? error.message : "Unknown error" })); }
      }
    }
  }
}
