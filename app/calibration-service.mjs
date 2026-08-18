import { createHash } from "node:crypto";
import {
  brierScore,
  calibrationReport,
  expectedCalibrationError,
  logLoss,
  precisionMetrics,
  predictIsotonic,
  predictPlatt,
  reliabilityCurve,
} from "./calibration.mjs";

const RAW_CLASSIFICATION = "UNCALIBRATED_TECHNICAL_DIRECTION_SCORE_NOT_PROBABILITY";
const CALIBRATED_CLASSIFICATION = "PROSPECTIVE_SPOT_PROXY_CALIBRATED_PROBABILITY_RESEARCH_ONLY";
const METHODS = Object.freeze(["PLATT", "ISOTONIC"]);

function iso(value, fallback = null) {
  const parsed = new Date(value).getTime();
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  if (fallback === null) return null;
  return iso(fallback);
}
function segment(value, fallback = "UNSEGMENTED") {
  if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
  if (value && typeof value === "object") {
    for (const key of ["segment", "regime", "label", "state", "status", "classification"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim().toUpperCase();
    }
  }
  return fallback;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function probabilityInput(score) {
  if (!Number.isFinite(score) || score < 0 || score > 100) return null;
  return score / 100;
}
function scopeKey(scope) {
  return [scope.strategyName, scope.strategyVersion, scope.forecastModelName, scope.forecastModelVersion, scope.symbol, scope.horizonMinutes, scope.direction, scope.volatilitySegment, scope.regimeSegment].join(":");
}
function modelFor(report, method) { return method === "PLATT" ? report.models?.platt : report.models?.isotonic; }
function predict(method, model, value) { return method === "PLATT" ? predictPlatt(model, value) : predictIsotonic(model, value); }
function metricSet(samples, options) {
  return {
    brierScore: brierScore(samples, options),
    logLoss: logLoss(samples, options),
    expectedCalibrationError: expectedCalibrationError(samples, options),
    precision: precisionMetrics(samples, options),
  };
}

export class CalibrationService {
  constructor({ database = null, db = null, minSample = 50, binCount = 10, threshold = 0.5, clock = () => new Date() } = {}) {
    this.database = database ?? db;
    if (!this.database) throw new TypeError("CalibrationService requires a database.");
    this.minSample = Number.isInteger(minSample) && minSample >= 2 ? minSample : 50;
    this.binCount = Number.isInteger(binCount) && binCount > 0 ? binCount : 10;
    this.threshold = Number.isFinite(threshold) && threshold > 0 && threshold < 1 ? threshold : 0.5;
    this.clock = clock;
    this.segmentStates = new Map();
  }

  scope(candidate = {}) {
    const direction = ["UP", "DOWN"].includes(candidate.predictedDirection ?? candidate.direction ?? candidate.forecast?.leader)
      ? candidate.predictedDirection ?? candidate.direction ?? candidate.forecast?.leader
      : candidate.forecast?.upPercent >= candidate.forecast?.downPercent ? "UP" : "DOWN";
    return {
      strategyName: String(candidate.strategyName ?? "SIGNAL_EXPERT_RESEARCH"),
      strategyVersion: String(candidate.strategyVersion ?? "UNVERSIONED"),
      forecastModelName: String(candidate.forecastModelName ?? candidate.forecast?.modelName ?? "TECHNICAL_DIRECTION_SCORE"),
      forecastModelVersion: String(candidate.forecastModelVersion ?? candidate.forecast?.modelVersion ?? candidate.strategyVersion ?? "UNVERSIONED"),
      symbol: String(candidate.symbol ?? "").toUpperCase(),
      horizonMinutes: candidate.horizonMinutes,
      direction,
      volatilitySegment: segment(candidate.volatilitySegment ?? candidate.volatilityRegime),
      regimeSegment: segment(candidate.regimeSegment ?? candidate.marketRegime ?? candidate.regime),
    };
  }

  samples(scope, cutoff) {
    return this.database.forecastObservationsForCalibration({ ...scope, resolvedBefore: cutoff, limit: 50_000 })
      .filter((item) => ["UP", "DOWN"].includes(item.actualDirection))
      .map((item) => ({
        id: item.id,
        generatedAt: item.generatedAt,
        resolvedAt: item.resolvedAt,
        probability: probabilityInput(scope.direction === "DOWN" ? item.downScore : item.upScore),
        outcome: item.actualDirection === scope.direction ? 1 : 0,
      }))
      .filter((item) => Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1);
  }

  persistSnapshot({ scope, method, modelId = null, samples, measuredAt, status }) {
    const metricOptions = { binCount: this.binCount, threshold: this.threshold };
    const metrics = status === "READY" && method !== "RAW" ? metricSet(samples, metricOptions) : null;
    const reliability = status === "READY" && method !== "RAW" ? reliabilityCurve(samples, metricOptions) : [];
    const identity = { scope, method, modelId, observedThrough: samples.at(-1)?.resolvedAt ?? null, sampleIds: samples.map((item) => item.id) };
    this.database.createCalibrationMetricSnapshot({
      id: `calmetric_${hash(identity)}`,
      snapshotKey: `calibration:${hash(identity)}`,
      calibrationModelId: modelId,
      ...scope,
      calibrationMethod: method,
      sampleSize: samples.length,
      minSampleSize: this.minSample,
      brierScore: metrics?.brierScore ?? null,
      logLoss: metrics?.logLoss ?? null,
      expectedCalibrationError: metrics?.expectedCalibrationError ?? null,
      metrics: { status, classification: method === "RAW" ? RAW_CLASSIFICATION : CALIBRATED_CLASSIFICATION, ...(metrics ?? {}) },
      reliability,
      observedFrom: samples[0]?.generatedAt ?? null,
      observedThrough: samples.at(-1)?.resolvedAt ?? null,
      measuredAt,
    });
    return { metrics, reliability };
  }

  fit(scope, cutoff = this.clock()) {
    const measuredAt = iso(cutoff, this.clock());
    const samples = this.samples(scope, measuredAt);
    const report = calibrationReport(samples, { minSamples: this.minSample, binCount: this.binCount, threshold: this.threshold });
    this.persistSnapshot({ scope, method: "RAW", samples, measuredAt, status: report.status });
    const state = {
      ...scope,
      classification: CALIBRATED_CLASSIFICATION,
      rawClassification: RAW_CLASSIFICATION,
      status: report.status,
      reason: report.reason,
      sampleSize: samples.length,
      minSample: this.minSample,
      probabilityAvailable: false,
      calibratedProbability: null,
      selectedMethod: null,
      measuredAt,
      metrics: null,
      reliabilityCurve: [],
    };
    if (report.status !== "READY") {
      this.segmentStates.set(scopeKey(scope), state);
      return state;
    }

    const trainedFrom = samples[0]?.generatedAt ?? null;
    const trainedThrough = samples.reduce((latest, item) => !latest || item.resolvedAt > latest ? item.resolvedAt : latest, null);
    const models = {};
    const metricsByMethod = {};
    for (const method of METHODS) {
      const fitted = modelFor(report, method);
      if (fitted?.status !== "READY") continue;
      const identity = { scope, method, trainedFrom, trainedThrough, sampleIds: samples.map((item) => item.id) };
      const id = `calmodel_${hash(identity)}`;
      this.database.createCalibrationModel({
        id,
        modelKey: `calibration:${hash(identity)}`,
        ...scope,
        calibrationMethod: method,
        status: "READY",
        isActive: true,
        sampleSize: samples.length,
        model: fitted,
        trainedFrom,
        trainedThrough,
        trainedAt: measuredAt,
      });
      const calibrated = samples.map((item) => ({ ...item, probability: predict(method, fitted, item.probability) })).filter((item) => item.probability !== null);
      const measured = this.persistSnapshot({ scope, method, modelId: id, samples: calibrated, measuredAt, status: calibrated.length === samples.length ? "READY" : "UNAVAILABLE" });
      metricsByMethod[method] = { ...measured.metrics, reliabilityCurve: measured.reliability };
      models[method] = this.database.calibrationModelById(id);
    }
    const selectedMethod = METHODS.find((method) => models[method]) ?? null;
    const ready = { ...state, status: selectedMethod ? "READY" : "UNAVAILABLE", reason: selectedMethod ? null : "No calibration model converged safely.", selectedMethod, models, metrics: metricsByMethod, reliabilityCurve: selectedMethod ? metricsByMethod[selectedMethod]?.reliabilityCurve ?? [] : [] };
    this.segmentStates.set(scopeKey(scope), ready);
    return ready;
  }

  select(scope, rawScore, generatedAt) {
    const input = probabilityInput(rawScore);
    const generated = iso(generatedAt);
    if (input === null || generated === null) return null;
    for (const method of METHODS) {
      const model = this.database.activeCalibrationModel({ ...scope, calibrationMethod: method });
      if (!model || model.status !== "READY" || !model.trainedThrough || model.trainedThrough >= generated) continue;
      const directionProbability = predict(method, model.model, input);
      if (directionProbability === null) continue;
      return {
        status: "READY",
        classification: CALIBRATED_CLASSIFICATION,
        calibrationMethod: method,
        calibrationModelId: model.id,
        probabilityDirection: directionProbability,
        probabilityUp: scope.direction === "DOWN" ? 1 - directionProbability : directionProbability,
        trainedThrough: model.trainedThrough,
        sampleSize: model.sampleSize,
      };
    }
    return null;
  }

  prepareForecast(candidate, generatedAt = this.clock()) {
    const scope = this.scope(candidate);
    const upScore = candidate?.forecast?.upPercent ?? candidate?.upScore;
    const downScore = candidate?.forecast?.downPercent ?? candidate?.downScore;
    const rawScore = scope.direction === "DOWN" ? downScore : upScore;
    const cutoff = iso(generatedAt, this.clock());
    const fit = this.fit(scope, cutoff);
    const selected = fit.status === "READY" ? this.select(scope, rawScore, cutoff) : null;
    return {
      ...scope,
      status: selected?.status ?? (fit.status === "READY" ? "UNAVAILABLE" : fit.status),
      classification: selected?.classification ?? RAW_CLASSIFICATION,
      raw: { score: rawScore, upScore, downScore, classification: RAW_CLASSIFICATION, probability: null },
      rawProbabilityUp: null,
      calibratedProbabilityUp: selected?.probabilityUp ?? null,
      probabilityUp: selected?.probabilityUp ?? null,
      calibrationMethod: selected?.calibrationMethod ?? "RAW",
      calibrationModelId: selected?.calibrationModelId ?? null,
      trainedThrough: selected?.trainedThrough ?? null,
      sampleSize: fit.sampleSize,
      minSample: this.minSample,
    };
  }

  status(symbol = null) {
    const normalized = symbol === null ? null : String(symbol).toUpperCase();
    return [...this.segmentStates.values()]
      .filter((item) => normalized === null || item.symbol === normalized)
      .sort((left, right) => left.symbol.localeCompare(right.symbol) || left.horizonMinutes - right.horizonMinutes || left.direction.localeCompare(right.direction));
  }
}
