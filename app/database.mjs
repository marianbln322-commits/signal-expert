import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    this.db.prepare(`INSERT INTO signal_snapshots(symbol,direction,up_score,down_score,model_version,source_timestamp,calculated_at,payload_json) VALUES(?,?,?,?,?,?,?,?)`).run(symbol, analysis.direction, analysis.upScore, analysis.downScore, analysis.modelVersion, sourceTimestamp, analysis.calculatedAt, JSON.stringify(analysis));
  }
  upsertPosition(position) {
    this.db.prepare(`INSERT INTO paper_positions(id,symbol,direction,horizon_minutes,stake,payout_rate,entry_price,opened_at,resolves_at,status,settlement_price,settled_at,pnl,signal_version,source_name,source_timestamp,settlement_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,settlement_price=excluded.settlement_price,settled_at=excluded.settled_at,pnl=excluded.pnl,settlement_reason=excluded.settlement_reason`).run(
      position.id, position.symbol, position.direction, position.horizonMinutes, position.stake, position.payoutRate, position.entryPrice,
      position.openedAt, position.resolvesAt, position.status, position.settlementPrice, position.settledAt, position.pnl,
      position.signalVersion, position.sourceName, position.sourceTimestamp, position.settlementReason ?? null,
    );
  }
  positions() {
    return this.db.prepare(`SELECT id,symbol,direction,horizon_minutes AS horizonMinutes,stake,payout_rate AS payoutRate,entry_price AS entryPrice,opened_at AS openedAt,resolves_at AS resolvesAt,status,settlement_price AS settlementPrice,settled_at AS settledAt,pnl,signal_version AS signalVersion,source_name AS sourceName,source_timestamp AS sourceTimestamp,settlement_reason AS settlementReason FROM paper_positions ORDER BY opened_at DESC`).all();
  }
  sourceEvent(event) {
    this.db.prepare(`INSERT INTO data_source_events(source_name,symbol,status,source_timestamp,received_at,latency_ms,message) VALUES(?,?,?,?,?,?,?)`).run(event.sourceName, event.symbol ?? null, event.status, event.sourceTimestamp ?? null, event.receivedAt, event.latencyMs ?? null, event.message ?? null);
  }
  close() { this.db.close(); }
}
