import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.mjs";
import { Database } from "./database.mjs";
import { FailoverMarketProvider, MexcSpotProvider } from "./mexc-provider.mjs";
import { MarketService } from "./market-service.mjs";
import { PaperService } from "./paper-service.mjs";
import { AutonomousService } from "./autonomous-service.mjs";
import { ManualSignalService } from "./manual-signal-service.mjs";
import { EventRiskService, TradingEconomicsCalendarProvider } from "./event-risk-service.mjs";
import { BinanceSpotStream } from "./binance-stream-provider.mjs";
import { FeedObservabilityService } from "./feed-observability-service.mjs";
import { StructureStateService } from "./structure-state-service.mjs";
import { AlertService } from "./alert-service.mjs";
import { OperationalService } from "./operational-service.mjs";
import { CalibrationService } from "./calibration-service.mjs";
import { ReplayService, REPLAY_BASELINES } from "./replay-service.mjs";
import { OrderBookService } from "./order-book-service.mjs";
import { OrderFlowAnalyzer } from "./order-flow.mjs";

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
function sendJson(response, status, value, headers = {}) { response.writeHead(status, { ...jsonHeaders, ...headers }); response.end(JSON.stringify(value)); }
async function body(request, limit = 65536) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw new Error("Request body too large"); chunks.push(chunk); } if (!chunks.length) return {}; try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Invalid JSON body"); } }
function validatePaper(value) {
  if (!value || typeof value !== "object") throw new Error("Invalid paper position");
  if (!["BTCUSDT", "ETHUSDT"].includes(value.symbol)) throw new Error("Invalid symbol");
  if (!["UP", "DOWN"].includes(value.direction)) throw new Error("Invalid direction");
  if (![10, 30].includes(value.horizonMinutes)) throw new Error("Invalid horizon");
  if (!Number.isFinite(value.stake)) throw new Error("Invalid stake");
  return { symbol: value.symbol, direction: value.direction, horizonMinutes: value.horizonMinutes, stake: value.stake };
}
function validateQuote(value) {
  if (!value || typeof value !== "object" || !["BTCUSDT", "ETHUSDT"].includes(value.symbol)) throw new Error("Invalid risk request");
  for (const key of ["cumulativeLoss", "targetProfit", "baseStake"]) if (!Number.isFinite(value[key]) || value[key] < 0) throw new Error(`Invalid ${key}`);
  if (value.baseStake <= 0 || (value.estimatedProbability !== null && (!Number.isFinite(value.estimatedProbability) || value.estimatedProbability < 0 || value.estimatedProbability > 1))) throw new Error("Invalid probability or stake");
  return { symbol: value.symbol, cumulativeLoss: value.cumulativeLoss, targetProfit: value.targetProfit, baseStake: value.baseStake, estimatedProbability: value.estimatedProbability };
}

function validateAutonomousAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !["pause", "resume"].includes(value.action)) throw new Error("Invalid autonomous state action");
  return value.action;
}

function validateQuery(url, allowed = []) {
  const names = new Set(allowed);
  for (const key of url.searchParams.keys()) if (!names.has(key)) throw new Error(`Invalid query parameter: ${key}`);
  for (const key of names) if (url.searchParams.getAll(key).length > 1) throw new Error(`Invalid duplicate query parameter: ${key}`);
}
function querySymbol(url, { required = false } = {}) {
  const raw = url.searchParams.get("symbol");
  if (raw === null) { if (required) throw new Error("Invalid symbol query"); return null; }
  const symbol = raw.toUpperCase();
  if (!config.symbols.includes(symbol) || raw !== raw.trim() || !/^[A-Za-z0-9]+$/.test(raw)) throw new Error("Invalid symbol query");
  return symbol;
}
function queryLimit(url, fallback, maximum = 500) {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error("Invalid limit query");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error("Invalid limit query");
  return value;
}
function queryEnum(url, name, allowed) {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const value = raw.toUpperCase();
  if (!allowed.includes(value) || raw !== raw.trim()) throw new Error(`Invalid ${name} query`);
  return value;
}

export async function createApplication(options = {}) {
  const database = options.database ?? new Database(config.databasePath, config.migrationDirectory);
  const provider = options.provider ?? new FailoverMarketProvider(
    new MexcSpotProvider(config.primaryMarketBaseUrl, { timeoutMs: config.providerTimeoutMs, attempts: config.providerAttempts }),
    config.marketFailoverEnabled ? new MexcSpotProvider(config.fallbackMarketBaseUrl, { timeoutMs: config.providerTimeoutMs, attempts: config.providerAttempts }) : null,
  );
  const eventRiskProvider = options.eventRiskProvider ?? (config.eventRiskApiKey ? new TradingEconomicsCalendarProvider(config.eventRiskBaseUrl, config.eventRiskApiKey, { timeoutMs: config.providerTimeoutMs }) : null);
  const eventRisk = options.eventRisk ?? new EventRiskService({ provider: eventRiskProvider, enabled: config.eventRiskEnabled, pollMs: config.eventRiskPollMs, staleAfterMs: config.eventRiskStaleAfterMs, preWindowMs: config.eventRiskPreWindowMs, postWindowMs: config.eventRiskPostWindowMs, minImportance: config.eventRiskMinImportance });
  const entryPolicy = {
    eventRiskEnabled: config.eventRiskEnabled,
    triggerGraceMs: config.triggerGraceMs,
    qualityThreshold: config.qualityThresholds.standard,
    maxSpreadBpsBySymbol: { BTCUSDT: config.btcMaxSpreadBps, ETHUSDT: config.ethMaxSpreadBps },
    minTopNotional: config.minTopNotional,
    maxSourceSkewMs: config.maxSourceSkewMs,
    feedRequired: config.marketStreamEnabled,
  };
  const alertService = options.alertService ?? new AlertService({ database, cooldownMs: config.alertCooldownMs, hysteresisMs: config.alertHysteresisMs });
  const operationalService = options.operationalService ?? new OperationalService({ alertService, windowSize: config.operationalWindowSize, stallAfterMs: config.operationalStallAfterMs });
  const observability = options.observability ?? new FeedObservabilityService({ database, staleAfterMs: config.streamStaleAfterMs, alertService, operationalService });
  const structureState = options.structureState ?? new StructureStateService({ database });
  const stream = options.stream ?? (config.marketStreamEnabled ? new BinanceSpotStream({ baseUrl: config.binanceWsUrl, symbols: config.symbols, reconnectMinMs: config.streamReconnectMinMs, reconnectMaxMs: config.streamReconnectMaxMs, observability }) : null);
  const primaryProvider = provider.primary ?? provider;
  const fallbackProvider = provider.fallback ?? null;
  const orderBook = options.orderBook ?? new OrderBookService({ symbols: config.symbols, provider: primaryProvider, fallbackProvider, depthLimit: config.depthSnapshotLimit, topLevelLimit: config.depthTopLevelLimit, maxLevels: config.depthMaxLevels, maxBufferEvents: config.depthMaxBufferEvents });
  const orderFlow = options.orderFlow ?? new OrderFlowAnalyzer({ symbols: config.symbols, staleAfterMs: config.orderFlowStaleAfterMs, tradeStaleAfterMs: config.orderFlowTradeStaleAfterMs, retentionMs: config.orderFlowRetentionMs, liquidityWindowMs: config.orderFlowLiquidityWindowMs, spoofLifetimeMs: config.orderFlowSpoofLifetimeMs, maxTrades: config.orderFlowMaxTrades, trackedLevels: config.depthTopLevelLimit, maxBookLevels: config.depthMaxLevels });
  const calibrationService = options.calibrationService ?? new CalibrationService({ database, minSample: config.forecastCalibrationMinSample, binCount: config.calibrationBinCount, threshold: config.calibrationThreshold });
  const replayService = options.replayService ?? new ReplayService({ horizons: [10, 30], baselines: true });
  const market = options.market ?? new MarketService({ provider, symbols: config.symbols, staleAfterMs: config.staleAfterMs, payoutRate: config.payoutRate, database, candidateThresholds: config.qualityThresholds, eventRisk, entryPolicy, stream, streamEnabled: config.marketStreamEnabled, observability, operationalService, alertService, structureState, orderBook, orderFlow, reconcileMs: config.streamReconcileMs });
  const paper = new PaperService({ market, database, settings: { payoutRate: config.payoutRate, initialBankroll: config.initialBankroll, dailyLossLimit: config.dailyLossLimit, maxOpenPositions: config.maxOpenPositions, btcMaxStake: config.btcMaxStake, ethMaxStake: config.ethMaxStake } });
  const autonomous = new AutonomousService({ market, paper, database, settings: {
    enabled: config.autonomousEnabled && config.tradingMode === "paper", profile: config.autonomousProfile, scanMs: config.autonomousScanMs,
    symbols: config.autonomousSymbols, horizons: config.autonomousHorizons, baseFraction: config.baseStakeFraction, maxFraction: config.maxStakeFraction,
    absoluteCap: config.absoluteStakeCap, dailyProfitTarget: config.dailyProfitTarget, dailyLossLimit: config.autonomousDailyLossLimit,
    segmentGateEnabled: config.autonomousSegmentGateEnabled, segmentMinSample: config.autonomousSegmentMinSample,
    thresholds: config.qualityThresholds, observedLadder: config.observedLadder, payoutRate: config.payoutRate,
  } });
  const manualSignals = options.manualSignals ?? new ManualSignalService({ market, database, calibrationService, alertService, operationalService, settings: {
    enabled: config.manualSignalsEnabled && config.tradingMode === "paper",
    scanMs: config.manualSignalScanMs,
    entryWindowMs: config.manualSignalEntryWindowMs,
    maxResolutionLagMs: config.manualSignalMaxResolutionLagMs,
    minDecisiveSample: config.manualSignalMinDecisiveSample,
    forecastCalibrationMinSample: config.forecastCalibrationMinSample,
    confidenceGateEnabled: config.manualSignalConfidenceGateEnabled,
    qualityThreshold: config.qualityThresholds.standard,
    payoutRate: config.payoutRate,
    symbols: config.symbols,
    horizons: [10, 30],
  } });
  const alertsSnapshot = ({ symbol = null, status = null, limit = 100 } = {}) => (alertService.list({ status, limit: symbol === null ? limit : 500 }) ?? []).filter((alert) => symbol === null || alert.symbol === symbol).slice(0, limit);
  const calibrationSnapshot = (symbol = null) => ({
    classification: "PROSPECTIVE_SPOT_PROXY_CALIBRATION_RESEARCH_ONLY",
    liveExecutionAvailable: false,
    status: calibrationService.status(symbol),
    segments: manualSignals.forecastCalibration(symbol),
    metrics: typeof database.calibrationMetricSnapshots === "function" ? database.calibrationMetricSnapshots({ symbol, limit: 100 }) : [],
    policy: { minSample: config.forecastCalibrationMinSample, binCount: config.calibrationBinCount, threshold: config.calibrationThreshold },
  });
  const replayRunsSnapshot = ({ symbol = null, status = null, limit = config.replayRunsLimit } = {}) => ({
    classification: "DETERMINISTIC_OFFLINE_REPLAY_RESEARCH_ONLY",
    liveExecutionAvailable: false,
    schemaVersion: "replay-v1",
    baselines: [...REPLAY_BASELINES],
    runs: typeof database.replayRuns === "function" ? database.replayRuns({ symbol, status, limit }) : [],
  });
  const marketPayload = (symbol, snapshot = market.snapshot(symbol)) => {
    if (!snapshot) return null;
    const candidates = snapshot.analysis?.candidates ?? [];
    const counterfactuals = candidates.map((candidate) => ({ horizonMinutes: candidate.horizonMinutes, decisionKey: candidate.decisionKey, ...market.evaluateEntry(candidate).readiness }));
    return {
      ...snapshot,
      apiVersion: "0.9.0",
      operations: operationalService.status(symbol),
      alerts: alertsSnapshot({ symbol, limit: 100 }),
      calibration: calibrationSnapshot(symbol),
      orderFlow: snapshot.orderFlow,
      orderBook: snapshot.orderBook,
      extendedRegime: Object.fromEntries(candidates.map((candidate) => [String(candidate.horizonMinutes), candidate.extendedRegime ?? candidate.marketRegime?.extended ?? null])),
      engines: Object.fromEntries(candidates.map((candidate) => [String(candidate.horizonMinutes), candidate.engine ?? null])),
      counterfactuals,
      replay: replayRunsSnapshot({ symbol }),
    };
  };
  const rate = new Map();
  const server = createServer(async (request, response) => {
    const started = Date.now(); const ip = request.socket.remoteAddress ?? "local"; const bucket = rate.get(ip) ?? { count: 0, reset: started + 60000 };
    if (started > bucket.reset) { bucket.count = 0; bucket.reset = started + 60000; } bucket.count += 1; rate.set(ip, bucket);
    if (bucket.count > 180) return sendJson(response, 429, { error: "RATE_LIMITED", message: "Too many local requests" }, { "retry-after": String(Math.max(1, Math.ceil((bucket.reset - started) / 1000))) });
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "POST") {
      if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return sendJson(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE", message: "application/json is required" });
      const origin = request.headers.origin;
      if (url.pathname === "/api/v1/autonomous/state") {
        if (!origin) return sendJson(response, 403, { error: "ORIGIN_REQUIRED", message: "Autonomous control requires a same-origin browser request" });
        try {
          const parsedOrigin = new URL(origin); const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
          if (parsedOrigin.protocol !== "http:" || parsedOrigin.host !== request.headers.host || !localHosts.has(parsedOrigin.hostname)) return sendJson(response, 403, { error: "ORIGIN_REJECTED", message: "Autonomous control is restricted to the local dashboard origin" });
        } catch { return sendJson(response, 403, { error: "ORIGIN_REJECTED", message: "Invalid origin" }); }
      }
      try { if (origin && new URL(origin).origin !== `http://${request.headers.host}`) return sendJson(response, 403, { error: "ORIGIN_REJECTED", message: "Cross-origin state changes are not allowed" }); }
      catch { return sendJson(response, 403, { error: "ORIGIN_REJECTED", message: "Invalid origin" }); }
    }
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        validateQuery(url);
        return sendJson(response, 200, { version: "0.9.0", status: "ok", timestamp: new Date().toISOString(), instance: config.instance, host: config.host, port: config.port, mode: config.tradingMode, database: database.health(), feed: market.feeds(), operations: operationalService.status(), alerts: { open: alertsSnapshot({ status: "OPEN", limit: 100 }).length }, calibration: calibrationSnapshot(), replay: replayRunsSnapshot({ limit: config.replayRunsLimit }), eventRisk: eventRisk.status(), entryPolicy: { version: "entry-gates-v0.9.0", liveExecutionAvailable: false }, autonomousExecution: { mode: "PAPER_ONLY", enabled: config.autonomousEnabled && config.tradingMode === "paper", liveAvailable: false }, manualSignals: { mode: "MANUAL_SIGNALS_ONLY", enabled: config.manualSignalsEnabled && config.tradingMode === "paper", marketClassification: "SPOT_PROXY", settlementClassification: "NOT_EVENT_FUTURES_SETTLEMENT", liveExecutionAvailable: false }, liveExecution: { available: false, reason: "No verified MEXC Event Futures execution API is connected; the application supplies manual research signals and PAPER shadow outcomes only." } });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/dashboard") {
        validateQuery(url, ["symbol"]);
        const symbol = querySymbol(url, { required: true });
        const snapshot = marketPayload(symbol);
        if (!snapshot) return sendJson(response, 404, { error: "NOT_FOUND", message: "Symbol not configured" });
        return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), symbol, snapshot, operations: snapshot.operations, alerts: snapshot.alerts, calibration: snapshot.calibration, orderFlow: snapshot.orderFlow, orderBook: snapshot.orderBook, extendedRegime: snapshot.extendedRegime, engines: snapshot.engines, counterfactuals: snapshot.counterfactuals, replay: snapshot.replay, account: paper.account(), autonomous: autonomous.status(), performance: autonomous.performance(), manualSignals: manualSignals.status(symbol) });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/event-risk") { validateQuery(url); return sendJson(response, 200, eventRisk.status()); }
      if (request.method === "GET" && url.pathname === "/api/v1/sources") { validateQuery(url); return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), sources: market.sources() }); }
      if (request.method === "GET" && url.pathname === "/api/v1/feeds") { validateQuery(url); return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), instance: config.instance, feed: market.feeds() }); }
      if (request.method === "GET" && url.pathname === "/api/v1/operations") {
        validateQuery(url, ["symbol"]); const symbol = querySymbol(url);
        return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), instance: config.instance, classification: "PAPER_RESEARCH_OPERATIONAL_TELEMETRY", operations: operationalService.status(symbol) });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/calibration") {
        validateQuery(url, ["symbol"]); const symbol = querySymbol(url);
        return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), ...calibrationSnapshot(symbol) });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/replay/runs") {
        validateQuery(url, ["symbol", "status", "limit"]); const symbol = querySymbol(url); const status = queryEnum(url, "status", ["PENDING", "RUNNING", "COMPLETED", "FAILED"]); const limit = queryLimit(url, config.replayRunsLimit, 500);
        return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), ...replayRunsSnapshot({ symbol, status, limit }) });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/alerts") {
        validateQuery(url, ["symbol", "status", "limit"]); const symbol = querySymbol(url); const status = queryEnum(url, "status", ["OPEN", "RESOLVED"]); const limit = queryLimit(url, 100, 500);
        return sendJson(response, 200, { apiVersion: "0.9.0", timestamp: new Date().toISOString(), instance: config.instance, classification: "PAPER_RESEARCH_ALERTS_ONLY", alerts: alertsSnapshot({ symbol, status, limit }) });
      }
      if (request.method === "GET" && /^\/api\/v1\/market\/[^/]+$/.test(url.pathname)) {
        validateQuery(url); const symbol = decodeURIComponent(url.pathname.split("/").at(-1)).toUpperCase();
        if (!config.symbols.includes(symbol)) return sendJson(response, 404, { error: "NOT_FOUND", message: "Symbol not configured" });
        const snapshot = marketPayload(symbol); return snapshot ? sendJson(response, 200, snapshot) : sendJson(response, 404, { error: "NOT_FOUND", message: "Symbol not configured" });
      }
      if (request.method === "GET" && url.pathname === "/api/v1/paper/account") { validateQuery(url); return sendJson(response, 200, paper.account()); }
      if (request.method === "GET" && url.pathname === "/api/v1/autonomous/status") { validateQuery(url); return sendJson(response, 200, autonomous.status()); }
      if (request.method === "GET" && url.pathname === "/api/v1/autonomous/performance") { validateQuery(url); return sendJson(response, 200, autonomous.performance()); }
      if (request.method === "GET" && url.pathname === "/api/v1/manual-signals/status") {
        validateQuery(url, ["symbol"]);
        const symbol = querySymbol(url);
        return sendJson(response, 200, manualSignals.status(symbol));
      }
      if (request.method === "GET" && /^\/api\/v1\/manual-signals\/[^/]+$/.test(url.pathname)) {
        validateQuery(url);
        const id = decodeURIComponent(url.pathname.split("/").at(-1)); const signal = manualSignals.byId(id);
        return signal ? sendJson(response, 200, signal) : sendJson(response, 404, { error: "NOT_FOUND", message: "Manual research signal not found" });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/autonomous/state") { validateQuery(url); return sendJson(response, 200, autonomous.setAction(validateAutonomousAction(await body(request)))); }
      if (["/health", "/api/v1/dashboard", "/api/v1/event-risk", "/api/v1/sources", "/api/v1/feeds", "/api/v1/operations", "/api/v1/calibration", "/api/v1/replay/runs", "/api/v1/alerts", "/api/v1/paper/account", "/api/v1/autonomous/status", "/api/v1/autonomous/performance", "/api/v1/autonomous/state", "/api/v1/manual-signals/status"].includes(url.pathname) || /^\/api\/v1\/(?:market|manual-signals)\/[^/]+$/.test(url.pathname)) return sendJson(response, 405, { error: "METHOD_NOT_ALLOWED" });
      if (request.method === "POST" && url.pathname === "/api/v1/paper/positions") { validateQuery(url); if (config.tradingMode !== "paper") return sendJson(response, 403, { error: "DISABLED", message: "Paper trading disabled" }); const position = paper.open(validatePaper(await body(request))); return sendJson(response, 201, position); }
      if (request.method === "POST" && url.pathname === "/api/v1/paper/risk-quote") { validateQuery(url); return sendJson(response, 200, paper.riskQuote(validateQuote(await body(request)))); }
      if (request.method !== "GET") return sendJson(response, 404, { error: "NOT_FOUND" });
      const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); const file = resolve(config.publicDirectory, requested); const root = `${resolve(config.publicDirectory)}${sep}`;
      if (!file.startsWith(root)) return sendJson(response, 403, { error: "FORBIDDEN" });
      try { const content = await readFile(file); response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'", "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=3600" }); response.end(content); }
      catch { sendJson(response, 404, { error: "NOT_FOUND" }); }
    } catch (error) { sendJson(response, error.message?.includes("Invalid") ? 400 : 409, { error: "REQUEST_REJECTED", message: error instanceof Error ? error.message : "Request failed" }); }
    finally { if (Date.now() - started > 1000) console.warn(JSON.stringify({ level: "warn", event: "slow_request", path: url.pathname, durationMs: Date.now() - started })); }
  });
  await eventRisk.start(); await market.start(config.tickerPollMs, config.candlePollMs); paper.initialize(); autonomous.start(); manualSignals.start();
  return { server, market, paper, autonomous, manualSignals, eventRisk, observability, alertService, operationalService, calibrationService, replayService, database, async close() { manualSignals.stop(); await market.stop(); autonomous.stop(); paper.stop(); eventRisk.stop(); operationalService.close(); if (server.listening) await new Promise((done) => server.close(done)); database.close(); } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const application = await createApplication();
  application.server.listen(config.port, config.host, () => console.log(JSON.stringify({ level: "info", event: "server_started", url: `http://localhost:${config.port}`, instance: config.instance, streamEnabled: config.marketStreamEnabled, mode: config.tradingMode })));
  const shutdown = async () => { await application.close(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}
