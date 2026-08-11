import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const positionColumns = `id,symbol,direction,horizon_minutes AS horizonMinutes,stake,payout_rate AS payoutRate,entry_price AS entryPrice,opened_at AS openedAt,resolves_at AS resolvesAt,status,settlement_price AS settlementPrice,settled_at AS settledAt,pnl,signal_version AS signalVersion,source_name AS sourceName,source_timestamp AS sourceTimestamp,settlement_reason AS settlementReason,origin,decision_id AS decisionId,strategy_name AS strategyName,strategy_version AS strategyVersion,quality_score AS qualityScore,stake_profile AS stakeProfile,recovery_stage AS recoveryStage`;
const decisionColumns = `id,decision_key AS decisionKey,symbol,horizon_minutes AS horizonMinutes,direction,quality_score AS qualityScore,quality_band AS qualityBand,timeframe_watermarks_json AS timeframeWatermarksJson,strategy_name AS strategyName,strategy_version AS strategyVersion,profile,stage,action,stake,reasons_json AS reasonsJson,details_json AS detailsJson,invalidation_json AS invalidationJson,invalidation_price AS invalidationPrice,paper_position_id AS paperPositionId,created_at AS createdAt,updated_at AS updatedAt`;

function decodeJson(value, fallback) {
  try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function wilson95(wins, sample) {
  if (!sample) return { lower: null, upper: null };
  const z = 1.959963984540054; const proportion = wins / sample; const denominator = 1 + z ** 2 / sample;
  const center = (proportion + z ** 2 / (2 * sample)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z ** 2 / (4 * sample)) / sample) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

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
    const details = decision.details ?? {
      volatilityRegime: decision.volatilityRegime ?? null,
      confluenceComponents: decision.confluenceComponents ?? [],
      structureFeatures: decision.structureFeatures ?? {},
      qualityDefinition: decision.qualityDefinition ?? null,
    };
    const invalidation = typeof decision.invalidationDetails === "object" && decision.invalidationDetails !== null
      ? decision.invalidationDetails
      : typeof decision.invalidation === "object" && decision.invalidation !== null
        ? decision.invalidation
        : { price: decision.invalidationPrice ?? null, text: decision.invalidation ?? null };
    const result = this.db.prepare(`INSERT OR IGNORE INTO autonomous_decisions(id,decision_key,symbol,horizon_minutes,direction,quality_score,quality_band,timeframe_watermarks_json,strategy_name,strategy_version,profile,stage,action,stake,reasons_json,details_json,invalidation_json,invalidation_price,paper_position_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      decision.id, decision.decisionKey, decision.symbol, decision.horizonMinutes, decision.direction, decision.qualityScore, decision.qualityBand,
      JSON.stringify(decision.timeframeCloseWatermarks), decision.strategyName, decision.strategyVersion, decision.profile, decision.stage,
      decision.action, decision.stake ?? null, JSON.stringify(decision.reasons ?? []), JSON.stringify(details), JSON.stringify(invalidation),
      decision.invalidationPrice ?? invalidation.price ?? null, decision.paperPositionId ?? null, decision.createdAt, decision.updatedAt,
    );
    return result.changes === 1;
  }
  decodeAutonomousDecision(row) {
    if (!row) return null;
    const invalidationDetails = decodeJson(row.invalidationJson, {});
    return {
      ...row,
      timeframeCloseWatermarks: decodeJson(row.timeframeWatermarksJson, {}),
      reasons: decodeJson(row.reasonsJson, []),
      details: decodeJson(row.detailsJson, {}),
      invalidationDetails,
      invalidation: invalidationDetails.text ?? null,
    };
  }
  autonomousDecisionByKey(decisionKey) { return this.decodeAutonomousDecision(this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions WHERE decision_key=?`).get(decisionKey)); }
  autonomousDecisionById(id) { return this.decodeAutonomousDecision(this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions WHERE id=?`).get(id)); }
  latestAutonomousDecision() {
    return this.decodeAutonomousDecision(this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions ORDER BY updated_at DESC, created_at DESC LIMIT 1`).get());
  }
  recentAutonomousDecisions(limit = 20) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    return this.db.prepare(`SELECT ${decisionColumns} FROM autonomous_decisions ORDER BY updated_at DESC, created_at DESC LIMIT ?`).all(safeLimit).map((row) => this.decodeAutonomousDecision(row));
  }
  updateAutonomousDecision(id, changes) {
    const assignments = ["action=?", "stake=?", "reasons_json=?", "paper_position_id=?", "updated_at=?"];
    const values = [changes.action, changes.stake ?? null, JSON.stringify(changes.reasons ?? []), changes.paperPositionId ?? null, changes.updatedAt];
    if (Object.hasOwn(changes, "details")) { assignments.push("details_json=?"); values.push(JSON.stringify(changes.details ?? {})); }
    if (Object.hasOwn(changes, "invalidation")) { assignments.push("invalidation_json=?"); values.push(JSON.stringify(changes.invalidation ?? {})); }
    if (Object.hasOwn(changes, "invalidationPrice")) { assignments.push("invalidation_price=?"); values.push(changes.invalidationPrice ?? null); }
    values.push(id);
    const result = this.db.prepare(`UPDATE autonomous_decisions SET ${assignments.join(",")} WHERE id=?`).run(...values);
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
  autonomousSegmentPerformance({ profile = null, strategyVersion = null, breakEvenProbability = null, payoutRate = null } = {}) {
    const rows = this.db.prepare("SELECT symbol,horizon_minutes AS horizonMinutes,status,pnl,stake,payout_rate AS payoutRate,stake_profile AS stakeProfile,strategy_version AS strategyVersion FROM paper_positions WHERE origin='AUTONOMOUS' AND status!='OPEN' ORDER BY settled_at").all()
      .filter((row) => (!profile || row.stakeProfile === profile) && (!strategyVersion || row.strategyVersion === strategyVersion));
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.symbol}:${row.horizonMinutes}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.entries()].map(([key, items]) => {
      const [symbol, horizon] = key.split(":");
      const wins = items.filter((row) => row.status === "WON").length; const losses = items.filter((row) => row.status === "LOST").length;
      const refunds = items.filter((row) => row.status === "REFUNDED").length; const decisiveSample = wins + losses;
      const stake = items.reduce((sum, row) => sum + row.stake, 0); const pnl = items.reduce((sum, row) => sum + (row.pnl ?? 0), 0);
      const weightedPayout = stake ? items.reduce((sum, row) => sum + row.payoutRate * row.stake, 0) / stake : null;
      const referencePayout = Number.isFinite(payoutRate) && payoutRate > 0 ? payoutRate : weightedPayout;
      const referenceRate = Number.isFinite(breakEvenProbability) && breakEvenProbability >= 0 && breakEvenProbability <= 1
        ? breakEvenProbability
        : Number.isFinite(referencePayout) && referencePayout > 0 ? 1 / (1 + referencePayout) : null;
      return {
        symbol, horizonMinutes: Number(horizon), settled: items.length, decisiveSample, wins, losses, refunds,
        winRate: decisiveSample ? wins / decisiveSample : null, pnl, stake, roi: stake ? pnl / stake : null,
        wilson95: wilson95(wins, decisiveSample),
        breakEvenReference: { rate: referenceRate, payoutRate: referencePayout, source: Number.isFinite(breakEvenProbability) ? "SUPPLIED_RATE" : Number.isFinite(payoutRate) ? "SUPPLIED_PAYOUT" : "DERIVED_WEIGHTED_PAYOUT" },
      };
    }).sort((left, right) => left.symbol.localeCompare(right.symbol) || left.horizonMinutes - right.horizonMinutes);
  }
  autonomousSegmentSafeguards({ symbols, horizons, minSample = 20, profile = null, strategyVersion = null, breakEvenProbability = null, payoutRate = null } = {}) {
    if (!Array.isArray(symbols) || !Array.isArray(horizons) || !Number.isInteger(minSample) || minSample < 1) throw new Error("Invalid autonomous segment safeguard settings.");
    const segments = this.autonomousSegmentPerformance({ profile, strategyVersion, breakEvenProbability, payoutRate });
    const byKey = new Map(segments.map((segment) => [`${segment.symbol}:${segment.horizonMinutes}`, segment]));
    const suppliedRate = Number.isFinite(breakEvenProbability) && breakEvenProbability >= 0 && breakEvenProbability <= 1 ? breakEvenProbability : Number.isFinite(payoutRate) && payoutRate > 0 ? 1 / (1 + payoutRate) : null;
    return symbols.flatMap((symbol) => horizons.map((horizonMinutes) => {
      const segment = byKey.get(`${symbol}:${horizonMinutes}`) ?? {
        symbol, horizonMinutes, settled: 0, decisiveSample: 0, wins: 0, losses: 0, refunds: 0, winRate: null, pnl: 0, stake: 0, roi: null,
        wilson95: { lower: null, upper: null }, breakEvenReference: { rate: suppliedRate, payoutRate: payoutRate ?? null, source: Number.isFinite(breakEvenProbability) ? "SUPPLIED_RATE" : "SUPPLIED_PAYOUT" },
      };
      const rate = segment.breakEvenReference.rate;
      let status = "MONITOR";
      if (segment.decisiveSample < minSample) status = "WARMUP";
      else if (rate !== null && segment.wilson95.lower > rate) status = "VALIDATED";
      else if (rate !== null && segment.wilson95.upper < rate) status = "UNDERPERFORMING";
      return { ...segment, status, minSample };
    }));
  }
  sourceEvent(event) {
    this.db.prepare("INSERT INTO data_source_events(source_name,symbol,status,source_timestamp,received_at,latency_ms,message) VALUES(?,?,?,?,?,?,?)").run(event.sourceName, event.symbol ?? null, event.status, event.sourceTimestamp ?? null, event.receivedAt, event.latencyMs ?? null, event.message ?? null);
  }
  close() { this.db.close(); }
}
