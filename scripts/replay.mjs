#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "../app/database.mjs";
import { ReplayService } from "../app/replay-service.mjs";

const VALUE_ARGUMENTS = new Set(["input", "output", "from", "to", "symbols", "seed", "database"]);

function usage() {
  return [
    "Usage: node scripts/replay.mjs --input <file|-> --output <file|-> [options]",
    "",
    "Options:",
    "  --from <timestamp>          Include events received at/after this time",
    "  --to <timestamp>            Include events received at/before this time",
    "  --symbols <A,B,...>         Restrict replay to symbols",
    "  --walk-forward [mode]       Enable expanding (default) or rolling folds",
    "  --seed <value>              Seed for the random baseline (default: 1)",
    "  --database <file>           Persist run history (default: DATABASE_PATH or data/signal-expert.db)",
  ].join("\n");
}

function parseWalkForward(value) {
  if (value === true || value === undefined) return { mode: "expanding" };
  const text = String(value).trim();
  if (!text || text === "true") return { mode: "expanding" };
  if (text === "false" || text === "off" || text === "none") return null;
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--walk-forward JSON must be an object");
    return parsed;
  }
  const [mode, trainSize, testSize, stepSize] = text.split(":");
  if (!["expanding", "rolling"].includes(mode)) throw new Error("--walk-forward must be expanding, rolling, or mode:train:test:step");
  const result = { mode };
  for (const [key, raw] of [["trainSize", trainSize], ["testSize", testSize], ["stepSize", stepSize]]) {
    if (raw === undefined || raw === "") continue;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1) throw new Error(`--walk-forward ${key} must be a positive integer`);
    result[key] = number;
  }
  return result;
}

export function parseArguments(argv) {
  const options = { seed: 1, walkForward: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { ...options, help: true };
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (rawName === "walk-forward") {
      const next = inlineValue ?? (argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true);
      options.walkForward = parseWalkForward(next);
      continue;
    }
    if (!VALUE_ARGUMENTS.has(rawName)) throw new Error(`Unknown argument: --${rawName}`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${rawName} requires a value`);
    if (rawName === "symbols") options.symbols = [...new Set(value.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
    else if (rawName === "seed") options.seed = /^-?\d+$/.test(value) ? Number(value) : value;
    else options[rawName] = value;
  }
  if (!options.input) throw new Error("--input is required");
  if (!options.output) throw new Error("--output is required");
  if (options.symbols && !options.symbols.length) throw new Error("--symbols must contain at least one symbol");
  return options;
}

function decodeJsonColumn(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function rowToEvent(row, index, defaults = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const payload = decodeJsonColumn(row.payload_json ?? row.payloadJson ?? row.payload);
  const candleJson = decodeJsonColumn(row.candle_json ?? row.candleJson);
  const merged = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, ...row } : row;
  const candle = candleJson && typeof candleJson === "object" && !Array.isArray(candleJson)
    ? candleJson
    : merged.candle ?? ((merged.open !== undefined && merged.high !== undefined && merged.low !== undefined && merged.close !== undefined) ? merged : null);
  const receivedAt = merged.receivedAt ?? merged.received_at ?? merged.ingestedAt ?? merged.ingested_at ?? defaults.receivedAt;
  const symbol = merged.symbol ?? defaults.symbol;
  const timeframe = merged.timeframe ?? merged.interval ?? defaults.timeframe;
  if (candle && receivedAt !== undefined && symbol && timeframe) {
    return { type: "CANDLE", symbol, timeframe, receivedAt, sequence: merged.sequence ?? merged.seq ?? defaults.sequence ?? index, closed: merged.closed ?? merged.isClosed ?? merged.is_closed, candle };
  }
  const price = merged.price ?? merged.lastPrice ?? merged.last_price ?? merged.close_price;
  if (price !== undefined && receivedAt !== undefined && symbol) {
    return {
      type: "TICKER",
      symbol,
      receivedAt,
      sequence: merged.sequence ?? merged.seq ?? defaults.sequence ?? index,
      sourceTimestamp: merged.sourceTimestamp ?? merged.source_timestamp ?? merged.eventTime ?? merged.event_time,
      price,
    };
  }
  if (merged.type || merged.eventType || merged.event_type) return { ...merged, payload: payload && typeof payload === "object" ? payload : merged.payload };
  return null;
}

function extractEvents(value, output = [], defaults = {}) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const row = value[index];
      const event = rowToEvent(row, output.length, { ...defaults, sequence: index });
      if (event) output.push(event);
      else if (row && typeof row === "object") extractEvents(row, output, defaults);
    }
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const direct = rowToEvent(value, output.length, defaults);
  if (direct) { output.push(direct); return output; }
  if (Array.isArray(value.data) && value.symbol && (value.timeframe || value.interval)) {
    const envelopeDefaults = { symbol: value.symbol, timeframe: value.timeframe ?? value.interval, receivedAt: value.receivedAt ?? value.received_at };
    for (let index = 0; index < value.data.length; index += 1) {
      const event = rowToEvent(value.data[index], output.length, { ...envelopeDefaults, sequence: index });
      if (event) output.push(event);
    }
    return output;
  }
  const preferredKeys = ["events", "replayEvents", "replay_events", "candles", "tickers", "prices", "marketEvents", "market_events", "rows"];
  let foundPreferred = false;
  for (const key of preferredKeys) {
    if (!Array.isArray(value[key])) continue;
    foundPreferred = true;
    extractEvents(value[key], output, defaults);
  }
  if (foundPreferred) return output;
  let traversed = false;
  for (const key of ["export", "database", "tables", "data"]) {
    if (!value[key] || typeof value[key] !== "object") continue;
    traversed = true;
    extractEvents(value[key], output, defaults);
  }
  if (!traversed) {
    for (const nested of Object.values(value)) if (nested && typeof nested === "object") extractEvents(nested, output, defaults);
  }
  return output;
}

export function parseReplayInput(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Input is empty");
  let documents;
  try { documents = [JSON.parse(trimmed)]; }
  catch {
    documents = trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); }
      catch (error) { throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`); }
    });
  }
  const events = [];
  for (const document of documents) extractEvents(document, events);
  if (!events.length) throw new Error("Input contains no replayable candle or ticker events");
  return events;
}

async function readInput(path) {
  if (path !== "-") return readFile(resolve(path), "utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
}

async function writeOutput(path, result) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (path === "-") { process.stdout.write(json); return; }
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, json, "utf8");
}

function createReplayPersistence(options, inputText, events) {
  const databasePath = resolve(options.database ?? process.env.DATABASE_PATH ?? "data/signal-expert.db");
  const migrationDirectory = resolve(process.env.MIGRATION_DIRECTORY ?? "migrations");
  const database = new Database(databasePath, migrationDirectory);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const inputHash = createHash("sha256").update(inputText).digest("hex");
  const symbols = options.symbols ?? [...new Set(events.map((event) => String(event.symbol ?? "").toUpperCase()).filter(Boolean))].sort();
  database.createReplayRun({
    id,
    runKey: `cli:${inputHash}:${id}`,
    schemaVersion: "replay-v1",
    status: "RUNNING",
    seed: options.seed,
    orderingPolicy: "receivedAt+sequence",
    inputHash,
    source: { type: options.input === "-" ? "STDIN" : "FILE", input: options.input, output: options.output, classification: "OFFLINE_PAPER_RESEARCH_ONLY" },
    range: { from: options.from ?? null, to: options.to ?? null },
    symbols,
    options: { seed: options.seed, walkForward: options.walkForward, symbols: options.symbols ?? null },
    createdAt,
    startedAt: createdAt,
  });
  return { database, databasePath, id };
}

function persistReplayResult(persistence, result) {
  const { database, id: runId } = persistence;
  const persistedIds = new Map();
  for (const prediction of result.predictions ?? []) {
    const id = randomUUID();
    persistedIds.set(prediction.id, id);
    database.createReplayPrediction({ ...prediction, id, runId, predictionKey: prediction.id, createdAt: prediction.generatedAt });
  }
  for (const outcome of result.outcomes ?? []) {
    const id = persistedIds.get(outcome.predictionId);
    if (id) database.resolveReplayPrediction(id, outcome);
  }
  for (const fold of result.walkForward?.folds ?? []) database.createWalkForwardFold({ ...fold, id: randomUUID(), runId, foldIndex: fold.index, createdAt: new Date().toISOString() });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) { process.stdout.write(`${usage()}\n`); return null; }
  const inputText = await readInput(options.input);
  const events = parseReplayInput(inputText);
  const persistence = createReplayPersistence(options, inputText, events);
  try {
    const service = new ReplayService({ seed: options.seed, walkForward: options.walkForward });
    const result = await service.run(events, {
      from: options.from,
      to: options.to,
      symbols: options.symbols,
      seed: options.seed,
      walkForward: options.walkForward,
    });
    persistReplayResult(persistence, result);
    const persistedResult = { ...result, persistedRun: { id: persistence.id, databasePath: persistence.databasePath, classification: "OFFLINE_PAPER_RESEARCH_ONLY" } };
    await writeOutput(options.output, persistedResult);
    const completedAt = new Date().toISOString();
    persistence.database.updateReplayRunStatus(persistence.id, { status: "COMPLETED", metrics: result.metrics, diagnostics: result.diagnostics, completedAt, updatedAt: completedAt });
    return persistedResult;
  } catch (error) {
    const failedAt = new Date().toISOString();
    try { persistence.database.updateReplayRunStatus(persistence.id, { status: "FAILED", errorText: error instanceof Error ? error.message : String(error), completedAt: failedAt, updatedAt: failedAt }); } catch { /* Preserve the original replay failure. */ }
    throw error;
  } finally {
    persistence.database.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`replay: ${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
