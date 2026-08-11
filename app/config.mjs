import { resolve } from "node:path";

function numberValue(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} has an invalid value`);
  }
  return value;
}

const supportedSymbols = new Set(["BTCUSDT", "ETHUSDT"]);
const symbols = (process.env.MARKET_SYMBOLS ?? "BTCUSDT,ETHUSDT").split(",").map((item) => item.trim().toUpperCase()).filter(Boolean);
if (!symbols.length || symbols.some((symbol) => !supportedSymbols.has(symbol))) throw new Error("MARKET_SYMBOLS supports BTCUSDT and ETHUSDT only");
const tradingMode = process.env.TRADING_MODE ?? "paper";
if (!new Set(["read-only", "paper"]).has(tradingMode)) throw new Error("TRADING_MODE must be read-only or paper");

export const config = Object.freeze({
  host: process.env.API_HOST ?? "127.0.0.1",
  port: numberValue("API_PORT", 4100, { min: 1, max: 65535, integer: true }),
  mexcBaseUrl: (process.env.MEXC_SPOT_BASE_URL ?? "https://api.mexc.com").replace(/\/$/, ""),
  symbols,
  tickerPollMs: numberValue("TICKER_POLL_MS", 3000, { min: 1000, integer: true }),
  candlePollMs: numberValue("CANDLE_POLL_MS", 15000, { min: 5000, integer: true }),
  staleAfterMs: numberValue("STALE_AFTER_MS", 30000, { min: 5000, integer: true }),
  databasePath: resolve(process.env.DATABASE_PATH ?? "data/signal-expert.db"),
  publicDirectory: resolve(process.env.PUBLIC_DIRECTORY ?? "public"),
  migrationDirectory: resolve(process.env.MIGRATION_DIRECTORY ?? "migrations"),
  payoutRate: numberValue("PAPER_PAYOUT_RATE", 0.8, { min: 0.01, max: 2 }),
  initialBankroll: numberValue("PAPER_INITIAL_BANKROLL", 1200, { min: 1 }),
  dailyLossLimit: numberValue("PAPER_DAILY_LOSS_LIMIT", 60, { min: 1 }),
  maxOpenPositions: numberValue("PAPER_MAX_OPEN_POSITIONS", 2, { min: 1, max: 5, integer: true }),
  btcMaxStake: numberValue("PAPER_BTC_MAX_STAKE", 250, { min: 1 }),
  ethMaxStake: numberValue("PAPER_ETH_MAX_STAKE", 150, { min: 1 }),
  tradingMode,
});
