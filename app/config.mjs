import { resolve } from "node:path";

function numberValue(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`${name} has an invalid value`);
  return value;
}
function booleanValue(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}
function listValue(name, fallback, map = (value) => value) {
  const values = (process.env[name] ?? fallback).split(",").map((value) => map(value.trim())).filter((value) => value !== "");
  if (!values.length || new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values;
}

const supportedSymbols = new Set(["BTCUSDT", "ETHUSDT"]);
const symbols = listValue("MARKET_SYMBOLS", "BTCUSDT,ETHUSDT", (value) => value.toUpperCase());
if (symbols.some((symbol) => !supportedSymbols.has(symbol))) throw new Error("MARKET_SYMBOLS supports BTCUSDT and ETHUSDT only");
const tradingMode = process.env.TRADING_MODE ?? "paper";
if (!new Set(["read-only", "paper"]).has(tradingMode)) throw new Error("TRADING_MODE must be read-only or paper");
const autonomousSymbols = listValue("AUTONOMOUS_SYMBOLS", "BTCUSDT,ETHUSDT", (value) => value.toUpperCase());
if (autonomousSymbols.some((symbol) => !supportedSymbols.has(symbol) || !symbols.includes(symbol))) throw new Error("AUTONOMOUS_SYMBOLS must be configured BTCUSDT/ETHUSDT market symbols");
const autonomousHorizons = listValue("AUTONOMOUS_HORIZONS", "10,30", Number);
if (autonomousHorizons.some((horizon) => ![10, 30].includes(horizon))) throw new Error("AUTONOMOUS_HORIZONS supports 10 and 30 only");
const profileAliases = { ADAPTIVE: "ADAPTIVE_CAPPED", FLAT: "FLAT", ADAPTIVE_CAPPED: "ADAPTIVE_CAPPED", OBSERVED: "OBSERVED_10_30_90_270", OBSERVED_10_30_90_270: "OBSERVED_10_30_90_270" };
const autonomousProfile = profileAliases[(process.env.AUTONOMOUS_STAKE_PROFILE ?? "adaptive").trim().toUpperCase()];
if (!autonomousProfile) throw new Error("AUTONOMOUS_STAKE_PROFILE must be flat, adaptive, or observed");
const observedLadder = listValue("AUTONOMOUS_OBSERVED_LADDER", "10,30,90,270", Number);
if (observedLadder.length !== 4 || observedLadder.some((stake) => !Number.isFinite(stake) || stake <= 0)) throw new Error("AUTONOMOUS_OBSERVED_LADDER must contain four positive stakes");
const baseStakeFraction = numberValue("AUTONOMOUS_BASE_STAKE_FRACTION", 0.005, { min: 0.0001, max: 1 });
const maxStakeFraction = numberValue("AUTONOMOUS_MAX_STAKE_FRACTION", 0.02, { min: 0.0001, max: 1 });
if (maxStakeFraction < baseStakeFraction) throw new Error("AUTONOMOUS_MAX_STAKE_FRACTION must be at least the base fraction");
const qualityThresholds = Object.freeze({
  standard: numberValue("AUTONOMOUS_STANDARD_THRESHOLD", 68, { min: 0, max: 100, integer: true }),
  high: numberValue("AUTONOMOUS_HIGH_THRESHOLD", 78, { min: 0, max: 100, integer: true }),
  exceptional: numberValue("AUTONOMOUS_EXCEPTIONAL_THRESHOLD", 88, { min: 0, max: 100, integer: true }),
});
if (!(qualityThresholds.standard < qualityThresholds.high && qualityThresholds.high < qualityThresholds.exceptional)) throw new Error("Autonomous quality thresholds must increase from STANDARD to HIGH to EXCEPTIONAL");

const explicitPrimaryMarketUrl = process.env.PRIMARY_MARKET_BASE_URL ?? process.env.BINANCE_SPOT_BASE_URL;
const legacyFallbackUrl = process.env.FALLBACK_MARKET_BASE_URL;
const legacyBinanceFallback = !explicitPrimaryMarketUrl && /binance/i.test(legacyFallbackUrl ?? "");
const primaryMarketBaseUrl = (explicitPrimaryMarketUrl ?? "https://data-api.binance.vision").replace(/\/$/, "");
const fallbackMarketBaseUrl = (legacyBinanceFallback ? (process.env.MEXC_SPOT_BASE_URL ?? "https://api.mexc.com") : legacyFallbackUrl ?? process.env.MEXC_SPOT_BASE_URL ?? "https://api.mexc.com").replace(/\/$/, "");

export const config = Object.freeze({
  instance: (process.env.SIGNAL_EXPERT_INSTANCE ?? "default").trim() || "default",
  host: process.env.API_HOST ?? "127.0.0.1",
  port: numberValue("API_PORT", 4100, { min: 1, max: 65535, integer: true }),
  primaryMarketBaseUrl,
  fallbackMarketBaseUrl,
  marketFailoverEnabled: booleanValue("MARKET_FAILOVER_ENABLED", true),
  marketStreamEnabled: booleanValue("MARKET_STREAM_ENABLED", false),
  binanceWsUrl: (process.env.BINANCE_WS_URL ?? "wss://stream.binance.com:9443").replace(/\/$/, ""),
  streamReconnectMinMs: numberValue("STREAM_RECONNECT_MIN_MS", 1000, { min: 250, max: 30000, integer: true }),
  streamReconnectMaxMs: numberValue("STREAM_RECONNECT_MAX_MS", 30000, { min: 1000, max: 300000, integer: true }),
  streamStaleAfterMs: numberValue("STREAM_STALE_AFTER_MS", 15000, { min: 3000, max: 300000, integer: true }),
  streamReconcileMs: numberValue("STREAM_RECONCILE_MS", 60000, { min: 10000, max: 3600000, integer: true }),
  providerTimeoutMs: numberValue("PROVIDER_TIMEOUT_MS", 5000, { min: 1000, max: 30000, integer: true }),
  providerAttempts: numberValue("PROVIDER_ATTEMPTS", 2, { min: 1, max: 5, integer: true }),
  symbols,
  tickerPollMs: numberValue("TICKER_POLL_MS", 3000, { min: 1000, integer: true }),
  candlePollMs: numberValue("CANDLE_POLL_MS", 5000, { min: 5000, integer: true }),
  staleAfterMs: numberValue("STALE_AFTER_MS", 30000, { min: 5000, integer: true }),
  eventRiskEnabled: booleanValue("EVENT_RISK_ENABLED", false),
  eventRiskBaseUrl: (process.env.EVENT_RISK_BASE_URL ?? "https://api.tradingeconomics.com").replace(/\/$/, ""),
  eventRiskApiKey: (process.env.EVENT_RISK_API_KEY ?? "").trim(),
  eventRiskPollMs: numberValue("EVENT_RISK_POLL_MS", 300000, { min: 60000, integer: true }),
  eventRiskStaleAfterMs: numberValue("EVENT_RISK_STALE_AFTER_MS", 900000, { min: 60000, integer: true }),
  eventRiskPreWindowMs: numberValue("EVENT_RISK_PRE_WINDOW_MS", 1800000, { min: 0, max: 86400000, integer: true }),
  eventRiskPostWindowMs: numberValue("EVENT_RISK_POST_WINDOW_MS", 900000, { min: 0, max: 86400000, integer: true }),
  eventRiskMinImportance: numberValue("EVENT_RISK_MIN_IMPORTANCE", 3, { min: 1, max: 3, integer: true }),
  triggerGraceMs: numberValue("ENTRY_TRIGGER_GRACE_MS", 90000, { min: 5000, max: 300000, integer: true }),
  btcMaxSpreadBps: numberValue("ENTRY_BTC_MAX_SPREAD_BPS", 2, { min: 0.01, max: 100 }),
  ethMaxSpreadBps: numberValue("ENTRY_ETH_MAX_SPREAD_BPS", 3, { min: 0.01, max: 100 }),
  minTopNotional: numberValue("ENTRY_MIN_TOP_NOTIONAL_USDT", 100, { min: 0 }),
  maxSourceSkewMs: numberValue("ENTRY_MAX_SOURCE_SKEW_MS", 10000, { min: 0, max: 300000, integer: true }),
  databasePath: resolve(process.env.DATABASE_PATH ?? "data/signal-expert.db"),
  publicDirectory: resolve(process.env.PUBLIC_DIRECTORY ?? "public"),
  migrationDirectory: resolve(process.env.MIGRATION_DIRECTORY ?? "migrations"),
  payoutRate: numberValue("PAPER_PAYOUT_RATE", 0.8, { min: 0.01, max: 2 }),
  initialBankroll: numberValue("PAPER_INITIAL_BANKROLL", 500, { min: 1 }),
  dailyLossLimit: numberValue("PAPER_DAILY_LOSS_LIMIT", 10, { min: 0.01 }),
  maxOpenPositions: numberValue("PAPER_MAX_OPEN_POSITIONS", 2, { min: 1, max: 5, integer: true }),
  btcMaxStake: numberValue("PAPER_BTC_MAX_STAKE", 250, { min: 1 }),
  ethMaxStake: numberValue("PAPER_ETH_MAX_STAKE", 150, { min: 1 }),
  autonomousEnabled: booleanValue("AUTONOMOUS_ENABLED", true),
  autonomousProfile,
  autonomousScanMs: numberValue("AUTONOMOUS_SCAN_MS", 5000, { min: 1000, integer: true }),
  autonomousSymbols,
  autonomousHorizons,
  baseStakeFraction,
  maxStakeFraction,
  absoluteStakeCap: numberValue("AUTONOMOUS_ABSOLUTE_STAKE_CAP", 25, { min: 0.01 }),
  dailyProfitTarget: numberValue("AUTONOMOUS_DAILY_PROFIT_TARGET", 100, { min: 0.01 }),
  autonomousDailyLossLimit: numberValue("AUTONOMOUS_DAILY_LOSS_LIMIT", 10, { min: 0.01 }),
  autonomousSegmentGateEnabled: booleanValue("AUTONOMOUS_SEGMENT_GATE_ENABLED", true),
  autonomousSegmentMinSample: numberValue("AUTONOMOUS_SEGMENT_MIN_SAMPLE", 20, { min: 1, integer: true }),
  manualSignalsEnabled: booleanValue("MANUAL_SIGNALS_ENABLED", tradingMode === "paper"),
  manualSignalScanMs: numberValue("MANUAL_SIGNAL_SCAN_MS", 3000, { min: 1000, max: 60000, integer: true }),
  manualSignalEntryWindowMs: numberValue("MANUAL_SIGNAL_ENTRY_WINDOW_MS", 30000, { min: 5000, max: 120000, integer: true }),
  manualSignalMaxResolutionLagMs: numberValue("MANUAL_SIGNAL_MAX_RESOLUTION_LAG_MS", 30000, { min: 1000, max: 300000, integer: true }),
  manualSignalMinDecisiveSample: numberValue("MANUAL_SIGNAL_MIN_DECISIVE_SAMPLE", 20, { min: 1, max: 10000, integer: true }),
  forecastCalibrationMinSample: numberValue("FORECAST_CALIBRATION_MIN_SAMPLE", 50, { min: 10, max: 10000, integer: true }),
  manualSignalConfidenceGateEnabled: booleanValue("MANUAL_SIGNAL_CONFIDENCE_GATE_ENABLED", true),
  qualityThresholds,
  observedLadder,
  tradingMode,
});
