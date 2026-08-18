const TIMEFRAMES = Object.freeze(["1m", "5m", "15m", "1h"]);
const BASELINE_NAMES = Object.freeze(["seeded-random", "last-1m-candle", "ema9-21", "5m-continuation"]);
const EPSILON = 1e-15;

function timestamp(value, label = "timestamp") {
  if (value instanceof Date) value = value.getTime();
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  const milliseconds = Number.isFinite(parsed) ? parsed : new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return milliseconds;
}

function optionalTimestamp(value, fallback, label) {
  return value === undefined || value === null || value === "" ? fallback : timestamp(value, label);
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`);
  return parsed;
}

function positiveNumber(value, label) {
  const parsed = finiteNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function closedValue(value) {
  return value === true || value === 1 || value === "1" || (typeof value === "string" && value.toUpperCase() === "TRUE");
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function compareSequence(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), "en", { numeric: true });
}

export function compareReplayEvents(left, right) {
  return timestamp(left.receivedAt, "receivedAt") - timestamp(right.receivedAt, "receivedAt")
    || compareSequence(left.sequence ?? 0, right.sequence ?? 0)
    || (left.__index ?? 0) - (right.__index ?? 0);
}

function normalizeCandle(value, event, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Event ${index} candle is invalid`);
  const candle = {
    openTime: timestamp(value.openTime ?? value.open_time, `Event ${index} candle.openTime`),
    closeTime: timestamp(value.closeTime ?? value.close_time, `Event ${index} candle.closeTime`),
    open: positiveNumber(value.open, `Event ${index} candle.open`),
    high: positiveNumber(value.high, `Event ${index} candle.high`),
    low: positiveNumber(value.low, `Event ${index} candle.low`),
    close: positiveNumber(value.close, `Event ${index} candle.close`),
    volume: value.volume === undefined ? 0 : finiteNumber(value.volume, `Event ${index} candle.volume`),
    quoteVolume: value.quoteVolume === undefined && value.quote_volume === undefined ? null : finiteNumber(value.quoteVolume ?? value.quote_volume, `Event ${index} candle.quoteVolume`),
    trades: value.trades === undefined || value.trades === null ? null : finiteNumber(value.trades, `Event ${index} candle.trades`),
    closed: closedValue(value.closed) || closedValue(value.isClosed ?? value.is_closed) || closedValue(event.closed ?? event.isClosed ?? event.is_closed),
  };
  if (candle.closeTime <= candle.openTime) throw new Error(`Event ${index} candle closeTime must follow openTime`);
  if (candle.volume < 0 || (candle.quoteVolume !== null && candle.quoteVolume < 0) || (candle.trades !== null && candle.trades < 0)) throw new Error(`Event ${index} candle volume/trades cannot be negative`);
  if (candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.low > candle.high) throw new Error(`Event ${index} candle OHLC relationships are invalid`);
  return candle;
}

export function normalizeReplayEvent(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Event ${index} is not an object`);
  const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload) ? value.payload : {};
  const rawCandle = value.candle ?? payload.candle ?? ((value.open !== undefined || payload.open !== undefined) ? { ...payload, ...value } : null);
  const inferredType = rawCandle ? "CANDLE" : (value.price !== undefined || value.lastPrice !== undefined || payload.price !== undefined || payload.lastPrice !== undefined) ? "TICKER" : null;
  const type = String(value.type ?? value.eventType ?? value.event_type ?? inferredType ?? "").trim().toUpperCase();
  if (!type) throw new Error(`Event ${index} type is missing`);
  const receivedMs = timestamp(value.receivedAt ?? value.received_at ?? value.ingestedAt ?? value.ingested_at, `Event ${index} receivedAt`);
  const symbol = String(value.symbol ?? payload.symbol ?? "").trim().toUpperCase();
  if (!symbol) throw new Error(`Event ${index} symbol is missing`);
  const event = { type, symbol, receivedAt: iso(receivedMs), receivedMs, sequence: value.sequence ?? value.seq ?? index, __index: index };
  if (["CANDLE", "KLINE"].includes(type) || type.includes("CANDLE") || type.includes("KLINE")) {
    const timeframe = String(value.timeframe ?? value.interval ?? payload.timeframe ?? payload.interval ?? "").trim();
    if (!timeframe) throw new Error(`Event ${index} timeframe is missing`);
    const candleEvent = type.includes("CLOSED") && value.closed === undefined ? { ...value, closed: true } : value;
    const candle = normalizeCandle(rawCandle, candleEvent, index);
    if (candle.closed && candle.closeTime > receivedMs) throw new Error(`Event ${index} marks a candle closed before its closeTime was received`);
    return { ...event, type: "CANDLE", timeframe, candle };
  }
  if (["TICKER", "TRADE", "PRICE"].includes(type) || type.includes("TICKER") || type.includes("TRADE")) {
    const price = positiveNumber(value.price ?? value.lastPrice ?? payload.price ?? payload.lastPrice, `Event ${index} price`);
    const observedMs = optionalTimestamp(value.sourceTimestamp ?? value.source_timestamp ?? value.eventTime ?? value.event_time ?? payload.sourceTimestamp ?? payload.eventTime, receivedMs, `Event ${index} sourceTimestamp`);
    return { ...event, type: "TICKER", price, observedAt: iso(observedMs), observedMs };
  }
  return { ...event, payload: structuredClone(payload) };
}

export function createSeededRandom(seed = 1) {
  let state = Number(seed);
  if (!Number.isFinite(state)) state = [...String(seed)].reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619), 2166136261);
  state = (Math.trunc(state) >>> 0) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let result = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const multiplier = 2 / (period + 1);
  for (const value of values.slice(period)) result = (value - result) * multiplier + result;
  return result;
}

function directionProbability(direction, confidence = 0.6) {
  return direction === "UP" ? confidence : direction === "DOWN" ? 1 - confidence : 0.5;
}

function baselinePredictions(snapshot, random) {
  const oneMinute = snapshot.candles["1m"] ?? [];
  const fiveMinute = snapshot.candles["5m"] ?? [];
  const latestOne = oneMinute.at(-1);
  const latestFive = fiveMinute.at(-1);
  const closes = oneMinute.map((candle) => candle.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const randomDirection = random() >= 0.5 ? "UP" : "DOWN";
  const lastDirection = !latestOne || latestOne.close === latestOne.open ? "NEUTRAL" : latestOne.close > latestOne.open ? "UP" : "DOWN";
  const emaDirection = ema9 === null || ema21 === null || ema9 === ema21 ? "NEUTRAL" : ema9 > ema21 ? "UP" : "DOWN";
  const fiveDirection = !latestFive || latestFive.close === latestFive.open ? "NEUTRAL" : latestFive.close > latestFive.open ? "UP" : "DOWN";
  return [
    { evaluator: BASELINE_NAMES[0], predictedDirection: randomDirection, probabilityUp: 0.5, features: { seedDrawDirection: randomDirection } },
    { evaluator: BASELINE_NAMES[1], predictedDirection: lastDirection, probabilityUp: directionProbability(lastDirection), features: { open: latestOne?.open ?? null, close: latestOne?.close ?? null } },
    { evaluator: BASELINE_NAMES[2], predictedDirection: emaDirection, probabilityUp: directionProbability(emaDirection), features: { ema9, ema21 } },
    { evaluator: BASELINE_NAMES[3], predictedDirection: fiveDirection, probabilityUp: directionProbability(fiveDirection), features: { open: latestFive?.open ?? null, close: latestFive?.close ?? null, closeTime: latestFive ? iso(latestFive.closeTime) : null } },
  ];
}

function normalizePrediction(raw, defaults) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Evaluator prediction must be an object");
  const forecast = raw.forecast && typeof raw.forecast === "object" ? raw.forecast : {};
  let probabilityUp = raw.probabilityUp ?? raw.upProbability ?? raw.upScore ?? raw.upPercent ?? forecast.probabilityUp ?? forecast.upPercent;
  probabilityUp = Number(probabilityUp);
  if (probabilityUp > 1 && probabilityUp <= 100) probabilityUp /= 100;
  if (!Number.isFinite(probabilityUp) || probabilityUp < 0 || probabilityUp > 1) throw new Error("Evaluator probabilityUp must be between 0 and 1 (or 0 and 100 percent)");
  const predictedDirection = String(raw.predictedDirection ?? raw.direction ?? forecast.leader ?? (probabilityUp > 0.5 ? "UP" : probabilityUp < 0.5 ? "DOWN" : "NEUTRAL")).toUpperCase();
  if (!["UP", "DOWN", "NEUTRAL", "WAIT"].includes(predictedDirection)) throw new Error(`Invalid predicted direction ${predictedDirection}`);
  const horizonMinutes = Number(raw.horizonMinutes ?? raw.horizon ?? defaults.horizonMinutes);
  if (!Number.isFinite(horizonMinutes) || horizonMinutes <= 0) throw new Error("Prediction horizonMinutes must be positive");
  const entryPrice = raw.entryPrice === undefined || raw.entryPrice === null ? defaults.entryPrice : positiveNumber(raw.entryPrice, "prediction.entryPrice");
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("Prediction requires an entry price or an available 1m close");
  return {
    evaluator: String(raw.evaluator ?? raw.model ?? raw.name ?? defaults.evaluator),
    symbol: defaults.symbol,
    horizonMinutes,
    generatedAt: iso(defaults.generatedMs),
    resolvesAt: iso(defaults.generatedMs + horizonMinutes * 60_000),
    entryPrice,
    predictedDirection: predictedDirection === "WAIT" ? "NEUTRAL" : predictedDirection,
    probabilityUp,
    features: raw.features ?? null,
    metadata: raw.metadata ?? null,
  };
}

function assertTrainingInvariant(trainingOutcomes, generatedMs) {
  for (const outcome of trainingOutcomes) {
    const resolvedMs = timestamp(outcome.resolvedAt, "training outcome.resolvedAt");
    if (resolvedMs >= generatedMs) throw new Error(`Training invariant violated: outcome ${outcome.predictionId ?? outcome.id ?? "unknown"} resolvedAt must be before prediction.generatedAt`);
  }
}

function cloneAvailable(state, symbol, replayMs) {
  const byTimeframe = state.candles.get(symbol) ?? new Map();
  const candles = Object.fromEntries(TIMEFRAMES.map((timeframe) => [timeframe, (byTimeframe.get(timeframe) ?? []).map((candle) => ({ ...candle }))]));
  for (const [timeframe, values] of byTimeframe) if (!Object.hasOwn(candles, timeframe)) candles[timeframe] = values.map((candle) => ({ ...candle }));
  const prices = (state.prices.get(symbol) ?? [])
    .filter((price) => price.receivedMs <= replayMs && price.observedMs <= replayMs)
    .map((price) => ({ price: price.price, observedAt: iso(price.observedMs), receivedAt: iso(price.receivedMs), sequence: price.sequence ?? null }));
  return {
    replayNow: iso(replayMs),
    symbol,
    candles,
    prices,
    latestPrice: prices.at(-1) ?? null,
    watermarks: Object.fromEntries(Object.entries(candles).map(([timeframe, values]) => [timeframe, values.length ? iso(values.at(-1).closeTime) : null])),
    counts: Object.fromEntries(Object.entries(candles).map(([timeframe, values]) => [timeframe, values.length])),
  };
}

function addCandle(state, event) {
  if (!state.candles.has(event.symbol)) state.candles.set(event.symbol, new Map());
  const byTimeframe = state.candles.get(event.symbol);
  if (!byTimeframe.has(event.timeframe)) byTimeframe.set(event.timeframe, []);
  const candles = byTimeframe.get(event.timeframe);
  const replacement = candles.findIndex((candle) => candle.openTime === event.candle.openTime);
  if (replacement >= 0) candles[replacement] = { ...event.candle };
  else candles.push({ ...event.candle });
  candles.sort((left, right) => left.closeTime - right.closeTime || left.openTime - right.openTime);
  addPrice(state, { symbol: event.symbol, price: event.candle.close, observedMs: event.candle.closeTime, receivedMs: Math.max(event.receivedMs, event.candle.closeTime), sequence: event.sequence });
}

function addPrice(state, observation) {
  if (!state.prices.has(observation.symbol)) state.prices.set(observation.symbol, []);
  const prices = state.prices.get(observation.symbol);
  prices.push(observation);
  prices.sort((left, right) => left.observedMs - right.observedMs || left.receivedMs - right.receivedMs || compareSequence(left.sequence ?? 0, right.sequence ?? 0));
}

function resolutionFor(state, prediction, replayMs) {
  const targetMs = timestamp(prediction.resolvesAt);
  return (state.prices.get(prediction.symbol) ?? []).find((price) => price.observedMs >= targetMs && price.observedMs <= replayMs && price.receivedMs <= replayMs) ?? null;
}

function settlePredictions(state, predictions, outcomes, replayMs) {
  const settled = new Set(outcomes.map((outcome) => outcome.predictionId));
  for (const prediction of predictions) {
    if (settled.has(prediction.id) || timestamp(prediction.resolvesAt) > replayMs) continue;
    const resolution = resolutionFor(state, prediction, replayMs);
    if (!resolution) continue;
    const actualDirection = resolution.price === prediction.entryPrice ? "TIE" : resolution.price > prediction.entryPrice ? "UP" : "DOWN";
    const outcome = actualDirection === "TIE" ? "TIE" : prediction.predictedDirection === "NEUTRAL" ? "UNSCORED_DIRECTION" : prediction.predictedDirection === actualDirection ? "CORRECT" : "INCORRECT";
    outcomes.push({
      predictionId: prediction.id,
      evaluator: prediction.evaluator,
      symbol: prediction.symbol,
      horizonMinutes: prediction.horizonMinutes,
      generatedAt: prediction.generatedAt,
      targetAt: prediction.resolvesAt,
      resolvedAt: iso(Math.max(replayMs, timestamp(prediction.resolvesAt))),
      entryPrice: prediction.entryPrice,
      resolutionPrice: resolution.price,
      predictedDirection: prediction.predictedDirection,
      actualDirection,
      probabilityUp: prediction.probabilityUp,
      outcome,
      resolutionObservedAt: iso(resolution.observedMs),
    });
  }
}

export function calculateReplayMetrics(predictions, outcomes) {
  const predictionIds = new Set(predictions.map((prediction) => prediction.id));
  const scoped = outcomes.filter((outcome) => predictionIds.has(outcome.predictionId));
  const resolvedById = new Set(scoped.map((outcome) => outcome.predictionId));
  const decisive = scoped.filter((outcome) => ["UP", "DOWN"].includes(outcome.actualDirection));
  const directional = decisive.filter((outcome) => ["UP", "DOWN"].includes(outcome.predictedDirection));
  const correct = directional.filter((outcome) => outcome.predictedDirection === outcome.actualDirection).length;
  const brier = decisive.length ? decisive.reduce((sum, outcome) => sum + (outcome.probabilityUp - (outcome.actualDirection === "UP" ? 1 : 0)) ** 2, 0) / decisive.length : null;
  const logloss = decisive.length ? decisive.reduce((sum, outcome) => {
    const probability = Math.min(1 - EPSILON, Math.max(EPSILON, outcome.probabilityUp));
    return sum - (outcome.actualDirection === "UP" ? Math.log(probability) : Math.log(1 - probability));
  }, 0) / decisive.length : null;
  return {
    predictions: predictions.length,
    resolved: resolvedById.size,
    decisive: decisive.length,
    directional: directional.length,
    correct,
    accuracy: directional.length ? correct / directional.length : null,
    brier,
    logloss,
    coverage: predictions.length ? resolvedById.size / predictions.length : null,
  };
}

function groupedMetrics(predictions, outcomes, keyOf) {
  const groups = new Map();
  for (const prediction of predictions) {
    const key = keyOf(prediction);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(prediction);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, calculateReplayMetrics(values, outcomes)]));
}

function pairSamples(predictions, outcomes) {
  const predictionById = new Map(predictions.map((prediction) => [prediction.id, prediction]));
  return outcomes.map((outcome) => ({ ...predictionById.get(outcome.predictionId), outcome })).filter((sample) => sample.id).sort((left, right) => timestamp(left.generatedAt) - timestamp(right.generatedAt) || left.id.localeCompare(right.id));
}

export function buildWalkForwardFolds(samples, options = {}) {
  const mode = String(options.mode ?? options.type ?? "expanding").toLowerCase();
  if (!["expanding", "rolling"].includes(mode)) throw new Error("walk-forward mode must be expanding or rolling");
  const trainSize = Number(options.trainSize ?? options.minTrainSize ?? 50);
  const testSize = Number(options.testSize ?? 20);
  const stepSize = Number(options.stepSize ?? options.step ?? testSize);
  if (![trainSize, testSize, stepSize].every(Number.isInteger) || trainSize < 1 || testSize < 1 || stepSize < 1) throw new Error("walk-forward trainSize/testSize/stepSize must be positive integers");
  const ordered = [...samples].sort((left, right) => timestamp(left.generatedAt) - timestamp(right.generatedAt) || String(left.id ?? left.predictionId).localeCompare(String(right.id ?? right.predictionId)));
  const metricsFor = (items) => calculateReplayMetrics(
    items.map(({ outcome, ...prediction }) => prediction),
    items.map((sample) => sample.outcome),
  );
  const folds = [];
  for (let testStart = trainSize; testStart < ordered.length; testStart += stepSize) {
    const test = ordered.slice(testStart, testStart + testSize);
    if (!test.length) break;
    const testGeneratedMs = timestamp(test[0].generatedAt);
    const eligible = ordered.slice(0, testStart).filter((sample) => timestamp(sample.outcome?.resolvedAt ?? sample.resolvedAt, "outcome.resolvedAt") < testGeneratedMs);
    const train = mode === "rolling" ? eligible.slice(-trainSize) : eligible;
    if (train.length < trainSize) continue;
    assertTrainingInvariant(train.map((sample) => sample.outcome ?? sample), testGeneratedMs);
    folds.push({
      index: folds.length,
      mode,
      trainStart: train[0].generatedAt,
      trainEnd: train.at(-1).generatedAt,
      testStart: test[0].generatedAt,
      testEnd: test.at(-1).generatedAt,
      trainSize: train.length,
      testSize: test.length,
      trainIds: train.map((sample) => sample.id ?? sample.predictionId),
      testIds: test.map((sample) => sample.id ?? sample.predictionId),
      trainMetrics: metricsFor(train),
      testMetrics: metricsFor(test),
    });
  }
  return folds;
}

function normalizeEvaluatorResult(result) {
  if (result === undefined || result === null) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.predictions)) return result.predictions;
  return [result];
}

function normalizeWalkForward(value) {
  if (!value) return null;
  if (value === true) return { mode: "expanding" };
  if (typeof value === "string") return { mode: value };
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  throw new Error("walkForward must be false, true, a mode, or an options object");
}

export class ReplayService {
  constructor({ evaluator = null, horizons = [10, 30], seed = 1, walkForward = null, baselines = true } = {}) {
    if (evaluator !== null && typeof evaluator !== "function") throw new Error("evaluator must be a function");
    if (!Array.isArray(horizons) || !horizons.length || horizons.some((value) => !Number.isFinite(Number(value)) || Number(value) <= 0)) throw new Error("horizons must contain positive numbers");
    this.evaluator = evaluator;
    this.horizons = [...new Set(horizons.map(Number))].sort((left, right) => left - right);
    this.seed = seed;
    this.walkForward = normalizeWalkForward(walkForward);
    this.baselines = baselines !== false;
  }

  availableAt(events, replayNow, { symbols = null } = {}) {
    const replayMs = timestamp(replayNow, "replayNow");
    const selected = symbols ? new Set(symbols.map((symbol) => String(symbol).toUpperCase())) : null;
    const normalized = events.map((event, index) => normalizeReplayEvent(event, index)).filter((event) => event.receivedMs <= replayMs && (!selected || selected.has(event.symbol))).sort(compareReplayEvents);
    const state = { candles: new Map(), prices: new Map() };
    for (const event of normalized) {
      if (event.type === "CANDLE" && event.candle.closed === true && event.candle.closeTime <= replayMs) addCandle(state, event);
      if (event.type === "TICKER") addPrice(state, event);
    }
    return Object.fromEntries([...new Set(normalized.map((event) => event.symbol))].sort().map((symbol) => [symbol, cloneAvailable(state, symbol, replayMs)]));
  }

  async replay(events, options = {}) {
    if (!Array.isArray(events)) throw new Error("Replay events must be an array");
    const evaluator = options.evaluator ?? this.evaluator;
    if (evaluator !== null && evaluator !== undefined && typeof evaluator !== "function") throw new Error("evaluator must be a function");
    const horizons = options.horizons ? [...new Set(options.horizons.map(Number))].sort((left, right) => left - right) : this.horizons;
    const selectedSymbols = options.symbols?.length ? new Set(options.symbols.map((symbol) => String(symbol).toUpperCase())) : null;
    const fromMs = options.from === undefined || options.from === null ? -Infinity : timestamp(options.from, "from");
    const toMs = options.to === undefined || options.to === null ? Infinity : timestamp(options.to, "to");
    if (fromMs > toMs) throw new Error("from must not be after to");
    const normalized = events.map((event, index) => normalizeReplayEvent(event, index))
      .filter((event) => event.receivedMs >= fromMs && event.receivedMs <= toMs && (!selectedSymbols || selectedSymbols.has(event.symbol)))
      .sort(compareReplayEvents);
    const state = { candles: new Map(), prices: new Map() };
    const predictions = [];
    const outcomes = [];
    const timeline = [];
    const pendingCandles = [];
    const random = createSeededRandom(options.seed ?? this.seed);
    const walkForwardOptions = normalizeWalkForward(options.walkForward ?? this.walkForward);
    let predictionSequence = 0;

    const emitPredictions = async (symbols, replayMs) => {
      settlePredictions(state, predictions, outcomes, replayMs);
      for (const symbol of [...symbols].sort()) {
        const snapshot = cloneAvailable(state, symbol, replayMs);
        const latestOne = snapshot.candles["1m"]?.at(-1);
        if (!latestOne) continue;
        const allTrainingOutcomes = outcomes.filter((outcome) => timestamp(outcome.resolvedAt) < replayMs).map((outcome) => structuredClone(outcome));
        const rollingTrainSize = Number(walkForwardOptions?.trainSize ?? walkForwardOptions?.minTrainSize ?? 50);
        const trainingOutcomes = walkForwardOptions?.mode === "rolling" ? allTrainingOutcomes.slice(-rollingTrainSize) : allTrainingOutcomes;
        assertTrainingInvariant(trainingOutcomes, replayMs);
        const rawPredictions = [];
        if (this.baselines && options.baselines !== false) {
          for (const baseline of baselinePredictions(snapshot, random)) for (const horizonMinutes of horizons) rawPredictions.push({ ...baseline, horizonMinutes });
        }
        if (evaluator) {
          const result = await evaluator(Object.freeze({
            replayNow: snapshot.replayNow,
            symbol,
            candles: snapshot.candles,
            available: snapshot,
            trainingOutcomes,
            outcomes: trainingOutcomes,
            horizons: [...horizons],
            seed: options.seed ?? this.seed,
            walkForward: walkForwardOptions ? { ...walkForwardOptions, trainingSize: trainingOutcomes.length } : null,
          }));
          rawPredictions.push(...normalizeEvaluatorResult(result));
        }
        for (const raw of rawPredictions) {
          if (Array.isArray(raw.trainingOutcomes)) assertTrainingInvariant(raw.trainingOutcomes, replayMs);
          const prediction = normalizePrediction(raw, { evaluator: "evaluator", symbol, generatedMs: replayMs, horizonMinutes: horizons[0], entryPrice: latestOne.close });
          prediction.id = `prediction-${String(predictionSequence).padStart(8, "0")}`;
          predictionSequence += 1;
          predictions.push(prediction);
        }
        timeline.push({ replayNow: snapshot.replayNow, symbol, counts: snapshot.counts, watermarks: snapshot.watermarks, trainingOutcomes: trainingOutcomes.length, predictions: rawPredictions.length });
      }
    };

    const releaseClosed = async (upToMs) => {
      pendingCandles.sort((left, right) => {
        const leftAvailable = Math.max(left.receivedMs, left.candle.closeTime);
        const rightAvailable = Math.max(right.receivedMs, right.candle.closeTime);
        return leftAvailable - rightAvailable || compareReplayEvents(left, right);
      });
      while (pendingCandles.length) {
        const availableMs = Math.max(pendingCandles[0].receivedMs, pendingCandles[0].candle.closeTime);
        if (availableMs > upToMs) break;
        const admittedSymbols = new Set();
        while (pendingCandles.length && Math.max(pendingCandles[0].receivedMs, pendingCandles[0].candle.closeTime) === availableMs) {
          const event = pendingCandles.shift();
          addCandle(state, event);
          if (event.timeframe === "1m") admittedSymbols.add(event.symbol);
        }
        if (admittedSymbols.size) await emitPredictions(admittedSymbols, availableMs);
        else settlePredictions(state, predictions, outcomes, availableMs);
      }
      settlePredictions(state, predictions, outcomes, upToMs);
    };

    for (const event of normalized) {
      await releaseClosed(event.receivedMs);
      if (event.type === "CANDLE") {
        if (event.candle.closed === true) {
          if (event.candle.closeTime <= event.receivedMs) {
            addCandle(state, event);
            if (event.timeframe === "1m") await emitPredictions(new Set([event.symbol]), event.receivedMs);
            else settlePredictions(state, predictions, outcomes, event.receivedMs);
          } else pendingCandles.push(event);
        }
      } else if (event.type === "TICKER") {
        addPrice(state, event);
        settlePredictions(state, predictions, outcomes, event.receivedMs);
      }
    }
    if (pendingCandles.length) {
      const lastReceivedMs = normalized.at(-1)?.receivedMs ?? -Infinity;
      const finalReplayMs = Number.isFinite(toMs) ? Math.min(toMs, lastReceivedMs) : lastReceivedMs;
      if (Number.isFinite(finalReplayMs)) await releaseClosed(finalReplayMs);
    }
    const finalReplayMs = Number.isFinite(toMs) ? toMs : normalized.at(-1)?.receivedMs ?? null;
    if (finalReplayMs !== null) settlePredictions(state, predictions, outcomes, finalReplayMs);

    const metrics = calculateReplayMetrics(predictions, outcomes);
    metrics.byEvaluator = groupedMetrics(predictions, outcomes, (prediction) => prediction.evaluator);
    metrics.bySymbol = groupedMetrics(predictions, outcomes, (prediction) => prediction.symbol);
    metrics.byHorizon = groupedMetrics(predictions, outcomes, (prediction) => String(prediction.horizonMinutes));
    const samples = pairSamples(predictions, outcomes);
    const foldsByEvaluator = walkForwardOptions ? Object.fromEntries([...new Set(samples.map((sample) => sample.evaluator))].sort().map((name) => [name, buildWalkForwardFolds(samples.filter((sample) => sample.evaluator === name), walkForwardOptions)])) : {};
    const folds = Object.entries(foldsByEvaluator).flatMap(([evaluatorName, evaluatorFolds]) => evaluatorFolds.map((fold) => ({ evaluator: evaluatorName, ...fold })));
    return {
      schemaVersion: "replay-v1",
      ordering: "receivedAt+sequence",
      seed: options.seed ?? this.seed,
      range: { from: Number.isFinite(fromMs) ? iso(fromMs) : null, to: Number.isFinite(toMs) ? iso(toMs) : null },
      symbols: [...new Set(normalized.map((event) => event.symbol))].sort(),
      eventCount: normalized.length,
      predictions,
      outcomes,
      metrics,
      walkForward: { enabled: Boolean(walkForwardOptions), options: walkForwardOptions, folds, byEvaluator: foldsByEvaluator },
      timeline,
      diagnostics: {
        rejectedFormingCandles: normalized.filter((event) => event.type === "CANDLE" && event.candle.closed !== true).length,
        pendingClosedCandles: pendingCandles.length,
        unresolvedPredictions: predictions.length - outcomes.length,
        baselineNames: this.baselines && options.baselines !== false ? [...BASELINE_NAMES] : [],
      },
    };
  }

  run(events, options = {}) {
    return this.replay(events, options);
  }
}

export const REPLAY_BASELINES = BASELINE_NAMES;
export const replayMetrics = calculateReplayMetrics;
export const walkForwardFolds = buildWalkForwardFolds;
