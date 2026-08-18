import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const positionColumns = `id,symbol,direction,horizon_minutes AS horizonMinutes,stake,payout_rate AS payoutRate,entry_price AS entryPrice,opened_at AS openedAt,resolves_at AS resolvesAt,status,settlement_price AS settlementPrice,settled_at AS settledAt,pnl,signal_version AS signalVersion,source_name AS sourceName,source_timestamp AS sourceTimestamp,settlement_reason AS settlementReason,origin,decision_id AS decisionId,strategy_name AS strategyName,strategy_version AS strategyVersion,quality_score AS qualityScore,stake_profile AS stakeProfile,recovery_stage AS recoveryStage,entry_gate_json AS entryGateJson`;
const decisionColumns = `id,decision_key AS decisionKey,symbol,horizon_minutes AS horizonMinutes,direction,quality_score AS qualityScore,quality_band AS qualityBand,timeframe_watermarks_json AS timeframeWatermarksJson,strategy_name AS strategyName,strategy_version AS strategyVersion,profile,stage,action,stake,reasons_json AS reasonsJson,details_json AS detailsJson,invalidation_json AS invalidationJson,invalidation_price AS invalidationPrice,paper_position_id AS paperPositionId,created_at AS createdAt,updated_at AS updatedAt`;
const manualSignalColumns = `id,candidate_key AS candidateKey,symbol,horizon_minutes AS horizonMinutes,direction,lifecycle_status AS status,quality_score AS qualityScore,quality_band AS qualityBand,reasons_json AS reasonsJson,details_json AS detailsJson,timeframe_watermarks_json AS timeframeWatermarksJson,invalidation_json AS invalidationJson,invalidation_price AS invalidationPrice,strategy_name AS strategyName,strategy_version AS strategyVersion,generated_at AS generatedAt,entry_price AS entryPrice,entry_at AS entryAt,entry_valid_until AS entryValidUntil,resolves_at AS resolvesAt,entry_source_json AS entrySourceJson,candle_sources_json AS candleSourcesJson,market_classification AS marketClassification,settlement_classification AS settlementClassification,proxy_outcome AS proxyOutcome,resolution_price AS resolutionPrice,resolution_source_json AS resolutionSourceJson,resolved_at AS resolvedAt,expired_at AS expiredAt,created_at AS createdAt`;

function decodeJson(value, fallback) {
  try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function encodeJson(value, fallback = {}, label = "JSON payload") {
  try {
    const encoded = JSON.stringify(value ?? fallback);
    if (typeof encoded !== "string") throw new TypeError(`${label} is not JSON-serializable.`);
    return encoded;
  } catch (error) {
    if (error instanceof TypeError && error.message === `${label} is not JSON-serializable.`) throw error;
    throw new TypeError(`${label} is not JSON-serializable.`, { cause: error });
  }
}
function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string.`);
  return value.trim();
}
function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}
function nonnegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}
function finiteNumber(value, label, { minimum = -Infinity, maximum = Infinity, nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be finite and between ${minimum} and ${maximum}.`);
  return value;
}
function enumValue(value, allowed, label) {
  const normalized = requiredText(value, label).toUpperCase();
  if (!allowed.includes(normalized)) throw new TypeError(`${label} must be one of ${allowed.join(", ")}.`);
  return normalized;
}
function isoTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${label} must be a valid timestamp.`);
  return new Date(milliseconds).toISOString();
}
function boundedLimit(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
function decodeJsonFields(row, fields) {
  if (!row) return null;
  const decoded = { ...row };
  for (const [column, property, fallback] of fields) {
    decoded[property] = decodeJson(decoded[column], fallback);
    delete decoded[column];
  }
  return decoded;
}
function decodeBooleanFields(row, fields) {
  if (!row) return null;
  const decoded = { ...row };
  for (const field of fields) decoded[field] = decoded[field] === 1;
  return decoded;
}
function assertCalibrationModelReference(database, modelId, expected) {
  const model = database.prepare("SELECT strategy_name AS strategyName,strategy_version AS strategyVersion,forecast_model_name AS forecastModelName,forecast_model_version AS forecastModelVersion,symbol,horizon_minutes AS horizonMinutes,direction,volatility_segment AS volatilitySegment,regime_segment AS regimeSegment,calibration_method AS calibrationMethod,status,is_active AS isActive,trained_through AS trainedThrough FROM calibration_models WHERE id=?").get(modelId);
  if (!model) throw new Error("Calibration model does not exist.");
  for (const field of ["strategyName", "strategyVersion", "forecastModelName", "forecastModelVersion", "symbol", "horizonMinutes", "direction", "volatilitySegment", "regimeSegment", "calibrationMethod"]) {
    if (model[field] !== expected[field]) throw new Error(`Calibration model ${field} does not match the observation segment.`);
  }
  if (model.status !== "READY" || model.isActive !== 1) throw new Error("Calibration model must be READY and active.");
  if (expected.generatedAt !== undefined && (!model.trainedThrough || new Date(model.trainedThrough).getTime() >= new Date(expected.generatedAt).getTime())) throw new Error("Calibration model must be trained only through outcomes resolved before forecast generation.");
}
function exactNumericSequence(value) {
  if (value === null || value === undefined) return { text: null, numericText: null, numericLength: null };
  const text = String(value);
  if (!/^\d+$/.test(text)) return { text, numericText: null, numericLength: null };
  const numericText = text.replace(/^0+(?=\d)/, "");
  return { text, numericText, numericLength: numericText.length };
}
function decodeEntryGate(value) {
  if (typeof value !== "string") return { classification: "ENTRY_GATE_AUDIT_MISSING", policyVersion: null, reason: "No entry-gate audit payload was stored." };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : { classification: "ENTRY_GATE_AUDIT_CORRUPT", policyVersion: null, reason: "Stored entry-gate audit payload is not an object." };
  } catch {
    return { classification: "ENTRY_GATE_AUDIT_CORRUPT", policyVersion: null, reason: "Stored entry-gate audit payload is invalid JSON." };
  }
}
function decodePosition(row) {
  if (!row) return null;
  const { entryGateJson, ...position } = row;
  return { ...position, entryGate: decodeEntryGate(entryGateJson) };
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
    this.db.prepare(`INSERT INTO paper_positions(id,symbol,direction,horizon_minutes,stake,payout_rate,entry_price,opened_at,resolves_at,status,settlement_price,settled_at,pnl,signal_version,source_name,source_timestamp,settlement_reason,origin,decision_id,strategy_name,strategy_version,quality_score,stake_profile,recovery_stage,entry_gate_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,settlement_price=excluded.settlement_price,settled_at=excluded.settled_at,pnl=excluded.pnl,settlement_reason=excluded.settlement_reason`).run(
      position.id, position.symbol, position.direction, position.horizonMinutes, position.stake, position.payoutRate, position.entryPrice,
      position.openedAt, position.resolvesAt, position.status, position.settlementPrice, position.settledAt, position.pnl,
      position.signalVersion, position.sourceName, position.sourceTimestamp, position.settlementReason ?? null,
      position.origin ?? "MANUAL", position.decisionId ?? null, position.strategyName ?? null, position.strategyVersion ?? null,
      position.qualityScore ?? null, position.stakeProfile ?? null, position.recoveryStage ?? null, JSON.stringify(position.entryGate ?? { classification: "ENTRY_GATE_AUDIT_MISSING_AT_WRITE", policyVersion: null, reason: "Position was written without an entry-gate snapshot." }),
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
  positions() { return this.db.prepare(`SELECT ${positionColumns} FROM paper_positions ORDER BY opened_at DESC`).all().map((row) => decodePosition(row)); }
  openAutonomousPosition() { return decodePosition(this.db.prepare(`SELECT ${positionColumns} FROM paper_positions WHERE origin='AUTONOMOUS' AND status='OPEN' ORDER BY opened_at LIMIT 1`).get()); }
  autonomousPositions() { return this.db.prepare(`SELECT ${positionColumns} FROM paper_positions WHERE origin='AUTONOMOUS' ORDER BY opened_at DESC`).all().map((row) => decodePosition(row)); }
  createAutonomousDecision(decision) {
    const details = decision.details ?? {
      volatilityRegime: decision.volatilityRegime ?? null,
      confluenceComponents: decision.confluenceComponents ?? [],
      structureFeatures: decision.structureFeatures ?? {},
      technicalFeatures: decision.technicalFeatures ?? {},
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
  decodeManualResearchSignal(row) {
    if (!row) return null;
    const { reasonsJson, detailsJson, timeframeWatermarksJson, invalidationJson, entrySourceJson, candleSourcesJson, resolutionSourceJson, ...signal } = row;
    return {
      ...signal,
      reasons: decodeJson(reasonsJson, []),
      details: decodeJson(detailsJson, {}),
      timeframeCloseWatermarks: decodeJson(timeframeWatermarksJson, {}),
      invalidation: decodeJson(invalidationJson, {}),
      entrySource: decodeJson(entrySourceJson, null),
      candleSources: decodeJson(candleSourcesJson, {}),
      resolutionSource: decodeJson(resolutionSourceJson, null),
    };
  }
  createManualResearchSignal(signal) {
    const result = this.db.prepare(`INSERT INTO manual_research_signals(id,candidate_key,symbol,horizon_minutes,direction,lifecycle_status,quality_score,quality_band,reasons_json,details_json,timeframe_watermarks_json,invalidation_json,invalidation_price,strategy_name,strategy_version,generated_at,entry_price,entry_at,entry_valid_until,resolves_at,entry_source_json,candle_sources_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_key) DO NOTHING`).run(
      signal.id, signal.candidateKey, signal.symbol, signal.horizonMinutes, signal.direction, signal.status,
      signal.qualityScore, signal.qualityBand, JSON.stringify(signal.reasons ?? []), JSON.stringify(signal.details ?? {}),
      JSON.stringify(signal.timeframeCloseWatermarks ?? {}), JSON.stringify(signal.invalidation ?? {}), signal.invalidationPrice ?? null,
      signal.strategyName, signal.strategyVersion, signal.generatedAt, signal.entryPrice ?? null, signal.entryAt ?? null,
      signal.entryValidUntil ?? null, signal.resolvesAt ?? null, signal.entrySource ? JSON.stringify(signal.entrySource) : null,
      JSON.stringify(signal.candleSources ?? {}), signal.createdAt,
    );
    return result.changes === 1;
  }
  updateWaitingManualResearchSignal(id, { reasons, details }) {
    const result = this.db.prepare("UPDATE manual_research_signals SET reasons_json=?,details_json=? WHERE id=? AND lifecycle_status='WAIT'").run(JSON.stringify(reasons ?? []), JSON.stringify(details ?? {}), id);
    return result.changes === 1;
  }
  promoteManualResearchSignal(id, signal) {
    const result = this.db.prepare(`UPDATE manual_research_signals SET direction=?,lifecycle_status='READY',quality_score=?,quality_band=?,reasons_json=?,details_json=?,invalidation_json=?,invalidation_price=?,entry_price=?,entry_at=?,entry_valid_until=?,resolves_at=?,entry_source_json=?,candle_sources_json=? WHERE id=? AND lifecycle_status='WAIT'`).run(
      signal.direction, signal.qualityScore, signal.qualityBand, JSON.stringify(signal.reasons ?? []), JSON.stringify(signal.details ?? {}),
      JSON.stringify(signal.invalidation ?? {}), signal.invalidationPrice ?? null, signal.entryPrice, signal.entryAt, signal.entryValidUntil,
      signal.resolvesAt, JSON.stringify(signal.entrySource), JSON.stringify(signal.candleSources ?? {}), id,
    );
    return result.changes === 1;
  }
  manualResearchSignalById(id) {
    return this.decodeManualResearchSignal(this.db.prepare(`SELECT ${manualSignalColumns} FROM manual_research_signals WHERE id=?`).get(id));
  }
  manualResearchSignalByCandidateKey(candidateKey) {
    return this.decodeManualResearchSignal(this.db.prepare(`SELECT ${manualSignalColumns} FROM manual_research_signals WHERE candidate_key=?`).get(candidateKey));
  }
  currentManualResearchSignals(symbol = null) {
    const rows = symbol
      ? this.db.prepare(`SELECT ${manualSignalColumns} FROM manual_research_signals WHERE lifecycle_status='READY' AND symbol=? ORDER BY resolves_at,generated_at`).all(symbol)
      : this.db.prepare(`SELECT ${manualSignalColumns} FROM manual_research_signals WHERE lifecycle_status='READY' ORDER BY resolves_at,generated_at`).all();
    return rows.map((row) => this.decodeManualResearchSignal(row));
  }
  recentManualResearchSignals(limit = 50, symbol = null) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    const rows = symbol
      ? this.db.prepare(`SELECT ${manualSignalColumns} FROM manual_research_signals WHERE symbol=? ORDER BY generated_at DESC,created_at DESC LIMIT ?`).all(symbol, safeLimit)
      : this.db.prepare(`SELECT ${manualSignalColumns} FROM manual_research_signals ORDER BY generated_at DESC,created_at DESC LIMIT ?`).all(safeLimit);
    return rows.map((row) => this.decodeManualResearchSignal(row));
  }
  resolveManualResearchSignal(id, resolution) {
    const result = this.db.prepare(`UPDATE manual_research_signals SET lifecycle_status='EXPIRED',proxy_outcome=?,resolution_price=?,resolution_source_json=?,resolved_at=?,expired_at=? WHERE id=? AND lifecycle_status='READY'`).run(
      resolution.proxyOutcome, resolution.resolutionPrice ?? null, JSON.stringify(resolution.resolutionSource ?? {}), resolution.resolvedAt, resolution.expiredAt, id,
    );
    return result.changes === 1;
  }
  manualSignalEmpiricalConfidence({ minDecisiveSample = 20, payoutRate, symbol = null } = {}) {
    if (!Number.isInteger(minDecisiveSample) || minDecisiveSample < 1 || !Number.isFinite(payoutRate) || payoutRate <= 0) throw new Error("Invalid manual signal confidence settings.");
    const sql = `SELECT strategy_version AS strategyVersion,symbol,horizon_minutes AS horizonMinutes,COUNT(CASE WHEN lifecycle_status='EXPIRED' THEN 1 END) AS resolved,SUM(CASE WHEN proxy_outcome='PROXY_CORRECT' THEN 1 ELSE 0 END) AS correct,SUM(CASE WHEN proxy_outcome='PROXY_INCORRECT' THEN 1 ELSE 0 END) AS incorrect,SUM(CASE WHEN proxy_outcome='PROXY_TIE' THEN 1 ELSE 0 END) AS ties,SUM(CASE WHEN proxy_outcome='NO_TIMELY_OBSERVATION' THEN 1 ELSE 0 END) AS unavailable FROM manual_research_signals${symbol ? " WHERE symbol=?" : ""} GROUP BY strategy_version,symbol,horizon_minutes ORDER BY strategy_version,symbol,horizon_minutes`;
    const rows = symbol ? this.db.prepare(sql).all(symbol) : this.db.prepare(sql).all();
    const breakEvenRate = 1 / (1 + payoutRate);
    return rows.map((row) => {
      const decisiveSample = row.correct + row.incorrect;
      const sufficient = decisiveSample >= minDecisiveSample;
      const interval = sufficient ? wilson95(row.correct, decisiveSample) : { lower: null, upper: null };
      return {
        classification: "SPOT_PROXY_PROSPECTIVE_OUTCOMES_NOT_EVENT_FUTURES_CALIBRATION",
        strategyVersion: row.strategyVersion, symbol: row.symbol, horizonMinutes: row.horizonMinutes,
        resolved: row.resolved, decisiveSample, correct: row.correct, incorrect: row.incorrect, ties: row.ties, unavailable: row.unavailable,
        minDecisiveSample, status: !sufficient ? "WARMUP" : interval.lower > breakEvenRate ? "VALIDATED" : interval.upper < breakEvenRate ? "UNDERPERFORMING" : "MONITOR",
        measuredRate: sufficient ? row.correct / decisiveSample : null, wilson95: interval,
        breakEvenReference: { rate: breakEvenRate, payoutRate, source: "USER_CONFIGURED_PAPER_PAYOUT" },
      };
    });
  }
  strategyState(symbol, horizonMinutes, machineType, machineKey) {
    const row = this.db.prepare("SELECT symbol,horizon_minutes AS horizonMinutes,machine_type AS machineType,machine_key AS machineKey,state,payload_json AS payloadJson,last_event_key AS lastEventKey,version,updated_at AS updatedAt FROM strategy_states WHERE symbol=? AND horizon_minutes=? AND machine_type=? AND machine_key=?").get(symbol, horizonMinutes, machineType, machineKey);
    return row ? { ...row, payload: decodeJson(row.payloadJson, {}) } : null;
  }
  applyStrategyTransition(transition) {
    const previous = this.strategyState(transition.symbol, transition.horizonMinutes, transition.machineType, transition.machineKey);
    if (previous?.lastEventKey === transition.eventKey) return previous;
    if (previous?.state === transition.state) {
      this.db.prepare("UPDATE strategy_states SET payload_json=?,last_event_key=?,updated_at=? WHERE symbol=? AND horizon_minutes=? AND machine_type=? AND machine_key=?").run(
        JSON.stringify(transition.payload ?? {}), transition.eventKey, transition.observedAt,
        transition.symbol, transition.horizonMinutes, transition.machineType, transition.machineKey,
      );
      return this.strategyState(transition.symbol, transition.horizonMinutes, transition.machineType, transition.machineKey);
    }
    const existingEvent = this.db.prepare("SELECT event_key AS eventKey FROM strategy_state_transitions WHERE event_key=?").get(transition.eventKey);
    if (!existingEvent) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`INSERT INTO strategy_state_transitions(symbol,horizon_minutes,machine_type,machine_key,from_state,to_state,event_key,evidence_json,transitioned_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(
          transition.symbol, transition.horizonMinutes, transition.machineType, transition.machineKey, previous?.state ?? null,
          transition.state, transition.eventKey, JSON.stringify(transition.payload ?? {}), transition.observedAt,
        );
        const version = (previous?.version ?? 0) + 1;
        this.db.prepare(`INSERT INTO strategy_states(symbol,horizon_minutes,machine_type,machine_key,state,payload_json,last_event_key,version,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
          ON CONFLICT(symbol,horizon_minutes,machine_type,machine_key) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,last_event_key=excluded.last_event_key,version=excluded.version,updated_at=excluded.updated_at`).run(
          transition.symbol, transition.horizonMinutes, transition.machineType, transition.machineKey, transition.state,
          JSON.stringify(transition.payload ?? {}), transition.eventKey, version, transition.observedAt,
        );
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    return this.strategyState(transition.symbol, transition.horizonMinutes, transition.machineType, transition.machineKey);
  }
  upsertFeedChannelState(state) {
    this.db.prepare(`INSERT INTO feed_channel_state(provider,symbol,channel,status,session_id,connected_at,last_message_at,last_event_at,last_sequence,lag_ms,gap_count,reconnect_count,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(provider,symbol,channel) DO UPDATE SET status=excluded.status,session_id=excluded.session_id,connected_at=excluded.connected_at,last_message_at=excluded.last_message_at,last_event_at=excluded.last_event_at,last_sequence=excluded.last_sequence,lag_ms=excluded.lag_ms,gap_count=excluded.gap_count,reconnect_count=excluded.reconnect_count,last_error=excluded.last_error,updated_at=excluded.updated_at`).run(
      state.provider, state.symbol, state.channel, state.status, state.sessionId ?? null, state.connectedAt ?? null, state.lastMessageAt ?? null,
      state.lastEventAt ?? null, state.lastSequence ?? null, state.lagMs ?? null, state.gapCount ?? 0, state.reconnectCount ?? 0,
      state.lastError ?? null, state.updatedAt,
    );
  }
  recordFeedEvent(event) {
    this.db.prepare("INSERT OR IGNORE INTO feed_events(event_key,provider,symbol,channel,event_type,severity,payload_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(
      event.eventKey, event.provider, event.symbol, event.channel, event.eventType, event.severity,
      JSON.stringify(event.payload ?? { status: event.status ?? null, error: event.lastError ?? null }), event.occurredAt,
    );
  }
  upsertOperationalAlert(alert) {
    this.db.prepare(`INSERT INTO operational_alerts(fingerprint,alert_type,provider,symbol,channel,severity,status,first_seen_at,last_seen_at,occurrence_count,payload_json,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,NULL)
      ON CONFLICT(fingerprint) DO UPDATE SET severity=excluded.severity,status='OPEN',last_seen_at=excluded.last_seen_at,occurrence_count=operational_alerts.occurrence_count+1,payload_json=excluded.payload_json,resolved_at=NULL`).run(
      alert.fingerprint, alert.alertType, alert.provider, alert.symbol, alert.channel, alert.severity, alert.status ?? "OPEN",
      alert.observedAt, alert.observedAt, JSON.stringify(alert.payload ?? {}),
    );
    return this.db.prepare("SELECT fingerprint,alert_type AS alertType,provider,symbol,channel,severity,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,occurrence_count AS occurrenceCount,payload_json AS payloadJson,resolved_at AS resolvedAt FROM operational_alerts WHERE fingerprint=?").get(alert.fingerprint);
  }
  refreshOperationalAlert(fingerprint, observedAt, payload = {}) {
    const result = this.db.prepare("UPDATE operational_alerts SET last_seen_at=?,occurrence_count=occurrence_count+1,payload_json=? WHERE fingerprint=? AND status='OPEN'").run(observedAt, JSON.stringify(payload), fingerprint);
    return result.changes === 1;
  }
  resolveOperationalAlert(fingerprint, resolvedAt, payload = {}) {
    const result = this.db.prepare("UPDATE operational_alerts SET status='RESOLVED',last_seen_at=?,resolved_at=?,payload_json=? WHERE fingerprint=? AND status='OPEN'").run(resolvedAt, resolvedAt, JSON.stringify(payload), fingerprint);
    return result.changes === 1;
  }
  operationalAlerts({ status = null, limit = 100 } = {}) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const rows = status
      ? this.db.prepare("SELECT fingerprint,alert_type AS alertType,provider,symbol,channel,severity,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,occurrence_count AS occurrenceCount,payload_json AS payloadJson,resolved_at AS resolvedAt FROM operational_alerts WHERE status=? ORDER BY last_seen_at DESC LIMIT ?").all(status, safeLimit)
      : this.db.prepare("SELECT fingerprint,alert_type AS alertType,provider,symbol,channel,severity,status,first_seen_at AS firstSeenAt,last_seen_at AS lastSeenAt,occurrence_count AS occurrenceCount,payload_json AS payloadJson,resolved_at AS resolvedAt FROM operational_alerts ORDER BY last_seen_at DESC LIMIT ?").all(safeLimit);
    return rows.map(({ payloadJson, ...row }) => ({ ...row, payload: decodeJson(payloadJson, {}) }));
  }
  createForecastObservation(observation) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) throw new TypeError("Forecast observation must be an object.");
    const calibrationMethod = enumValue(observation.calibrationMethod ?? "RAW", ["RAW", "ISOTONIC", "PLATT"], "calibrationMethod");
    const rawProbabilityUp = finiteNumber(observation.rawProbabilityUp, "rawProbabilityUp", { minimum: 0, maximum: 1, nullable: true });
    const calibrationModelId = observation.calibrationModelId ?? null;
    const calibratedProbabilityUp = finiteNumber(observation.calibratedProbabilityUp, "calibratedProbabilityUp", { minimum: 0, maximum: 1, nullable: calibrationMethod === "RAW" });
    if (calibrationMethod === "RAW" && calibrationModelId !== null) throw new TypeError("RAW forecasts cannot reference a calibration model.");
    if (calibrationMethod === "RAW" && calibratedProbabilityUp !== null) throw new TypeError("RAW technical scores are not calibrated probabilities.");
    if (calibrationMethod !== "RAW" && !calibrationModelId) throw new TypeError("Calibrated forecasts require calibrationModelId.");
    const generatedAt = isoTimestamp(observation.generatedAt, "generatedAt");
    const resolvesAt = isoTimestamp(observation.resolvesAt, "resolvesAt");
    if (resolvesAt <= generatedAt) throw new TypeError("resolvesAt must follow generatedAt.");
    const scope = {
      strategyName: requiredText(observation.strategyName, "strategyName"), strategyVersion: requiredText(observation.strategyVersion, "strategyVersion"),
      forecastModelName: requiredText(observation.forecastModelName ?? observation.strategyName, "forecastModelName"),
      forecastModelVersion: requiredText(observation.forecastModelVersion ?? observation.strategyVersion, "forecastModelVersion"),
      symbol: requiredText(observation.symbol, "symbol"), horizonMinutes: positiveInteger(observation.horizonMinutes, "horizonMinutes"),
      direction: enumValue(observation.predictedDirection, ["UP", "DOWN", "NEUTRAL"], "predictedDirection"),
      volatilitySegment: requiredText(observation.volatilitySegment ?? observation.volatilityRegime ?? "UNSEGMENTED", "volatilitySegment"),
      regimeSegment: requiredText(observation.regimeSegment ?? observation.regime?.regime ?? observation.regime?.label ?? "UNSEGMENTED", "regimeSegment"), calibrationMethod,
    };
    const deepObservation = ["forecastModelName", "forecastModelVersion", "volatilitySegment", "regimeSegment", "calibrationMethod", "calibrationModelId", "rawProbabilityUp", "calibratedProbabilityUp"].some((field) => Object.hasOwn(observation, field));
    const resolutionPolicy = enumValue(observation.resolutionPolicy ?? (deepObservation ? "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON" : "LEGACY_V0_8_CALLER_RESOLUTION"), ["LEGACY_V0_8_CALLER_RESOLUTION", "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON"], "resolutionPolicy");
    const values = [
      requiredText(observation.id, "id"), requiredText(observation.observationKey, "observationKey"), scope.strategyName, scope.strategyVersion, scope.symbol, scope.horizonMinutes,
      generatedAt, resolvesAt, finiteNumber(observation.entryPrice, "entryPrice", { minimum: Number.MIN_VALUE }), scope.direction,
      finiteNumber(observation.upScore, "upScore", { minimum: 0, maximum: 100 }), finiteNumber(observation.downScore, "downScore", { minimum: 0, maximum: 100 }),
      finiteNumber(observation.qualityScore, "qualityScore", { minimum: 0, maximum: 100 }), encodeJson(observation.readiness, {}, "readiness"),
      encodeJson(observation.regime, {}, "regime"), encodeJson(observation.features, {}, "features"), encodeJson(observation.source, {}, "source"),
      scope.forecastModelName, scope.forecastModelVersion, scope.volatilitySegment, scope.regimeSegment, calibrationMethod, calibrationModelId, rawProbabilityUp,
      calibratedProbabilityUp, resolutionPolicy, isoTimestamp(observation.createdAt ?? generatedAt, "createdAt"),
    ];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (calibrationModelId) assertCalibrationModelReference(this.db, calibrationModelId, { ...scope, generatedAt });
      const result = this.db.prepare(`INSERT OR IGNORE INTO forecast_observations(id,observation_key,strategy_name,strategy_version,symbol,horizon_minutes,generated_at,resolves_at,entry_price,predicted_direction,up_score,down_score,quality_score,readiness_json,regime_json,features_json,source_json,forecast_model_name,forecast_model_version,volatility_segment,regime_segment,calibration_method,calibration_model_id,raw_probability_up,calibrated_probability_up,resolution_policy,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
      if (result.changes === 1) this.db.prepare("INSERT INTO forecast_observation_events(event_key,observation_id,event_type,from_status,to_status,payload_json,occurred_at) VALUES(?,?,'CREATED',NULL,'PENDING',?,?)").run(
        requiredText(observation.createdEventKey ?? `${observation.observationKey}:CREATED`, "createdEventKey"), observation.id,
        encodeJson({ calibrationMethod, calibrationModelId, rawProbabilityUp, calibratedProbabilityUp }, {}, "forecast creation audit"), generatedAt,
      );
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  forecastObservationById(id) {
    const row = this.db.prepare(`SELECT id,observation_key AS observationKey,strategy_name AS strategyName,strategy_version AS strategyVersion,forecast_model_name AS forecastModelName,forecast_model_version AS forecastModelVersion,symbol,horizon_minutes AS horizonMinutes,generated_at AS generatedAt,resolves_at AS resolvesAt,entry_price AS entryPrice,predicted_direction AS predictedDirection,up_score AS upScore,down_score AS downScore,quality_score AS qualityScore,readiness_json AS readinessJson,regime_json AS regimeJson,features_json AS featuresJson,source_json AS sourceJson,volatility_segment AS volatilitySegment,regime_segment AS regimeSegment,calibration_method AS calibrationMethod,calibration_model_id AS calibrationModelId,raw_probability_up AS rawProbabilityUp,calibrated_probability_up AS calibratedProbabilityUp,resolution_policy AS resolutionPolicy,outcome,actual_direction AS actualDirection,resolution_price AS resolutionPrice,resolution_source_json AS resolutionSourceJson,resolution_candle_open_at AS resolutionCandleOpenAt,resolution_candle_close_at AS resolutionCandleCloseAt,resolved_at AS resolvedAt,created_at AS createdAt FROM forecast_observations WHERE id=?`).get(requiredText(id, "id"));
    return decodeJsonFields(row, [["readinessJson", "readiness", {}], ["regimeJson", "regime", {}], ["featuresJson", "features", {}], ["sourceJson", "source", {}], ["resolutionSourceJson", "resolutionSource", null]]);
  }
  pendingForecastObservations(resolvesBefore, limit = 500) {
    const safeLimit = boundedLimit(limit, 500, 2000);
    return this.db.prepare("SELECT id,observation_key AS observationKey,symbol,horizon_minutes AS horizonMinutes,generated_at AS generatedAt,resolves_at AS resolvesAt,entry_price AS entryPrice,predicted_direction AS predictedDirection,up_score AS upScore,down_score AS downScore,volatility_segment AS volatilitySegment,regime_segment AS regimeSegment,calibration_method AS calibrationMethod,calibration_model_id AS calibrationModelId,raw_probability_up AS rawProbabilityUp,calibrated_probability_up AS calibratedProbabilityUp,resolution_policy AS resolutionPolicy FROM forecast_observations WHERE outcome IS NULL AND resolves_at<=? ORDER BY resolves_at,id LIMIT ?").all(isoTimestamp(resolvesBefore, "resolvesBefore"), safeLimit);
  }
  resolveForecastObservation(id, resolution) {
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) throw new TypeError("Forecast resolution must be an object.");
    const observation = this.db.prepare("SELECT observation_key AS observationKey,resolves_at AS resolvesAt,resolution_policy AS resolutionPolicy,outcome FROM forecast_observations WHERE id=?").get(requiredText(id, "id"));
    if (!observation || observation.outcome !== null) return false;
    const hasResolutionCandle = resolution.resolutionCandleOpenAt != null || resolution.candleOpenAt != null || resolution.resolutionCandleCloseAt != null || resolution.candleCloseAt != null;
    const unavailableTerminal = resolution.outcome === "NO_COMPLETE_1M_OBSERVATION" && resolution.actualDirection === "UNAVAILABLE" && resolution.resolutionPrice == null;
    if (observation.resolutionPolicy === "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON" && !hasResolutionCandle && !unavailableTerminal) throw new TypeError("Prospective Deep forecasts require the first complete 1m candle after the horizon or an explicit terminal unavailable outcome.");
    const candleOpenAt = hasResolutionCandle ? isoTimestamp(resolution.resolutionCandleOpenAt ?? resolution.candleOpenAt, "resolutionCandleOpenAt") : null;
    const candleCloseAt = hasResolutionCandle ? isoTimestamp(resolution.resolutionCandleCloseAt ?? resolution.candleCloseAt, "resolutionCandleCloseAt") : null;
    const resolvedAt = isoTimestamp(resolution.resolvedAt, "resolvedAt");
    if (hasResolutionCandle && new Date(candleCloseAt).getTime() - new Date(candleOpenAt).getTime() !== 60_000) throw new TypeError("The resolution candle must be a complete 1m candle.");
    if (hasResolutionCandle && !(candleOpenAt <= observation.resolvesAt && observation.resolvesAt < candleCloseAt)) throw new TypeError("Resolution must use the first complete 1m close after the forecast horizon.");
    if (hasResolutionCandle && resolvedAt < candleCloseAt) throw new TypeError("resolvedAt cannot precede the resolution candle close.");
    const source = hasResolutionCandle
      ? { ...(resolution.resolutionSource ?? {}), policy: "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON", timeframe: "1m", candleOpenAt, candleCloseAt }
      : observation.resolutionPolicy === "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON"
        ? { ...(resolution.resolutionSource ?? {}), policy: "FIRST_COMPLETE_1M_CLOSE_AFTER_HORIZON", timeframe: "1m", unavailable: true }
        : { ...(resolution.resolutionSource ?? {}), policy: "LEGACY_V0_8_CALLER_RESOLUTION" };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE forecast_observations SET outcome=?,actual_direction=?,resolution_price=?,resolution_source_json=?,resolution_candle_open_at=?,resolution_candle_close_at=?,resolved_at=? WHERE id=? AND outcome IS NULL").run(
        requiredText(resolution.outcome, "outcome"), enumValue(resolution.actualDirection, ["UP", "DOWN", "TIE", "UNAVAILABLE"], "actualDirection"),
        finiteNumber(resolution.resolutionPrice, "resolutionPrice", { minimum: Number.MIN_VALUE, nullable: resolution.resolutionPrice == null }), encodeJson(source, {}, "resolutionSource"),
        candleOpenAt, candleCloseAt, resolvedAt, id,
      );
      if (result.changes === 1) this.db.prepare("INSERT INTO forecast_observation_events(event_key,observation_id,event_type,from_status,to_status,payload_json,occurred_at) VALUES(?,?,'RESOLVED','PENDING','RESOLVED',?,?)").run(
        requiredText(resolution.eventKey ?? `${observation.observationKey}:RESOLVED:${candleCloseAt ?? resolvedAt}`, "eventKey"), id,
        encodeJson({ outcome: resolution.outcome, actualDirection: resolution.actualDirection, resolutionPrice: resolution.resolutionPrice ?? null, resolutionSource: source }, {}, "forecast resolution audit"), resolvedAt,
      );
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  forecastObservationEvents(observationId, limit = 200) {
    return this.db.prepare("SELECT id,event_key AS eventKey,observation_id AS observationId,event_type AS eventType,from_status AS fromStatus,to_status AS toStatus,payload_json AS payloadJson,occurred_at AS occurredAt FROM forecast_observation_events WHERE observation_id=? ORDER BY occurred_at,id LIMIT ?").all(requiredText(observationId, "observationId"), boundedLimit(limit, 200, 2000))
      .map((row) => decodeJsonFields(row, [["payloadJson", "payload", {}]]));
  }
  forecastObservationsForCalibration({ strategyName = null, strategyVersion = null, forecastModelName = null, forecastModelVersion = null, symbol, horizonMinutes, direction, volatilitySegment, regimeSegment, calibrationMethod = null, resolvedBefore = null, limit = 5000 } = {}) {
    const parameters = [requiredText(symbol, "symbol"), positiveInteger(horizonMinutes, "horizonMinutes"), enumValue(direction, ["UP", "DOWN", "NEUTRAL"], "direction"), requiredText(volatilitySegment, "volatilitySegment"), requiredText(regimeSegment, "regimeSegment")];
    let sql = "SELECT id,strategy_name AS strategyName,strategy_version AS strategyVersion,forecast_model_name AS forecastModelName,forecast_model_version AS forecastModelVersion,generated_at AS generatedAt,resolved_at AS resolvedAt,predicted_direction AS predictedDirection,actual_direction AS actualDirection,outcome,up_score AS upScore,down_score AS downScore,raw_probability_up AS rawProbabilityUp,calibrated_probability_up AS calibratedProbabilityUp,calibration_method AS calibrationMethod,calibration_model_id AS calibrationModelId FROM forecast_observations WHERE outcome IS NOT NULL AND symbol=? AND horizon_minutes=? AND predicted_direction=? AND volatility_segment=? AND regime_segment=?";
    for (const [column, value, label] of [["strategy_name", strategyName, "strategyName"], ["strategy_version", strategyVersion, "strategyVersion"], ["forecast_model_name", forecastModelName, "forecastModelName"], ["forecast_model_version", forecastModelVersion, "forecastModelVersion"]]) {
      if (value !== null) { sql += ` AND ${column}=?`; parameters.push(requiredText(value, label)); }
    }
    if (calibrationMethod) { sql += " AND calibration_method=?"; parameters.push(enumValue(calibrationMethod, ["RAW", "ISOTONIC", "PLATT"], "calibrationMethod")); }
    if (resolvedBefore) { sql += " AND resolved_at<?"; parameters.push(isoTimestamp(resolvedBefore, "resolvedBefore")); }
    sql += " ORDER BY generated_at,id LIMIT ?"; parameters.push(boundedLimit(limit, 5000, 50000));
    return this.db.prepare(sql).all(...parameters);
  }
  forecastCalibration({ minSample = 50, symbol = null } = {}) {
    const rows = symbol
      ? this.db.prepare("SELECT strategy_version AS strategyVersion,symbol,horizon_minutes AS horizonMinutes,predicted_direction AS predictedDirection,up_score AS upScore,actual_direction AS actualDirection,outcome FROM forecast_observations WHERE outcome IS NOT NULL AND symbol=?").all(symbol)
      : this.db.prepare("SELECT strategy_version AS strategyVersion,symbol,horizon_minutes AS horizonMinutes,predicted_direction AS predictedDirection,up_score AS upScore,actual_direction AS actualDirection,outcome FROM forecast_observations WHERE outcome IS NOT NULL").all();
    const groups = new Map();
    for (const row of rows) { const key = `${row.strategyVersion}:${row.symbol}:${row.horizonMinutes}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    return [...groups.values()].map((items) => {
      const first = items[0]; const brierSample = items.filter((item) => ["UP", "DOWN"].includes(item.actualDirection));
      const directional = brierSample.filter((item) => ["UP", "DOWN"].includes(item.predictedDirection));
      const correct = directional.filter((item) => item.predictedDirection === item.actualDirection).length;
      const brierScore = brierSample.length ? brierSample.reduce((sum, item) => { const probabilityUp = item.upScore / 100; const actualUp = item.actualDirection === "UP" ? 1 : 0; return sum + (probabilityUp - actualUp) ** 2; }, 0) / brierSample.length : null;
      return { classification: "PROSPECTIVE_UNSELECTED_SPOT_PROXY_CALIBRATION", strategyVersion: first.strategyVersion, symbol: first.symbol, horizonMinutes: first.horizonMinutes, resolved: items.length, decisiveSample: brierSample.length, directionalSample: directional.length, brierSample: brierSample.length, correct, measuredAccuracy: directional.length >= minSample ? correct / directional.length : null, brierScore: brierSample.length >= minSample ? brierScore : null, status: brierSample.length >= minSample ? "CALIBRATING" : "WARMUP", minSample };
    }).sort((left, right) => left.symbol.localeCompare(right.symbol) || left.horizonMinutes - right.horizonMinutes);
  }
  createCalibrationModel(model) {
    if (!model || typeof model !== "object" || Array.isArray(model)) throw new TypeError("Calibration model must be an object.");
    const method = enumValue(model.calibrationMethod ?? model.method, ["ISOTONIC", "PLATT"], "calibrationMethod");
    const direction = enumValue(model.direction, ["UP", "DOWN", "NEUTRAL"], "direction");
    const trainedFrom = isoTimestamp(model.trainedFrom, "trainedFrom", { nullable: true });
    const trainedThrough = isoTimestamp(model.trainedThrough, "trainedThrough", { nullable: true });
    if (trainedFrom && trainedThrough && trainedThrough < trainedFrom) throw new TypeError("trainedThrough cannot precede trainedFrom.");
    const scope = [
      requiredText(model.strategyName, "strategyName"), requiredText(model.strategyVersion, "strategyVersion"), requiredText(model.forecastModelName, "forecastModelName"),
      requiredText(model.forecastModelVersion, "forecastModelVersion"), requiredText(model.symbol, "symbol"), positiveInteger(model.horizonMinutes, "horizonMinutes"),
      direction, requiredText(model.volatilitySegment, "volatilitySegment"), requiredText(model.regimeSegment, "regimeSegment"), method,
    ];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`INSERT OR IGNORE INTO calibration_models(id,model_key,strategy_name,strategy_version,forecast_model_name,forecast_model_version,symbol,horizon_minutes,direction,volatility_segment,regime_segment,calibration_method,status,is_active,sample_size,model_json,trained_from,trained_through,trained_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(
        requiredText(model.id, "id"), requiredText(model.modelKey, "modelKey"), ...scope,
        requiredText(model.status, "status"), nonnegativeInteger(model.sampleSize, "sampleSize"), encodeJson(model.model, {}, "model"), trainedFrom, trainedThrough,
        isoTimestamp(model.trainedAt, "trainedAt"), isoTimestamp(model.createdAt ?? model.trainedAt, "createdAt"),
      );
      const stored = this.db.prepare("SELECT id FROM calibration_models WHERE model_key=?").get(model.modelKey);
      if (stored?.id !== model.id) throw new Error("modelKey already belongs to another calibration model.");
      if (model.isActive === true) {
        this.db.prepare("UPDATE calibration_models SET is_active=0 WHERE strategy_name=? AND strategy_version=? AND forecast_model_name=? AND forecast_model_version=? AND symbol=? AND horizon_minutes=? AND direction=? AND volatility_segment=? AND regime_segment=? AND calibration_method=? AND id!=?").run(...scope, model.id);
        const activated = this.db.prepare("UPDATE calibration_models SET is_active=1 WHERE id=? AND status='READY'").run(model.id);
        if (activated.changes !== 1) throw new Error("Only READY calibration models can be activated.");
      }
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  calibrationModelById(id) {
    const row = this.db.prepare("SELECT id,model_key AS modelKey,strategy_name AS strategyName,strategy_version AS strategyVersion,forecast_model_name AS forecastModelName,forecast_model_version AS forecastModelVersion,symbol,horizon_minutes AS horizonMinutes,direction,volatility_segment AS volatilitySegment,regime_segment AS regimeSegment,calibration_method AS calibrationMethod,status,is_active AS isActive,sample_size AS sampleSize,model_json AS modelJson,trained_from AS trainedFrom,trained_through AS trainedThrough,trained_at AS trainedAt,created_at AS createdAt FROM calibration_models WHERE id=?").get(requiredText(id, "id"));
    return decodeBooleanFields(decodeJsonFields(row, [["modelJson", "model", {}]]), ["isActive"]);
  }
  activeCalibrationModel(scope) {
    if (!scope || typeof scope !== "object") throw new TypeError("Calibration model scope must be an object.");
    const row = this.db.prepare("SELECT id FROM calibration_models WHERE strategy_name=? AND strategy_version=? AND forecast_model_name=? AND forecast_model_version=? AND symbol=? AND horizon_minutes=? AND direction=? AND volatility_segment=? AND regime_segment=? AND calibration_method=? AND is_active=1").get(
      requiredText(scope.strategyName, "strategyName"), requiredText(scope.strategyVersion, "strategyVersion"), requiredText(scope.forecastModelName, "forecastModelName"), requiredText(scope.forecastModelVersion, "forecastModelVersion"),
      requiredText(scope.symbol, "symbol"), positiveInteger(scope.horizonMinutes, "horizonMinutes"), enumValue(scope.direction, ["UP", "DOWN", "NEUTRAL"], "direction"),
      requiredText(scope.volatilitySegment, "volatilitySegment"), requiredText(scope.regimeSegment, "regimeSegment"), enumValue(scope.calibrationMethod ?? scope.method, ["ISOTONIC", "PLATT"], "calibrationMethod"),
    );
    return row ? this.calibrationModelById(row.id) : null;
  }
  activateCalibrationModel(id) {
    const model = this.calibrationModelById(id);
    if (!model) return false;
    if (model.status !== "READY") throw new Error("Only READY calibration models can be activated.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE calibration_models SET is_active=0 WHERE strategy_name=? AND strategy_version=? AND forecast_model_name=? AND forecast_model_version=? AND symbol=? AND horizon_minutes=? AND direction=? AND volatility_segment=? AND regime_segment=? AND calibration_method=?").run(
        model.strategyName, model.strategyVersion, model.forecastModelName, model.forecastModelVersion, model.symbol, model.horizonMinutes, model.direction, model.volatilitySegment, model.regimeSegment, model.calibrationMethod,
      );
      const result = this.db.prepare("UPDATE calibration_models SET is_active=1 WHERE id=?").run(id);
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  createCalibrationMetricSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new TypeError("Calibration metric snapshot must be an object.");
    const method = enumValue(snapshot.calibrationMethod ?? snapshot.method, ["RAW", "ISOTONIC", "PLATT"], "calibrationMethod");
    const modelId = snapshot.calibrationModelId ?? null;
    if ((method === "RAW") !== (modelId === null)) throw new TypeError("RAW snapshots must not reference a model; calibrated snapshots must reference one.");
    const observedFrom = isoTimestamp(snapshot.observedFrom, "observedFrom", { nullable: true });
    const observedThrough = isoTimestamp(snapshot.observedThrough, "observedThrough", { nullable: true });
    if (observedFrom && observedThrough && observedThrough < observedFrom) throw new TypeError("observedThrough cannot precede observedFrom.");
    const scope = {
      strategyName: requiredText(snapshot.strategyName, "strategyName"), strategyVersion: requiredText(snapshot.strategyVersion, "strategyVersion"),
      forecastModelName: requiredText(snapshot.forecastModelName, "forecastModelName"), forecastModelVersion: requiredText(snapshot.forecastModelVersion, "forecastModelVersion"),
      symbol: requiredText(snapshot.symbol, "symbol"), horizonMinutes: positiveInteger(snapshot.horizonMinutes, "horizonMinutes"),
      direction: enumValue(snapshot.direction, ["UP", "DOWN", "NEUTRAL"], "direction"), volatilitySegment: requiredText(snapshot.volatilitySegment, "volatilitySegment"),
      regimeSegment: requiredText(snapshot.regimeSegment, "regimeSegment"), calibrationMethod: method,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (modelId) assertCalibrationModelReference(this.db, modelId, scope);
      const result = this.db.prepare(`INSERT OR IGNORE INTO calibration_metric_snapshots(id,snapshot_key,calibration_model_id,strategy_name,strategy_version,forecast_model_name,forecast_model_version,symbol,horizon_minutes,direction,volatility_segment,regime_segment,calibration_method,sample_size,min_sample_size,brier_score,log_loss,expected_calibration_error,metrics_json,reliability_json,observed_from,observed_through,measured_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        requiredText(snapshot.id, "id"), requiredText(snapshot.snapshotKey, "snapshotKey"), modelId, scope.strategyName, scope.strategyVersion, scope.forecastModelName,
        scope.forecastModelVersion, scope.symbol, scope.horizonMinutes, scope.direction, scope.volatilitySegment, scope.regimeSegment, method,
        nonnegativeInteger(snapshot.sampleSize, "sampleSize"), nonnegativeInteger(snapshot.minSampleSize ?? 0, "minSampleSize"),
        finiteNumber(snapshot.brierScore, "brierScore", { minimum: 0, nullable: true }), finiteNumber(snapshot.logLoss, "logLoss", { minimum: 0, nullable: true }),
        finiteNumber(snapshot.expectedCalibrationError, "expectedCalibrationError", { minimum: 0, maximum: 1, nullable: true }), encodeJson(snapshot.metrics, {}, "metrics"),
        encodeJson(snapshot.reliability ?? snapshot.reliabilityCurve, [], "reliability"), observedFrom, observedThrough, isoTimestamp(snapshot.measuredAt, "measuredAt"),
        isoTimestamp(snapshot.createdAt ?? snapshot.measuredAt, "createdAt"),
      );
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  calibrationMetricSnapshots({ calibrationModelId = null, symbol = null, limit = 100 } = {}) {
    const safeLimit = boundedLimit(limit, 100, 2000);
    let rows;
    if (calibrationModelId) rows = this.db.prepare("SELECT * FROM calibration_metric_snapshots WHERE calibration_model_id=? ORDER BY measured_at DESC LIMIT ?").all(requiredText(calibrationModelId, "calibrationModelId"), safeLimit);
    else if (symbol) rows = this.db.prepare("SELECT * FROM calibration_metric_snapshots WHERE symbol=? ORDER BY measured_at DESC LIMIT ?").all(requiredText(symbol, "symbol"), safeLimit);
    else rows = this.db.prepare("SELECT * FROM calibration_metric_snapshots ORDER BY measured_at DESC LIMIT ?").all(safeLimit);
    return rows.map((row) => decodeJsonFields({
      ...row, snapshotKey: row.snapshot_key, calibrationModelId: row.calibration_model_id, strategyName: row.strategy_name, strategyVersion: row.strategy_version,
      forecastModelName: row.forecast_model_name, forecastModelVersion: row.forecast_model_version, horizonMinutes: row.horizon_minutes, volatilitySegment: row.volatility_segment,
      regimeSegment: row.regime_segment, calibrationMethod: row.calibration_method, sampleSize: row.sample_size, minSampleSize: row.min_sample_size, brierScore: row.brier_score,
      logLoss: row.log_loss, expectedCalibrationError: row.expected_calibration_error, metricsJson: row.metrics_json, reliabilityJson: row.reliability_json,
      observedFrom: row.observed_from, observedThrough: row.observed_through, measuredAt: row.measured_at, createdAt: row.created_at,
    }, [["metricsJson", "metrics", {}], ["reliabilityJson", "reliability", []]])).map((row) => {
      for (const key of Object.keys(row)) if (key.includes("_")) delete row[key];
      return row;
    });
  }
  createStructureEpisode(episode, initialEvent = null) {
    if (!episode || typeof episode !== "object" || Array.isArray(episode)) throw new TypeError("Structure episode must be an object.");
    const openedAt = isoTimestamp(episode.openedAt, "openedAt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`INSERT OR IGNORE INTO structure_episodes(id,episode_key,symbol,horizon_minutes,machine_type,machine_key,structure_type,direction,state,status,strategy_name,strategy_version,context_json,opened_at,closed_at,close_reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,NULL,NULL,?,?)`).run(
        requiredText(episode.id, "id"), requiredText(episode.episodeKey, "episodeKey"), requiredText(episode.symbol, "symbol"), positiveInteger(episode.horizonMinutes, "horizonMinutes"),
        requiredText(episode.machineType, "machineType"), requiredText(episode.machineKey, "machineKey"), requiredText(episode.structureType, "structureType"),
        episode.direction == null ? null : enumValue(episode.direction, ["UP", "DOWN", "NEUTRAL"], "direction"), requiredText(episode.state, "state"),
        requiredText(episode.strategyName, "strategyName"), requiredText(episode.strategyVersion, "strategyVersion"), encodeJson(episode.context, {}, "context"), openedAt,
        isoTimestamp(episode.createdAt ?? openedAt, "createdAt"), isoTimestamp(episode.updatedAt ?? openedAt, "updatedAt"),
      );
      if (result.changes === 1 && initialEvent) this.db.prepare("INSERT INTO structure_episode_events(event_key,episode_id,event_type,from_state,to_state,evidence_json,observed_at) VALUES(?,?,?,?,?,?,?)").run(
        requiredText(initialEvent.eventKey, "initialEvent.eventKey"), episode.id, requiredText(initialEvent.eventType ?? "OPENED", "initialEvent.eventType"), null,
        requiredText(initialEvent.toState ?? episode.state, "initialEvent.toState"), encodeJson(initialEvent.evidence, {}, "initialEvent.evidence"), isoTimestamp(initialEvent.observedAt ?? openedAt, "initialEvent.observedAt"),
      );
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  structureEpisodeByKey(episodeKey) {
    const row = this.db.prepare("SELECT id,episode_key AS episodeKey,symbol,horizon_minutes AS horizonMinutes,machine_type AS machineType,machine_key AS machineKey,structure_type AS structureType,direction,state,status,strategy_name AS strategyName,strategy_version AS strategyVersion,context_json AS contextJson,opened_at AS openedAt,closed_at AS closedAt,close_reason AS closeReason,created_at AS createdAt,updated_at AS updatedAt FROM structure_episodes WHERE episode_key=?").get(requiredText(episodeKey, "episodeKey"));
    return decodeJsonFields(row, [["contextJson", "context", {}]]);
  }
  activeStructureEpisode({ symbol, horizonMinutes, machineType, machineKey }) {
    const row = this.db.prepare("SELECT episode_key AS episodeKey FROM structure_episodes WHERE symbol=? AND horizon_minutes=? AND machine_type=? AND machine_key=? AND status='OPEN'").get(
      requiredText(symbol, "symbol"), positiveInteger(horizonMinutes, "horizonMinutes"), requiredText(machineType, "machineType"), requiredText(machineKey, "machineKey"),
    );
    return row ? this.structureEpisodeByKey(row.episodeKey) : null;
  }
  recordStructureEpisodeEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Structure episode event must be an object.");
    const eventKey = requiredText(event.eventKey, "eventKey");
    const episodeId = requiredText(event.episodeId, "episodeId");
    const existing = this.db.prepare("SELECT episode_id AS episodeId,event_type AS eventType,to_state AS toState FROM structure_episode_events WHERE event_key=?").get(eventKey);
    if (existing) {
      if (existing.episodeId !== episodeId) throw new Error("eventKey already belongs to another structure episode.");
      return false;
    }
    const episode = this.db.prepare("SELECT state,status FROM structure_episodes WHERE id=?").get(episodeId);
    if (!episode) throw new Error("Structure episode does not exist.");
    if (episode.status !== "OPEN") throw new Error("Closed structure episodes are immutable.");
    const toState = requiredText(event.toState, "toState");
    const observedAt = isoTimestamp(event.observedAt, "observedAt");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO structure_episode_events(event_key,episode_id,event_type,from_state,to_state,evidence_json,observed_at) VALUES(?,?,?,?,?,?,?)").run(
        event.eventKey, event.episodeId, requiredText(event.eventType, "eventType"), episode.state, toState, encodeJson(event.evidence, {}, "evidence"), observedAt,
      );
      this.db.prepare("UPDATE structure_episodes SET state=?,context_json=?,updated_at=? WHERE id=? AND status='OPEN'").run(toState, encodeJson(event.context ?? event.evidence, {}, "context"), observedAt, event.episodeId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  closeStructureEpisode(id, closing) {
    if (!closing || typeof closing !== "object" || Array.isArray(closing)) throw new TypeError("Structure episode closing data must be an object.");
    const episode = this.db.prepare("SELECT state,status FROM structure_episodes WHERE id=?").get(requiredText(id, "id"));
    if (!episode || episode.status !== "OPEN") return false;
    const closedAt = isoTimestamp(closing.closedAt, "closedAt");
    const toState = requiredText(closing.toState ?? episode.state, "toState");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE structure_episodes SET state=?,status='CLOSED',context_json=?,closed_at=?,close_reason=?,updated_at=? WHERE id=? AND status='OPEN'").run(
        toState, encodeJson(closing.context, {}, "context"), closedAt, requiredText(closing.closeReason, "closeReason"), closedAt, id,
      );
      if (result.changes === 1) this.db.prepare("INSERT INTO structure_episode_events(event_key,episode_id,event_type,from_state,to_state,evidence_json,observed_at) VALUES(?,?,'CLOSED',?,?,?,?)").run(
        requiredText(closing.eventKey, "eventKey"), id, episode.state, toState, encodeJson(closing.evidence, {}, "evidence"), closedAt,
      );
      this.db.exec("COMMIT");
      return result.changes === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  structureEpisodeEvents(episodeId, limit = 500) {
    return this.db.prepare("SELECT id,event_key AS eventKey,episode_id AS episodeId,event_type AS eventType,from_state AS fromState,to_state AS toState,evidence_json AS evidenceJson,observed_at AS observedAt FROM structure_episode_events WHERE episode_id=? ORDER BY observed_at,id LIMIT ?").all(requiredText(episodeId, "episodeId"), boundedLimit(limit, 500, 5000))
      .map((row) => decodeJsonFields(row, [["evidenceJson", "evidence", {}]]));
  }
  upsertOrderFlowBucket(bucket) {
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) throw new TypeError("Order-flow bucket must be an object.");
    const windowMs = positiveInteger(bucket.windowMs, "windowMs");
    if (![10_000, 30_000, 60_000, 300_000].includes(windowMs)) throw new TypeError("windowMs must be one of 10000, 30000, 60000, or 300000.");
    const bucketStart = isoTimestamp(bucket.bucketStart, "bucketStart");
    const bucketEnd = isoTimestamp(bucket.bucketEnd, "bucketEnd");
    if (bucketEnd <= bucketStart) throw new TypeError("bucketEnd must follow bucketStart.");
    const generatedAt = isoTimestamp(bucket.generatedAt, "generatedAt");
    const now = isoTimestamp(bucket.updatedAt ?? generatedAt, "updatedAt");
    const id = requiredText(bucket.id, "id");
    const bucketKey = requiredText(bucket.bucketKey, "bucketKey");
    const symbol = requiredText(bucket.symbol, "symbol");
    const existingByKey = this.db.prepare("SELECT id,symbol,window_ms AS windowMs,bucket_start AS bucketStart FROM order_flow_buckets WHERE bucket_key=?").get(bucketKey);
    if (existingByKey && (existingByKey.id !== id || existingByKey.symbol !== symbol || existingByKey.windowMs !== windowMs || existingByKey.bucketStart !== bucketStart)) throw new Error("bucketKey already belongs to a different order-flow bucket identity.");
    const existingByScope = this.db.prepare("SELECT bucket_key AS bucketKey FROM order_flow_buckets WHERE symbol=? AND window_ms=? AND bucket_start=?").get(symbol, windowMs, bucketStart);
    if (existingByScope && existingByScope.bucketKey !== bucketKey) throw new Error("The order-flow bucket scope already has another bucketKey.");
    const result = this.db.prepare(`INSERT INTO order_flow_buckets(id,bucket_key,symbol,window_ms,bucket_start,bucket_end,status,synchronized,finalized,buy_notional,sell_notional,delta_notional,trade_count,cvd_notional,imbalance_5,imbalance_10,imbalance_20,microprice,microprice_deviation_bps,metrics_json,source_json,generated_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(bucket_key) DO UPDATE SET bucket_end=excluded.bucket_end,status=excluded.status,synchronized=excluded.synchronized,finalized=excluded.finalized,buy_notional=excluded.buy_notional,sell_notional=excluded.sell_notional,delta_notional=excluded.delta_notional,trade_count=excluded.trade_count,cvd_notional=excluded.cvd_notional,imbalance_5=excluded.imbalance_5,imbalance_10=excluded.imbalance_10,imbalance_20=excluded.imbalance_20,microprice=excluded.microprice,microprice_deviation_bps=excluded.microprice_deviation_bps,metrics_json=excluded.metrics_json,source_json=excluded.source_json,generated_at=excluded.generated_at,updated_at=excluded.updated_at WHERE order_flow_buckets.finalized=0`).run(
      id, bucketKey, symbol, windowMs, bucketStart, bucketEnd, requiredText(bucket.status, "status"),
      bucket.synchronized === true ? 1 : 0, bucket.finalized === true ? 1 : 0, finiteNumber(bucket.buyNotional, "buyNotional", { nullable: true }),
      finiteNumber(bucket.sellNotional, "sellNotional", { nullable: true }), finiteNumber(bucket.deltaNotional, "deltaNotional", { nullable: true }),
      bucket.tradeCount == null ? null : nonnegativeInteger(bucket.tradeCount, "tradeCount"), finiteNumber(bucket.cvdNotional, "cvdNotional", { nullable: true }),
      finiteNumber(bucket.imbalance5, "imbalance5", { minimum: -1, maximum: 1, nullable: true }), finiteNumber(bucket.imbalance10, "imbalance10", { minimum: -1, maximum: 1, nullable: true }),
      finiteNumber(bucket.imbalance20, "imbalance20", { minimum: -1, maximum: 1, nullable: true }), finiteNumber(bucket.microprice, "microprice", { minimum: Number.MIN_VALUE, nullable: true }),
      finiteNumber(bucket.micropriceDeviationBps, "micropriceDeviationBps", { nullable: true }), encodeJson(bucket.metrics, {}, "metrics"), encodeJson(bucket.source, {}, "source"),
      generatedAt, isoTimestamp(bucket.createdAt ?? generatedAt, "createdAt"), now,
    );
    if (result.changes === 0) return null;
    return this.orderFlowBucketByKey(bucket.bucketKey);
  }
  orderFlowBucketByKey(bucketKey) {
    const row = this.db.prepare("SELECT id,bucket_key AS bucketKey,symbol,window_ms AS windowMs,bucket_start AS bucketStart,bucket_end AS bucketEnd,status,synchronized,finalized,buy_notional AS buyNotional,sell_notional AS sellNotional,delta_notional AS deltaNotional,trade_count AS tradeCount,cvd_notional AS cvdNotional,imbalance_5 AS imbalance5,imbalance_10 AS imbalance10,imbalance_20 AS imbalance20,microprice,microprice_deviation_bps AS micropriceDeviationBps,metrics_json AS metricsJson,source_json AS sourceJson,generated_at AS generatedAt,created_at AS createdAt,updated_at AS updatedAt FROM order_flow_buckets WHERE bucket_key=?").get(requiredText(bucketKey, "bucketKey"));
    return decodeBooleanFields(decodeJsonFields(row, [["metricsJson", "metrics", {}], ["sourceJson", "source", {}]]), ["synchronized", "finalized"]);
  }
  orderFlowBuckets({ symbol, windowMs = null, from = null, to = null, limit = 500 } = {}) {
    const parameters = [requiredText(symbol, "symbol")];
    let sql = "SELECT bucket_key AS bucketKey FROM order_flow_buckets WHERE symbol=?";
    if (windowMs !== null) { sql += " AND window_ms=?"; parameters.push(positiveInteger(windowMs, "windowMs")); }
    if (from !== null) { sql += " AND bucket_end>=?"; parameters.push(isoTimestamp(from, "from")); }
    if (to !== null) { sql += " AND bucket_start<=?"; parameters.push(isoTimestamp(to, "to")); }
    sql += " ORDER BY bucket_start DESC LIMIT ?"; parameters.push(boundedLimit(limit, 500, 5000));
    return this.db.prepare(sql).all(...parameters).map((row) => this.orderFlowBucketByKey(row.bucketKey));
  }
  recordMarketEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("Market event must be an object.");
    const eventType = requiredText(event.eventType ?? event.type, "eventType").toUpperCase();
    const receivedAt = isoTimestamp(event.receivedAt, "receivedAt");
    const sequence = exactNumericSequence(event.sequence);
    const isCandle = eventType === "CANDLE";
    const candleOpenAt = isoTimestamp(event.candleOpenAt ?? event.candle?.openTime, "candleOpenAt", { nullable: !isCandle });
    const candleCloseAt = isoTimestamp(event.candleCloseAt ?? event.candle?.closeTime, "candleCloseAt", { nullable: !isCandle });
    if (isCandle && candleCloseAt <= candleOpenAt) throw new TypeError("Candle close must follow candle open.");
    const result = this.db.prepare(`INSERT OR IGNORE INTO market_event_journal(event_key,event_type,symbol,provider,channel,session_id,timeframe,sequence_text,sequence_numeric_text,sequence_numeric_length,source_timestamp,received_at,candle_open_at,candle_close_at,candle_closed,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      requiredText(event.eventKey, "eventKey"), eventType, requiredText(event.symbol, "symbol"), requiredText(event.provider, "provider"), requiredText(event.channel, "channel"),
      event.sessionId ?? null, event.timeframe ?? null, sequence.text, sequence.numericText, sequence.numericLength, isoTimestamp(event.sourceTimestamp, "sourceTimestamp", { nullable: true }), receivedAt,
      candleOpenAt, candleCloseAt, isCandle ? (event.candleClosed === true || event.closed === true || event.candle?.closed === true ? 1 : 0) : null,
      encodeJson(event.payload ?? event.candle ?? {}, {}, "payload"), isoTimestamp(event.createdAt ?? receivedAt, "createdAt"),
    );
    return result.changes === 1;
  }
  marketEventsForReplay({ from = null, to = null, symbols = null, closedCandlesOnly = true, limit = 10000 } = {}) {
    const conditions = [];
    const parameters = [];
    if (from !== null) { conditions.push("received_at>=?"); parameters.push(isoTimestamp(from, "from")); }
    if (to !== null) { conditions.push("received_at<=?"); parameters.push(isoTimestamp(to, "to")); }
    if (symbols !== null) {
      if (!Array.isArray(symbols) || !symbols.length) throw new TypeError("symbols must be a non-empty array when supplied.");
      conditions.push(`symbol IN (${symbols.map(() => "?").join(",")})`);
      parameters.push(...symbols.map((symbol) => requiredText(symbol, "symbol")));
    }
    if (closedCandlesOnly) conditions.push("(event_type!='CANDLE' OR candle_closed=1)");
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    parameters.push(boundedLimit(limit, 10000, 100000));
    const rows = this.db.prepare(`SELECT id,event_key AS eventKey,event_type AS eventType,symbol,provider,channel,session_id AS sessionId,timeframe,sequence_text AS sequence,source_timestamp AS sourceTimestamp,received_at AS receivedAt,candle_open_at AS candleOpenAt,candle_close_at AS candleCloseAt,candle_closed AS candleClosed,payload_json AS payloadJson,created_at AS createdAt FROM market_event_journal${where} ORDER BY received_at,CASE WHEN sequence_numeric_text IS NULL THEN 1 ELSE 0 END,sequence_numeric_length,sequence_numeric_text,sequence_text,id LIMIT ?`).all(...parameters);
    return rows.map((row) => decodeBooleanFields(decodeJsonFields(row, [["payloadJson", "payload", {}]]), ["candleClosed"]));
  }
  createReplayRun(run) {
    if (!run || typeof run !== "object" || Array.isArray(run)) throw new TypeError("Replay run must be an object.");
    const status = enumValue(run.status ?? "PENDING", ["PENDING", "RUNNING"], "status");
    const createdAt = isoTimestamp(run.createdAt, "createdAt");
    const startedAt = isoTimestamp(run.startedAt ?? (status === "RUNNING" ? createdAt : null), "startedAt", { nullable: true });
    const result = this.db.prepare(`INSERT OR IGNORE INTO replay_runs(id,run_key,schema_version,status,seed,ordering_policy,input_hash,source_json,range_from,range_to,symbols_json,options_json,metrics_json,diagnostics_json,error_text,created_at,started_at,completed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL,?)`).run(
      requiredText(run.id, "id"), requiredText(run.runKey, "runKey"), requiredText(run.schemaVersion ?? "replay-v1", "schemaVersion"), status, String(run.seed ?? 1),
      requiredText(run.orderingPolicy ?? "receivedAt+sequence", "orderingPolicy"), run.inputHash ?? null, encodeJson(run.source, {}, "source"),
      isoTimestamp(run.rangeFrom ?? run.range?.from, "rangeFrom", { nullable: true }), isoTimestamp(run.rangeTo ?? run.range?.to, "rangeTo", { nullable: true }),
      encodeJson(run.symbols, [], "symbols"), encodeJson(run.options, {}, "options"), encodeJson({}, {}, "metrics"), encodeJson({}, {}, "diagnostics"), createdAt, startedAt, createdAt,
    );
    return result.changes === 1;
  }
  replayRuns({ status = null, symbol = null, limit = 50 } = {}) {
    const conditions = [];
    const parameters = [];
    if (status !== null) { conditions.push("status=?"); parameters.push(enumValue(status, ["PENDING", "RUNNING", "COMPLETED", "FAILED"], "status")); }
    if (symbol !== null) { conditions.push("EXISTS (SELECT 1 FROM json_each(replay_runs.symbols_json) WHERE value=?)"); parameters.push(requiredText(symbol, "symbol")); }
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    parameters.push(boundedLimit(limit, 50, 500));
    return this.db.prepare(`SELECT id FROM replay_runs${where} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...parameters).map((row) => this.replayRunById(row.id));
  }
  replayRunById(id) {
    const row = this.db.prepare("SELECT id,run_key AS runKey,schema_version AS schemaVersion,status,seed,ordering_policy AS orderingPolicy,input_hash AS inputHash,source_json AS sourceJson,range_from AS rangeFrom,range_to AS rangeTo,symbols_json AS symbolsJson,options_json AS optionsJson,metrics_json AS metricsJson,diagnostics_json AS diagnosticsJson,error_text AS errorText,created_at AS createdAt,started_at AS startedAt,completed_at AS completedAt,updated_at AS updatedAt FROM replay_runs WHERE id=?").get(requiredText(id, "id"));
    return decodeJsonFields(row, [["sourceJson", "source", {}], ["symbolsJson", "symbols", []], ["optionsJson", "options", {}], ["metricsJson", "metrics", {}], ["diagnosticsJson", "diagnostics", {}]]);
  }
  updateReplayRunStatus(id, update) {
    if (!update || typeof update !== "object" || Array.isArray(update)) throw new TypeError("Replay run update must be an object.");
    const run = this.replayRunById(id);
    if (!run) return false;
    const status = enumValue(update.status, ["RUNNING", "COMPLETED", "FAILED"], "status");
    const allowed = run.status === "PENDING" ? ["RUNNING", "FAILED"] : run.status === "RUNNING" ? ["COMPLETED", "FAILED"] : [];
    if (!allowed.includes(status)) throw new Error(`Invalid replay run transition ${run.status} -> ${status}.`);
    const updatedAt = isoTimestamp(update.updatedAt ?? update.completedAt ?? update.startedAt, "updatedAt");
    const startedAt = status === "RUNNING" ? isoTimestamp(update.startedAt ?? updatedAt, "startedAt") : run.startedAt;
    const completedAt = ["COMPLETED", "FAILED"].includes(status) ? isoTimestamp(update.completedAt ?? updatedAt, "completedAt") : null;
    const result = this.db.prepare("UPDATE replay_runs SET status=?,metrics_json=?,diagnostics_json=?,error_text=?,started_at=?,completed_at=?,updated_at=? WHERE id=? AND status=?").run(
      status, encodeJson(update.metrics ?? run.metrics, {}, "metrics"), encodeJson(update.diagnostics ?? run.diagnostics, {}, "diagnostics"), update.errorText ?? null,
      startedAt, completedAt, updatedAt, id, run.status,
    );
    return result.changes === 1;
  }
  createReplayPrediction(prediction) {
    if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) throw new TypeError("Replay prediction must be an object.");
    const run = this.replayRunById(prediction.runId);
    if (!run) throw new Error("Replay run does not exist.");
    if (!["PENDING", "RUNNING"].includes(run.status)) throw new Error("Replay predictions cannot be added to a finished run.");
    const generatedAt = isoTimestamp(prediction.generatedAt, "generatedAt");
    const resolvesAt = isoTimestamp(prediction.resolvesAt, "resolvesAt");
    if (resolvesAt <= generatedAt) throw new TypeError("resolvesAt must follow generatedAt.");
    const result = this.db.prepare(`INSERT OR IGNORE INTO replay_predictions(id,run_id,prediction_key,evaluator,symbol,horizon_minutes,generated_at,resolves_at,entry_price,predicted_direction,probability_up,features_json,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      requiredText(prediction.id, "id"), requiredText(prediction.runId, "runId"), requiredText(prediction.predictionKey, "predictionKey"), requiredText(prediction.evaluator, "evaluator"),
      requiredText(prediction.symbol, "symbol"), positiveInteger(prediction.horizonMinutes, "horizonMinutes"), generatedAt, resolvesAt,
      finiteNumber(prediction.entryPrice, "entryPrice", { minimum: Number.MIN_VALUE }), enumValue(prediction.predictedDirection, ["UP", "DOWN", "NEUTRAL"], "predictedDirection"),
      finiteNumber(prediction.probabilityUp, "probabilityUp", { minimum: 0, maximum: 1 }), encodeJson(prediction.features, {}, "features"),
      encodeJson(prediction.metadata, {}, "metadata"), isoTimestamp(prediction.createdAt ?? generatedAt, "createdAt"),
    );
    return result.changes === 1;
  }
  resolveReplayPrediction(id, resolution) {
    if (!resolution || typeof resolution !== "object" || Array.isArray(resolution)) throw new TypeError("Replay prediction resolution must be an object.");
    const predictionId = requiredText(id, "id");
    const prediction = this.db.prepare("SELECT resolves_at AS resolvesAt,outcome FROM replay_predictions WHERE id=?").get(predictionId);
    if (!prediction || prediction.outcome !== null) return false;
    const resolvedAt = isoTimestamp(resolution.resolvedAt, "resolvedAt");
    const observedAt = isoTimestamp(resolution.resolutionObservedAt, "resolutionObservedAt");
    const candleCloseAt = isoTimestamp(resolution.resolutionCandleCloseAt, "resolutionCandleCloseAt", { nullable: true });
    if (observedAt < prediction.resolvesAt) throw new TypeError("Replay resolution cannot be observed before the prediction horizon.");
    if (resolvedAt < observedAt) throw new TypeError("resolvedAt cannot precede resolutionObservedAt.");
    if (candleCloseAt && (candleCloseAt < prediction.resolvesAt || candleCloseAt > observedAt)) throw new TypeError("Resolution candle close must be between the prediction horizon and observation time.");
    const result = this.db.prepare("UPDATE replay_predictions SET outcome=?,actual_direction=?,resolution_price=?,resolution_observed_at=?,resolution_candle_close_at=?,resolved_at=? WHERE id=? AND outcome IS NULL").run(
      requiredText(resolution.outcome, "outcome"), enumValue(resolution.actualDirection, ["UP", "DOWN", "TIE"], "actualDirection"),
      finiteNumber(resolution.resolutionPrice, "resolutionPrice", { minimum: Number.MIN_VALUE }), observedAt, candleCloseAt, resolvedAt, predictionId,
    );
    return result.changes === 1;
  }
  replayPredictions({ runId, evaluator = null, unresolvedOnly = false, limit = 10000 } = {}) {
    const parameters = [requiredText(runId, "runId")];
    let sql = "SELECT id,run_id AS runId,prediction_key AS predictionKey,evaluator,symbol,horizon_minutes AS horizonMinutes,generated_at AS generatedAt,resolves_at AS resolvesAt,entry_price AS entryPrice,predicted_direction AS predictedDirection,probability_up AS probabilityUp,features_json AS featuresJson,metadata_json AS metadataJson,outcome,actual_direction AS actualDirection,resolution_price AS resolutionPrice,resolution_observed_at AS resolutionObservedAt,resolution_candle_close_at AS resolutionCandleCloseAt,resolved_at AS resolvedAt,created_at AS createdAt FROM replay_predictions WHERE run_id=?";
    if (evaluator) { sql += " AND evaluator=?"; parameters.push(requiredText(evaluator, "evaluator")); }
    if (unresolvedOnly) sql += " AND outcome IS NULL";
    sql += " ORDER BY generated_at,id LIMIT ?"; parameters.push(boundedLimit(limit, 10000, 100000));
    return this.db.prepare(sql).all(...parameters).map((row) => decodeJsonFields(row, [["featuresJson", "features", {}], ["metadataJson", "metadata", {}]]));
  }
  replayTrainingPredictions({ runId, before, evaluator = null, limit = 50000 } = {}) {
    const parameters = [requiredText(runId, "runId"), isoTimestamp(before, "before")];
    let sql = "SELECT id,prediction_key AS predictionKey,evaluator,symbol,horizon_minutes AS horizonMinutes,generated_at AS generatedAt,resolved_at AS resolvedAt,predicted_direction AS predictedDirection,actual_direction AS actualDirection,probability_up AS probabilityUp,outcome FROM replay_predictions WHERE run_id=? AND outcome IS NOT NULL AND resolved_at<?";
    if (evaluator) { sql += " AND evaluator=?"; parameters.push(requiredText(evaluator, "evaluator")); }
    sql += " ORDER BY generated_at,id LIMIT ?"; parameters.push(boundedLimit(limit, 50000, 100000));
    return this.db.prepare(sql).all(...parameters);
  }
  createWalkForwardFold(fold) {
    if (!fold || typeof fold !== "object" || Array.isArray(fold)) throw new TypeError("Walk-forward fold must be an object.");
    const trainStart = isoTimestamp(fold.trainStart, "trainStart");
    const trainEnd = isoTimestamp(fold.trainEnd, "trainEnd");
    const testStart = isoTimestamp(fold.testStart, "testStart");
    const testEnd = isoTimestamp(fold.testEnd, "testEnd");
    if (trainEnd < trainStart || testEnd < testStart || trainEnd >= testStart) throw new TypeError("Walk-forward intervals must be ordered and training must precede testing.");
    const trainIds = fold.trainIds ?? [];
    const testIds = fold.testIds ?? [];
    if (!Array.isArray(trainIds) || !Array.isArray(testIds) || trainIds.length !== fold.trainSize || testIds.length !== fold.testSize) throw new TypeError("Fold ID arrays must match trainSize and testSize.");
    const result = this.db.prepare(`INSERT OR IGNORE INTO walk_forward_folds(id,run_id,evaluator,fold_index,mode,train_start,train_end,test_start,test_end,train_size,test_size,train_ids_json,test_ids_json,train_metrics_json,test_metrics_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      requiredText(fold.id, "id"), requiredText(fold.runId, "runId"), requiredText(fold.evaluator, "evaluator"), nonnegativeInteger(fold.foldIndex ?? fold.index, "foldIndex"),
      requiredText(fold.mode, "mode").toLowerCase(), trainStart, trainEnd, testStart, testEnd, positiveInteger(fold.trainSize, "trainSize"), positiveInteger(fold.testSize, "testSize"),
      encodeJson(trainIds, [], "trainIds"), encodeJson(testIds, [], "testIds"), encodeJson(fold.trainMetrics, {}, "trainMetrics"), encodeJson(fold.testMetrics, {}, "testMetrics"),
      isoTimestamp(fold.createdAt, "createdAt"),
    );
    return result.changes === 1;
  }
  walkForwardFolds(runId, evaluator = null) {
    const rows = evaluator
      ? this.db.prepare("SELECT * FROM walk_forward_folds WHERE run_id=? AND evaluator=? ORDER BY fold_index").all(requiredText(runId, "runId"), requiredText(evaluator, "evaluator"))
      : this.db.prepare("SELECT * FROM walk_forward_folds WHERE run_id=? ORDER BY evaluator,fold_index").all(requiredText(runId, "runId"));
    return rows.map((row) => {
      const decoded = decodeJsonFields({
        id: row.id, runId: row.run_id, evaluator: row.evaluator, foldIndex: row.fold_index, mode: row.mode, trainStart: row.train_start, trainEnd: row.train_end,
        testStart: row.test_start, testEnd: row.test_end, trainSize: row.train_size, testSize: row.test_size, trainIdsJson: row.train_ids_json,
        testIdsJson: row.test_ids_json, trainMetricsJson: row.train_metrics_json, testMetricsJson: row.test_metrics_json, createdAt: row.created_at,
      }, [["trainIdsJson", "trainIds", []], ["testIdsJson", "testIds", []], ["trainMetricsJson", "trainMetrics", {}], ["testMetricsJson", "testMetrics", {}]]);
      return decoded;
    });
  }
  sourceEvent(event) {
    this.db.prepare("INSERT INTO data_source_events(source_name,symbol,status,source_timestamp,received_at,latency_ms,message) VALUES(?,?,?,?,?,?,?)").run(event.sourceName, event.symbol ?? null, event.status, event.sourceTimestamp ?? null, event.receivedAt, event.latencyMs ?? null, event.message ?? null);
  }
  close() { this.db.close(); }
}
