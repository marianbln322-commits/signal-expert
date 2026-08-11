import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const positionColumns = `id,symbol,direction,horizon_minutes AS horizonMinutes,stake,payout_rate AS payoutRate,entry_price AS entryPrice,opened_at AS openedAt,resolves_at AS resolvesAt,status,settlement_price AS settlementPrice,settled_at AS settledAt,pnl,signal_version AS signalVersion,source_name AS sourceName,source_timestamp AS sourceTimestamp,settlement_reason AS settlementReason,origin,decision_id AS decisionId,strategy_name AS strategyName,strategy_version AS strategyVersion,quality_score AS qualityScore,stake_profile AS stakeProfile,recovery_stage AS recoveryStage`;
const decisionColumns = `id,decision_key AS decisionKey,symbol,horizon_minutes AS horizonMinutes,direction,quality_score AS qualityScore,quality_band AS qualityBand,timeframe_watermarks_json AS timeframeWatermarksJson,strategy_name AS strategyName,strategy_version AS strategyVersion,profile,stage,action,stake,reasons_json AS reasonsJson,paper_position_id AS paperPositionId,created_at AS createdAt,updated_at AS updatedAt`;

export class Database {
  constructor(path, migrationDirectory) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path; this.migrationDirectory = migrationDirectory;
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }
  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = this.db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?");
    const record = this.db.prepare("INSERT INTO schema_migrations(name) VALUES(?)");
    for (const file of readdirSync(this.migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
      if (applied.get(file)) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try { this.db.exec(readFileSync(resolve(this.migrationDirectory, file), "utf8")); record.run(file); this.db.exec("COMMIT"); }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  health() { return { available: true, mode: "sqlite", path: this.path, error: null }; }
  insertSignal(symbol, analysis, sourceTimestamp) {
    this.db.prepare("INSERT INTO signal_snapshots(symbol,direction,up_score,down_score,model_version,source_timestamp,calculated_at,payload_json) VALUES(?,?,?,?,?,?,?,?)").run(symbol, analysis.direction, analysis.upScore, analysis.downScore, analysis.modelVersion, sourceTimestamp, analysis.calculatedAt, JSON.stringify(analysis));
  }
  upsertPosition(position) {
    this.db.prepare(`INSERT INTO paper_positions(id,symbol,direction,horizon_minutes,stake,payout_rate,entry_price,opened_at,resolves_at,status,settlement_price,settled_at,pnl,signal_version,source_name,source_timestamp,settlement_reason,origin,decision_id,strategy_name,strategy_version,quality_score,stake_profile,recovery_stage)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,settlement_price=excluded.settlement_price,settled_at=excluded.settled_at,pnl=excluded.pnl,settlement_reason=excluded.settlement_reason`).run(
      position.id, position.symbol, position.direction, position.horizonMinutes, position.stake, position.payoutRate, position.entryPrice,
      position.openedAt, position.resolvesAt, position.status, position.settlementPrice, position.settledAt, position.pnl,
      position.signalVersion, position.sourceName, position.sourceTimestamp, position.settlementReason ?? null,
      position.origin ?? "MANUAL", position.decisionId ?? null, position.strategyName ?? null, position.strategyVersion ?? null,
      position.qualityScore ?? null, position.stakeProfile ?? null, position.recoveryStage ?? null,
    );
  }
  commitAutonomousOpen(position, { reasons, state, updatedAt }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.upsertPosition(position);
      this.updateAutonomousDecision(position.decisionId, { action: "OPEN", stake: position.stake, reasons, paperPositionId: position.id, updatedAt });
      this.saveAutonomousState({ ...state, currentPositionId: position.id, updatedAt });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  positions() { return this.db.prepare(`SELECT ${positionColumns} FROM paper_positions ORDER BY opened_at DESC`).all(); }
  openAutonomousPosition() { return this.db.prepare(`SELECT ${positionColumns} FROM paper_positions WHERE origin='AUTONOMOUS' AND status='OPEN' ORDER BY opened_at LIMIT 1`).get() ?? null; }
  autonomousPositions() { return this.db.prepare(`SELECT ${positionColumns} FROM paper_positions WHERE origin='AUTONOMOUS' ORDER BY opened_at DESC`).all(); }
  createAutonomousDecision(decision) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO autonomous_decisions(id,decision_key,symbol,horizon_minutes,direction,quality_score,quality_band,timeframe_watermarks_json,strategy_name,strategy_version,profile,stage,action,stake,reasons_json,paper_position_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      decision.id, decision.decisionKey, decision.symbol, decision.horizonMinutes, decision.direction, decision.qualityScore, decision.qualityBand,
      JSON.stringify(decision.timeframeCloseWatermarks), decision.strategyName, decision.strategyVersion, decision.profile, decision.stage,
      decision.action, decision.stake ?? null, JSON.stringify(decision.reasons ?? []), decision.paperPositionId ?? null, decision.createdAt, decision.updatedAt,
    );
    return result.changes === 1;
  }
  decodeAutonomousDecision(row) { return row ? { ...row, timeframeCloseWatermarks: JSON.parse(row.timeframeWatermarksJson), reasons: JSON.parse(row.reasonsJson) } : null; }
  autonomousDecisionByKey(decisionKey) { return this.decodeAutonomousDecision(this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions WHERE decision_key=?`).get(decisionKey)); }
  autonomousDecisionById(id) { return this.decodeAutonomousDecision(this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions WHERE id=?`).get(id)); }
  latestAutonomousDecision() {
    return this.decodeAutonomousDecision(this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get());
  }
  updateAutonomousDecision(id, { action, stake = null, reasons = [], paperPositionId = null, updatedAt }) {
    const result = this.db.prepare("UPDATE autonomous_decisions SET action=?,stake=?,reasons_json=?,paper_position_id=?,updated_at=? WHERE id=?").run(action, stake, JSON.stringify(reasons), paperPositionId, updatedAt, id);
    if (result.changes !== 1) throw new Error("Autonomous decision does not exist.");
  }
  autonomousState(profile = "ADAPTIVE_CAPPED") {
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO autonomous_state(id,status,profile,recovery_stage,previous_loss,updated_at) VALUES(1,'RUNNING',?,0,0,?)").run(profile, now);
    return this.db.prepare("SELECT status,profile,recovery_stage AS recoveryStage,previous_loss AS previousLoss,pause_reason AS pauseReason,current_position_id AS currentPositionId,last_settled_position_id AS lastSettledPositionId,updated_at AS updatedAt FROM autonomous_state WHERE id=1").get();
  }
  saveAutonomousState(state) {
    this.db.prepare(`UPDATE autonomous_state SET status=?,profile=?,recovery_stage=?,previous_loss=?,pause_reason=?,current_position_id=?,last_settled_position_id=?,updated_at=? WHERE id=1`).run(
      state.status, state.profile, state.recoveryStage, state.previousLoss, state.pauseReason ?? null, state.currentPositionId ?? null, state.lastSettledPositionId ?? null, state.updatedAt,
    );
    return this.autonomousState(state.profile);
  }
  autonomousPerformance({ now = new Date(), profile = null, strategyVersion = null } = {}) {
    const day = now.toISOString().slice(0, 10);
    const rows = this.db.prepare("SELECT status,pnl,settled_at AS settledAt,stake,stake_profile AS stakeProfile,strategy_version AS strategyVersion FROM paper_positions WHERE origin='AUTONOMOUS' ORDER BY settled_at").all();
    const settled = rows.filter((row) => row.status !== "OPEN");
    const scoped = settled.filter((row) => (!profile || row.stakeProfile === profile) && (!strategyVersion || row.strategyVersion === strategyVersion));
    const daily = scoped.filter((row) => row.settledAt?.startsWith(day));
    const summarize = (items) => {
      const wins = items.filter((row) => row.status === "WON").length; const losses = items.filter((row) => row.status === "LOST").length;
      const pnl = items.reduce((sum, row) => sum + (row.pnl ?? 0), 0); const totalStake = items.reduce((sum, row) => sum + row.stake, 0);
      let cumulative = 0; let peak = 0; let maxDrawdown = 0; let consecutiveLosses = 0; let maxConsecutiveLosses = 0;
      for (const row of items) {
        cumulative += row.pnl ?? 0; peak = Math.max(peak, cumulative); maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
        consecutiveLosses = row.status === "LOST" ? consecutiveLosses + 1 : 0; maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutiveLosses);
      }
      return {
        positions: items.length, wins, losses, refunds: items.filter((row) => row.status === "REFUNDED").length,
        winRate: wins + losses ? wins / (wins + losses) : null, pnl, totalStake, roiOnStake: totalStake ? pnl / totalStake : null,
        grossLoss: items.filter((row) => (row.pnl ?? 0) < 0).reduce((sum, row) => sum - row.pnl, 0), maxDrawdown, maxConsecutiveLosses,
      };
    };
    const combinedDaily = settled.filter((row) => row.settledAt?.startsWith(day));
    return { mode: "PAPER_ONLY", scope: { profile, strategyVersion }, day, openPositions: rows.filter((row) => row.status === "OPEN" && (!profile || row.stakeProfile === profile) && (!strategyVersion || row.strategyVersion === strategyVersion)).length, daily: summarize(daily), allTime: summarize(scoped), combinedDaily: summarize(combinedDaily), combinedAllProfiles: summarize(settled) };
  }
  sourceEvent(event) {
    this.db.prepare("INSERT INTO data_source_events(source_name,symbol,status,source_timestamp,received_at,latency_ms,message) VALUES(?,?,?,?,?,?,?)").run(event.sourceName, event.symbol ?? null, event.status, event.sourceTimestamp ?? null, event.receivedAt, event.latencyMs ?? null, event.message ?? null);
  }
  close() { this.db.close(); }
}
