const DEFAULT_EPSILON = 1e-12;
const DEFAULT_BIN_COUNT = 10;
const DEFAULT_MIN_SAMPLE = 20;
const MODEL_READY = "READY";

const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));

function validEpsilon(value) {
  return Number.isFinite(value) && value > 0 && value < 0.5;
}

function metricOptions(options, defaults = {}) {
  const supplied = typeof options === "number" ? { binCount: options } : options ?? {};
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return null;
  const epsilon = supplied.epsilon ?? defaults.epsilon ?? DEFAULT_EPSILON;
  const binCount = supplied.binCount ?? supplied.bins ?? defaults.binCount ?? DEFAULT_BIN_COUNT;
  const threshold = supplied.threshold ?? defaults.threshold ?? 0.5;
  if (!validEpsilon(epsilon) || !Number.isInteger(binCount) || binCount < 1 || binCount > 1000 || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return null;
  return { epsilon, binCount, threshold };
}

function normalizeSamples(samples, epsilon = DEFAULT_EPSILON) {
  if (!Array.isArray(samples) || !validEpsilon(epsilon)) return { valid: false, reason: "Samples must be an array and epsilon must be between 0 and 0.5.", samples: [] };
  const normalized = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    if (!sample || typeof sample !== "object" || Array.isArray(sample) || !Number.isFinite(sample.probability) || sample.probability < 0 || sample.probability > 1 || (sample.outcome !== 0 && sample.outcome !== 1)) {
      return { valid: false, reason: `Invalid calibration sample at index ${index}.`, samples: [] };
    }
    normalized.push({ probability: clamp(sample.probability, epsilon, 1 - epsilon), outcome: sample.outcome });
  }
  return { valid: true, reason: null, samples: normalized };
}

function sampleState(samples, minimum, requireVariation = false) {
  if (samples.length < minimum) return { status: "INSUFFICIENT_DATA", reason: `At least ${minimum} valid samples are required.` };
  const positives = samples.reduce((sum, sample) => sum + sample.outcome, 0);
  if (positives === 0 || positives === samples.length) return { status: "DEGENERATE_DATA", reason: "Both binary outcomes are required." };
  if (requireVariation && samples.every((sample) => sample.probability === samples[0].probability)) return { status: "DEGENERATE_DATA", reason: "At least two distinct probabilities are required." };
  return { status: MODEL_READY, reason: null };
}

function unavailableModel(type, status, reason, sampleSize, epsilon = DEFAULT_EPSILON) {
  return { type, status, reason, sampleSize, epsilon };
}

function safeProbability(probability, epsilon) {
  return Number.isFinite(probability) && probability >= 0 && probability <= 1 && validEpsilon(epsilon)
    ? clamp(probability, epsilon, 1 - epsilon)
    : null;
}

function sigmoid(value) {
  if (value >= 0) {
    const inverse = Math.exp(-value);
    return 1 / (1 + inverse);
  }
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function logit(probability) {
  return Math.log(probability) - Math.log1p(-probability);
}

function logisticLoss(linear, outcome) {
  return Math.max(linear, 0) - outcome * linear + Math.log1p(Math.exp(-Math.abs(linear)));
}

function wilson95(successes, sampleSize) {
  if (!Number.isInteger(sampleSize) || sampleSize <= 0 || !Number.isFinite(successes) || successes < 0 || successes > sampleSize) return { lower: null, upper: null };
  const z = 1.959963984540054;
  const proportion = successes / sampleSize;
  const denominator = 1 + z ** 2 / sampleSize;
  const center = (proportion + z ** 2 / (2 * sampleSize)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z ** 2 / (4 * sampleSize)) / sampleSize) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function fitIsotonicPava(samples, options = {}) {
  const settings = metricOptions(options);
  if (!settings) return unavailableModel("ISOTONIC_PAVA", "INVALID_OPTIONS", "Invalid isotonic options.", 0);
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid) return unavailableModel("ISOTONIC_PAVA", "INVALID_DATA", normalized.reason, Array.isArray(samples) ? samples.length : 0, settings.epsilon);
  const state = sampleState(normalized.samples, 2, true);
  if (state.status !== MODEL_READY) return unavailableModel("ISOTONIC_PAVA", state.status, state.reason, normalized.samples.length, settings.epsilon);

  const sorted = [...normalized.samples].sort((left, right) => left.probability - right.probability);
  const blocks = [];
  for (const sample of sorted) {
    const previous = blocks.at(-1);
    if (previous?.maxProbability === sample.probability) {
      previous.weight += 1;
      previous.outcomeSum += sample.outcome;
      previous.value = previous.outcomeSum / previous.weight;
    } else {
      blocks.push({ minProbability: sample.probability, maxProbability: sample.probability, weight: 1, outcomeSum: sample.outcome, value: sample.outcome });
    }
    while (blocks.length > 1 && blocks.at(-2).value > blocks.at(-1).value) {
      const right = blocks.pop();
      const left = blocks.pop();
      const weight = left.weight + right.weight;
      const outcomeSum = left.outcomeSum + right.outcomeSum;
      blocks.push({ minProbability: left.minProbability, maxProbability: right.maxProbability, weight, outcomeSum, value: outcomeSum / weight });
    }
  }

  const fittedBlocks = blocks.map((block) => ({
    minProbability: block.minProbability,
    maxProbability: block.maxProbability,
    weight: block.weight,
    value: clamp(block.value, settings.epsilon, 1 - settings.epsilon),
  }));
  return {
    type: "ISOTONIC_PAVA",
    status: MODEL_READY,
    reason: null,
    sampleSize: normalized.samples.length,
    epsilon: settings.epsilon,
    blocks: fittedBlocks,
    thresholds: fittedBlocks.map((block) => block.maxProbability),
    predictions: fittedBlocks.map((block) => block.value),
  };
}

export function predictIsotonic(model, probability) {
  if (!model || model.type !== "ISOTONIC_PAVA" || model.status !== MODEL_READY || !Array.isArray(model.blocks) || !model.blocks.length || !validEpsilon(model.epsilon)) return null;
  const input = safeProbability(probability, model.epsilon);
  if (input === null) return null;
  const block = model.blocks.find((candidate) => input <= candidate.maxProbability) ?? model.blocks.at(-1);
  return safeProbability(block?.value, model.epsilon);
}

function plattSettings(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const lambda = options.lambda ?? options.regularization ?? 1e-3;
  const interceptLambda = options.interceptLambda ?? 0;
  const maxIterations = options.maxIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-8;
  const maxCoefficient = options.maxCoefficient ?? 30;
  const minSamples = options.minSamples ?? 2;
  if (!validEpsilon(epsilon) || !Number.isFinite(lambda) || lambda < 0 || !Number.isFinite(interceptLambda) || interceptLambda < 0 || !Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10000 || !Number.isFinite(tolerance) || tolerance <= 0 || !Number.isFinite(maxCoefficient) || maxCoefficient <= 0 || !Number.isInteger(minSamples) || minSamples < 2) return null;
  return { epsilon, lambda, interceptLambda, maxIterations, tolerance, maxCoefficient, minSamples };
}

export function fitPlatt(samples, options = {}) {
  const settings = plattSettings(options);
  if (!settings) return unavailableModel("PLATT_LOGISTIC", "INVALID_OPTIONS", "Invalid Platt options.", 0);
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid) return unavailableModel("PLATT_LOGISTIC", "INVALID_DATA", normalized.reason, Array.isArray(samples) ? samples.length : 0, settings.epsilon);
  const state = sampleState(normalized.samples, settings.minSamples, true);
  if (state.status !== MODEL_READY) return unavailableModel("PLATT_LOGISTIC", state.status, state.reason, normalized.samples.length, settings.epsilon);

  const observations = normalized.samples.map((sample) => ({ feature: logit(sample.probability), outcome: sample.outcome }));
  let slope = 1;
  let intercept = 0;
  let converged = false;
  let iterations = 0;
  let finalLoss = null;
  const objective = (candidateSlope, candidateIntercept) => observations.reduce((sum, observation) => sum + logisticLoss(candidateSlope * observation.feature + candidateIntercept, observation.outcome), 0)
    + settings.lambda * candidateSlope ** 2 / 2 + settings.interceptLambda * candidateIntercept ** 2 / 2;

  for (let iteration = 1; iteration <= settings.maxIterations; iteration += 1) {
    iterations = iteration;
    let gradientSlope = settings.lambda * slope;
    let gradientIntercept = settings.interceptLambda * intercept;
    let hessianSlope = settings.lambda;
    let hessianCross = 0;
    let hessianIntercept = settings.interceptLambda;
    for (const observation of observations) {
      const prediction = sigmoid(slope * observation.feature + intercept);
      const residual = prediction - observation.outcome;
      const weight = Math.max(prediction * (1 - prediction), Number.EPSILON);
      gradientSlope += residual * observation.feature;
      gradientIntercept += residual;
      hessianSlope += weight * observation.feature ** 2;
      hessianCross += weight * observation.feature;
      hessianIntercept += weight;
    }
    if (Math.max(Math.abs(gradientSlope), Math.abs(gradientIntercept)) <= settings.tolerance) {
      converged = true;
      finalLoss = objective(slope, intercept);
      break;
    }
    const determinant = hessianSlope * hessianIntercept - hessianCross ** 2;
    if (!Number.isFinite(determinant) || determinant <= Number.EPSILON) break;
    const slopeStep = (hessianIntercept * gradientSlope - hessianCross * gradientIntercept) / determinant;
    const interceptStep = (hessianSlope * gradientIntercept - hessianCross * gradientSlope) / determinant;
    const currentLoss = objective(slope, intercept);
    let stepScale = 1;
    let accepted = false;
    let nextSlope = slope;
    let nextIntercept = intercept;
    let nextLoss = currentLoss;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const candidateSlope = clamp(slope - stepScale * slopeStep, -settings.maxCoefficient, settings.maxCoefficient);
      const candidateIntercept = clamp(intercept - stepScale * interceptStep, -settings.maxCoefficient, settings.maxCoefficient);
      const candidateLoss = objective(candidateSlope, candidateIntercept);
      if (Number.isFinite(candidateLoss) && candidateLoss <= currentLoss) {
        nextSlope = candidateSlope;
        nextIntercept = candidateIntercept;
        nextLoss = candidateLoss;
        accepted = true;
        break;
      }
      stepScale /= 2;
    }
    if (!accepted) break;
    const change = Math.max(Math.abs(nextSlope - slope), Math.abs(nextIntercept - intercept));
    slope = nextSlope;
    intercept = nextIntercept;
    finalLoss = nextLoss;
    if (change <= settings.tolerance * (1 + Math.max(Math.abs(slope), Math.abs(intercept))) || Math.abs(currentLoss - nextLoss) <= settings.tolerance * (1 + currentLoss)) {
      converged = true;
      break;
    }
  }

  if (!converged || !Number.isFinite(slope) || !Number.isFinite(intercept) || !Number.isFinite(finalLoss)) {
    return { ...unavailableModel("PLATT_LOGISTIC", "NON_CONVERGENT", "Regularized logistic fitting did not converge within the configured bounds.", normalized.samples.length, settings.epsilon), converged: false, iterations, maxIterations: settings.maxIterations };
  }
  return {
    type: "PLATT_LOGISTIC",
    status: MODEL_READY,
    reason: null,
    sampleSize: normalized.samples.length,
    epsilon: settings.epsilon,
    slope,
    intercept,
    a: slope,
    b: intercept,
    lambda: settings.lambda,
    interceptLambda: settings.interceptLambda,
    converged: true,
    iterations,
    maxIterations: settings.maxIterations,
    loss: finalLoss / normalized.samples.length,
  };
}

export function predictPlatt(model, probability) {
  if (!model || model.type !== "PLATT_LOGISTIC" || model.status !== MODEL_READY || model.converged !== true || !Number.isFinite(model.slope) || !Number.isFinite(model.intercept) || !validEpsilon(model.epsilon)) return null;
  const input = safeProbability(probability, model.epsilon);
  if (input === null) return null;
  return clamp(sigmoid(model.slope * logit(input) + model.intercept), model.epsilon, 1 - model.epsilon);
}

export function brierScore(samples, options = {}) {
  const settings = metricOptions(options);
  if (!settings) return null;
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid || !normalized.samples.length) return null;
  return normalized.samples.reduce((sum, sample) => sum + (sample.probability - sample.outcome) ** 2, 0) / normalized.samples.length;
}

export function logLoss(samples, options = {}) {
  const supplied = typeof options === "number" ? { epsilon: options } : options;
  const settings = metricOptions(supplied);
  if (!settings) return null;
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid || !normalized.samples.length) return null;
  return normalized.samples.reduce((sum, sample) => sum - sample.outcome * Math.log(sample.probability) - (1 - sample.outcome) * Math.log1p(-sample.probability), 0) / normalized.samples.length;
}

export function precisionMetrics(samples, options = {}) {
  const supplied = typeof options === "number" ? { threshold: options } : options;
  const settings = metricOptions(supplied);
  const empty = (status, reason, sampleSize = 0) => ({ status, reason, sampleSize, threshold: settings?.threshold ?? null, truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0, precision: null, positivePrecision: null, negativePrecision: null, recall: null, specificity: null, accuracy: null, f1: null });
  if (!settings) return empty("INVALID_OPTIONS", "Invalid precision options.");
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid) return empty("INVALID_DATA", normalized.reason, Array.isArray(samples) ? samples.length : 0);
  if (!normalized.samples.length) return empty("INSUFFICIENT_DATA", "At least one valid sample is required.");
  let truePositive = 0; let falsePositive = 0; let trueNegative = 0; let falseNegative = 0;
  for (const sample of normalized.samples) {
    const positive = sample.probability >= settings.threshold;
    if (positive && sample.outcome === 1) truePositive += 1;
    else if (positive) falsePositive += 1;
    else if (sample.outcome === 0) trueNegative += 1;
    else falseNegative += 1;
  }
  const positivePrecision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : null;
  const negativePrecision = trueNegative + falseNegative ? trueNegative / (trueNegative + falseNegative) : null;
  const recall = truePositive + falseNegative ? truePositive / (truePositive + falseNegative) : null;
  const specificity = trueNegative + falsePositive ? trueNegative / (trueNegative + falsePositive) : null;
  const f1 = positivePrecision !== null && recall !== null && positivePrecision + recall > 0 ? 2 * positivePrecision * recall / (positivePrecision + recall) : null;
  return { status: MODEL_READY, reason: null, sampleSize: normalized.samples.length, threshold: settings.threshold, truePositive, falsePositive, trueNegative, falseNegative, precision: positivePrecision, positivePrecision, negativePrecision, recall, specificity, accuracy: (truePositive + trueNegative) / normalized.samples.length, f1 };
}

export function reliabilityCurve(samples, options = {}) {
  const settings = metricOptions(options);
  if (!settings) return [];
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid || !normalized.samples.length) return [];
  const bins = Array.from({ length: settings.binCount }, (_, index) => ({ index, lowerBound: index / settings.binCount, upperBound: (index + 1) / settings.binCount, count: 0, probabilitySum: 0, outcomeSum: 0 }));
  for (const sample of normalized.samples) {
    const index = Math.min(settings.binCount - 1, Math.floor(sample.probability * settings.binCount));
    bins[index].count += 1;
    bins[index].probabilitySum += sample.probability;
    bins[index].outcomeSum += sample.outcome;
  }
  return bins.map((bin) => {
    const meanProbability = bin.count ? bin.probabilitySum / bin.count : null;
    const observedRate = bin.count ? bin.outcomeSum / bin.count : null;
    return {
      index: bin.index,
      lowerBound: bin.lowerBound,
      upperBound: bin.upperBound,
      upperInclusive: bin.index === settings.binCount - 1,
      count: bin.count,
      weight: bin.count / normalized.samples.length,
      meanProbability,
      averageProbability: meanProbability,
      observedRate,
      observedFrequency: observedRate,
      calibrationGap: bin.count ? Math.abs(meanProbability - observedRate) : null,
      wilson95: wilson95(bin.outcomeSum, bin.count),
    };
  });
}

export function expectedCalibrationError(samples, options = {}) {
  const curve = reliabilityCurve(samples, options);
  if (!curve.length || !curve.some((bin) => bin.count > 0)) return null;
  return curve.reduce((sum, bin) => sum + (bin.calibrationGap ?? 0) * bin.weight, 0);
}

function calibratedSamples(samples, model, predict) {
  return samples.map((sample) => ({ probability: predict(model, sample.probability), outcome: sample.outcome })).filter((sample) => sample.probability !== null);
}

export function calibrationReport(samples, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) return { status: "INVALID_OPTIONS", reason: "Calibration report options must be an object.", sampleSize: 0, metrics: null, models: null, reliabilityCurve: [] };
  const settings = metricOptions(options);
  const minSamples = options.minSamples ?? options.minSample ?? DEFAULT_MIN_SAMPLE;
  if (!settings || !Number.isInteger(minSamples) || minSamples < 2) return { status: "INVALID_OPTIONS", reason: "Invalid calibration report options.", sampleSize: 0, metrics: null, models: null, reliabilityCurve: [] };
  const normalized = normalizeSamples(samples, settings.epsilon);
  if (!normalized.valid) return { status: "INVALID_DATA", reason: normalized.reason, sampleSize: Array.isArray(samples) ? samples.length : 0, minSamples, metrics: null, models: null, reliabilityCurve: [] };
  const state = sampleState(normalized.samples, minSamples, true);
  if (state.status !== MODEL_READY) return { status: state.status === "INSUFFICIENT_DATA" ? "WARMUP" : state.status, reason: state.reason, sampleSize: normalized.samples.length, minSamples, metrics: null, models: null, reliabilityCurve: [] };

  const isotonic = fitIsotonicPava(normalized.samples, { epsilon: settings.epsilon });
  const platt = fitPlatt(normalized.samples, {
    epsilon: settings.epsilon,
    minSamples,
    lambda: options.lambda ?? options.regularization,
    interceptLambda: options.interceptLambda,
    maxIterations: options.maxIterations,
    tolerance: options.tolerance,
    maxCoefficient: options.maxCoefficient,
  });
  const metricSettings = { epsilon: settings.epsilon, binCount: settings.binCount, threshold: settings.threshold };
  const isotonicSample = isotonic.status === MODEL_READY ? calibratedSamples(normalized.samples, isotonic, predictIsotonic) : [];
  const plattSample = platt.status === MODEL_READY ? calibratedSamples(normalized.samples, platt, predictPlatt) : [];
  const modelMetrics = (calibrated) => calibrated.length === normalized.samples.length ? { brierScore: brierScore(calibrated, metricSettings), logLoss: logLoss(calibrated, metricSettings), expectedCalibrationError: expectedCalibrationError(calibrated, metricSettings) } : null;
  const selectedMethod = platt.status === MODEL_READY ? "PLATT" : isotonic.status === MODEL_READY ? "ISOTONIC" : null;
  return {
    status: selectedMethod ? MODEL_READY : "UNAVAILABLE",
    reason: selectedMethod ? null : "No calibration model converged safely.",
    sampleSize: normalized.samples.length,
    minSamples,
    epsilon: settings.epsilon,
    metrics: {
      brierScore: brierScore(normalized.samples, metricSettings),
      logLoss: logLoss(normalized.samples, metricSettings),
      precision: precisionMetrics(normalized.samples, metricSettings),
      expectedCalibrationError: expectedCalibrationError(normalized.samples, metricSettings),
    },
    reliabilityCurve: reliabilityCurve(normalized.samples, metricSettings),
    models: { isotonic, platt },
    calibratedMetrics: { isotonic: modelMetrics(isotonicSample), platt: modelMetrics(plattSample) },
    selectedMethod,
    selectionBasis: selectedMethod ? "PLATT_PREFERRED_FOR_BOUNDED_PARAMETRIC_STABILITY" : "FAIL_CLOSED",
  };
}

function selectionArguments(first, second, third) {
  if (Number.isFinite(first)) return { probability: first, source: second, options: third ?? {} };
  return { probability: second, source: first, options: third ?? {} };
}

export function selectCalibratedProbability(first, second, third = {}) {
  const { probability, source, options } = selectionArguments(first, second, third);
  if (!options || typeof options !== "object" || Array.isArray(options) || !source || typeof source !== "object") return null;
  const report = source.models ? source : null;
  const models = report?.models ?? source;
  const requested = String(options.method ?? options.preferredMethod ?? report?.selectedMethod ?? "AUTO").toUpperCase();
  const methods = requested === "ISOTONIC" ? ["ISOTONIC"] : requested === "PLATT" ? ["PLATT"] : requested === "AUTO" ? ["PLATT", "ISOTONIC"] : [];
  for (const method of methods) {
    const model = method === "PLATT" ? models.platt ?? (models.type === "PLATT_LOGISTIC" ? models : null) : models.isotonic ?? (models.type === "ISOTONIC_PAVA" ? models : null);
    const prediction = method === "PLATT" ? predictPlatt(model, probability) : predictIsotonic(model, probability);
    if (prediction !== null) return prediction;
  }
  if (options.allowUncalibratedFallback === true) {
    const epsilon = validEpsilon(options.epsilon) ? options.epsilon : DEFAULT_EPSILON;
    return safeProbability(probability, epsilon);
  }
  return null;
}
