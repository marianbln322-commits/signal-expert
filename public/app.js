const state = { symbol: "BTCUSDT", timeframe: "1m", snapshot: null, account: null, autonomous: null, performance: null, manualSignals: null };
const $ = (id) => document.getElementById(id);
const money = (value, digits = 2) => Number(value).toLocaleString("ro-RO", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value) => `${(Number(value) * 100).toFixed(2)}%`;
const time = (value) => value ? new Date(value).toLocaleTimeString("ro-RO", { hour12: false }) : "—";
const escape = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const safeStatus = (value) => ["LIVE", "STALE", "DEGRADED", "ERROR", "OFFLINE", "UNAVAILABLE"].includes(value) ? value.toLowerCase() : "unavailable";
const directionClass = (value) => value === "UP" ? "positive" : value === "DOWN" ? "negative" : "";
const actionClass = (value) => value === "OPEN" ? "verdict-up" : value === "BLOCKED" ? "verdict-down" : "verdict-wait";
const segmentClass = (value) => ["WARMUP", "MONITOR", "VALIDATED", "UNDERPERFORMING"].includes(value) ? value.toLowerCase() : "warmup";

let soundEnabled = false;
let audioContext = null;
let manualSignalBaselineReady = false;
let knownReadySignalIds = new Set();
let manualDeadlineTimer = null;
try { soundEnabled = localStorage.getItem("signal-expert-manual-signal-sound") === "enabled"; } catch { soundEnabled = false; }

async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...options?.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}

function status(element, value) {
  element.className = `status status-${safeStatus(value)}`;
  element.innerHTML = `<i></i>${escape(value)}`;
}

function emaSeries(candles, period) {
  const output = Array(candles.length).fill(null);
  if (candles.length < period) return output;
  let current = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
  output[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < candles.length; index += 1) {
    current = (candles[index].close - current) * multiplier + current;
    output[index] = current;
  }
  return output;
}

function currentCandidate() {
  const candidates = state.autonomous?.liveCandidates?.filter((candidate) => candidate.symbol === state.symbol && candidate.available !== false) ?? [];
  return candidates.sort((left, right) => (right.qualityScore ?? -1) - (left.qualityScore ?? -1) || left.horizonMinutes - right.horizonMinutes)[0] ?? null;
}

function currentManualSignal() {
  const signals = state.manualSignals?.ready?.filter((signal) => signal.symbol === state.symbol) ?? [];
  return signals.sort((left, right) => (right.qualityScore ?? -1) - (left.qualityScore ?? -1) || left.horizonMinutes - right.horizonMinutes)[0] ?? null;
}

function remaining(value) {
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds)) return "—";
  if (milliseconds <= 0) return "00:00";
  const seconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function manualLifecycleClass(value) {
  return ["ENTER_NOW", "TRACKING_DO_NOT_ENTER_LATE", "WAIT", "EXPIRED", "DISABLED"].includes(value) ? value.toLowerCase().replaceAll("_", "-") : "wait";
}

function localManualActionState(signal, now = Date.now(), enabled = state.manualSignals?.enabled === true) {
  if (signal?.status !== "READY") return signal?.status ?? "WAIT";
  if (!enabled) return "DISABLED";
  const deadline = new Date(signal.entryValidUntil).getTime();
  return Number.isFinite(deadline) && now < deadline ? "ENTER_NOW" : "TRACKING_DO_NOT_ENTER_LATE";
}

function latestStructureItem(group, indexKey = "index") {
  const items = [group?.bullish, group?.bearish].filter(Boolean);
  return items.sort((left, right) => (right[indexKey] ?? -1) - (left[indexKey] ?? -1))[0] ?? null;
}

function chart(candles, candidate = null, manualSignal = null) {
  if (!candles?.length) {
    $("chart").innerHTML = '<div class="chart-empty">Waiting for verified completed candles…</div>';
    return;
  }
  const limit = 80;
  const start = Math.max(0, candles.length - limit);
  const visible = candles.slice(start);
  const ema20 = emaSeries(candles, 20).slice(start);
  const ema50 = emaSeries(candles, 50).slice(start);
  const width = 1000;
  const height = 330;
  const pad = 28;
  const high = Math.max(...visible.map((candle) => candle.high));
  const low = Math.min(...visible.map((candle) => candle.low));
  const range = high - low || 1;
  const step = (width - pad * 2) / visible.length;
  const y = (price) => pad + (high - price) / range * (height - pad * 2);
  const inRange = (price) => Number.isFinite(price) && price >= low && price <= high;
  const structure = candidate?.structureFeatures?.[state.timeframe];
  const fvg = latestStructureItem(structure?.recentFvgs);
  const ifvg = latestStructureItem(structure?.invertedFvgs, "inversionIndex");
  const zone = ifvg ?? fvg;
  const zoneLabel = ifvg ? "IFVG" : fvg ? "FVG" : null;
  let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Completed candle chart with EMA and market structure overlays"><rect width="${width}" height="${height}" fill="#0b1421" rx="12"/>`;
  for (let index = 0; index < 5; index += 1) {
    const price = high - range * index / 4;
    svg += `<line x1="${pad}" x2="${width - pad}" y1="${y(price)}" y2="${y(price)}" stroke="#223047"/><text x="${width - pad + 4}" y="${y(price) + 4}" class="axis-label">${money(price, 2)}</text>`;
  }
  if (zone && Number.isFinite(zone.lower) && Number.isFinite(zone.upper) && zone.upper >= low && zone.lower <= high) {
    const top = y(Math.min(high, zone.upper));
    const bottom = y(Math.max(low, zone.lower));
    const bullish = (ifvg?.inversionDirection ?? zone.direction) === "UP";
    const color = bullish ? "#18d79a" : "#ff5573";
    svg += `<rect x="${pad}" y="${top}" width="${width - pad * 2}" height="${Math.max(2, bottom - top)}" fill="${color}" opacity=".09" stroke="${color}" stroke-dasharray="7 5"/><text x="${pad + 7}" y="${Math.max(pad + 11, top + 12)}" class="zone-label" fill="${color}">${zoneLabel} ${bullish ? "UP" : "DOWN"}</text>`;
  }
  for (const [swing, label] of [[structure?.latestSwingHigh, "SWING H"], [structure?.latestSwingLow, "SWING L"]]) {
    if (!inRange(swing?.price)) continue;
    svg += `<line x1="${pad}" x2="${width - pad}" y1="${y(swing.price)}" y2="${y(swing.price)}" stroke="#8ba5c9" opacity=".45" stroke-dasharray="3 6"/><text x="${pad + 7}" y="${y(swing.price) - 4}" class="zone-label" fill="#8ba5c9">${label}</text>`;
  }
  if (inRange(manualSignal?.entryPrice)) {
    svg += `<line x1="${pad}" x2="${width - pad}" y1="${y(manualSignal.entryPrice)}" y2="${y(manualSignal.entryPrice)}" stroke="#ffffff" stroke-width="1.2" stroke-dasharray="4 4"/><text x="${pad + 7}" y="${y(manualSignal.entryPrice) - 5}" class="zone-label" fill="#ffffff">SIGNAL ENTRY</text>`;
  }
  if (inRange(candidate?.invalidationPrice)) {
    svg += `<line x1="${pad}" x2="${width - pad}" y1="${y(candidate.invalidationPrice)}" y2="${y(candidate.invalidationPrice)}" stroke="#ffbf4b" stroke-width="1.4" stroke-dasharray="9 5"/><text x="${width - pad - 88}" y="${y(candidate.invalidationPrice) - 5}" class="zone-label" fill="#ffbf4b">INVALIDATION</text>`;
  }
  visible.forEach((candle, index) => {
    const green = candle.close >= candle.open;
    const color = green ? "#18d79a" : "#ff5573";
    const x = pad + index * step + step / 2;
    const top = y(Math.max(candle.open, candle.close));
    const body = Math.max(1.4, Math.abs(y(candle.open) - y(candle.close)));
    const bodyWidth = Math.max(3, step * .56);
    svg += `<g opacity="${candle.closed ? 1 : .7}"><line x1="${x}" x2="${x}" y1="${y(candle.high)}" y2="${y(candle.low)}" stroke="${color}"/><rect x="${x - bodyWidth / 2}" y="${top}" width="${bodyWidth}" height="${body}" fill="${color}" rx=".8"/></g>`;
  });
  const polyline = (values, color) => {
    const points = values.map((value, index) => Number.isFinite(value) ? `${pad + index * step + step / 2},${y(value)}` : null).filter(Boolean).join(" ");
    return points ? `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke"/>` : "";
  };
  svg += polyline(ema20, "#4c8dff");
  svg += polyline(ema50, "#c894ff");
  $("chart").innerHTML = `${svg}</svg>`;
}

function renderProviderDiagnostic(snapshot) {
  const element = $("provider-diagnostic");
  const provider = snapshot.health.provider;
  if (!provider?.message) { element.classList.add("hidden"); return; }
  const fallback = provider.fallbackActive;
  element.className = `alert ${fallback ? "alert-warning" : "alert-error"}`;
  element.querySelector("strong").textContent = fallback ? "MEXC UNAVAILABLE — FALLBACK ACTIVE" : "MARKET DATA UNAVAILABLE";
  element.querySelector("span").textContent = provider.message;
}

function clearTicker() {
  $("price").textContent = "—"; $("change").textContent = "—"; $("change").className = "";
  $("source-name").textContent = "Unavailable"; $("source-time").textContent = "No verified market response";
  $("high-low").textContent = "—"; $("spread").textContent = "—"; $("volume").textContent = "—"; $("book-spread").textContent = "Spread —";
}

function renderMarket() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  status($("health"), snapshot.health.overall);
  status($("book-health"), snapshot.orderBook.status);
  renderProviderDiagnostic(snapshot);
  $("event-warning").querySelector("span").textContent = snapshot.eventFutures.reason;
  const ticker = snapshot.market.data;
  $("chart-title").textContent = `${state.symbol} price action`;
  if (ticker) {
    $("price").textContent = money(ticker.lastPrice, state.symbol === "BTCUSDT" ? 1 : 2);
    $("change").textContent = `${ticker.priceChangePercent >= 0 ? "+" : ""}${ticker.priceChangePercent.toFixed(2)}%`;
    $("change").className = ticker.priceChangePercent >= 0 ? "positive" : "negative";
    $("source-name").textContent = snapshot.market.sourceName ?? snapshot.market.source ?? "Unavailable";
    $("source-time").textContent = `Source ${time(snapshot.market.sourceTimestamp)} · Received ${time(snapshot.market.receivedAt)}`;
    $("high-low").textContent = `${money(ticker.high24h)} / ${money(ticker.low24h)}`;
    const spread = ticker.askPrice && ticker.bidPrice ? ticker.askPrice - ticker.bidPrice : null;
    $("spread").textContent = spread === null ? "—" : money(spread, 4);
    $("volume").textContent = `${money(ticker.quoteVolume24h / 1e6, 1)}M USDT`;
    $("book-spread").textContent = `Spread ${spread === null ? "—" : money(spread, 4)}`;
  } else clearTicker();
  const candleEnvelope = snapshot.candles[state.timeframe];
  const completedCandles = (candleEnvelope.data ?? []).filter((candle) => candle.closed === true);
  chart(completedCandles, currentCandidate(), currentManualSignal());
  const latestCompleted = completedCandles.at(-1);
  $("closed-candle-time").textContent = latestCompleted ? `Latest completed ${state.timeframe} candle closed ${time(new Date(latestCompleted.closeTime).toISOString())} · ${completedCandles.length} closed candles` : `No completed ${state.timeframe} candle is available`;
  const analysis = snapshot.analysis;
  const timeframe = analysis?.timeframes[state.timeframe];
  const indicators = timeframe?.indicators;
  const fields = [["REGIME", timeframe?.regime], ["RSI 14", indicators?.rsi14?.toFixed(1)], ["EMA 20", indicators?.ema20?.toFixed(2)], ["EMA 50", indicators?.ema50?.toFixed(2)], ["REL. VOLUME", indicators?.relativeVolume20 ? `${indicators.relativeVolume20.toFixed(2)}×` : null], ["ATR 14", indicators?.atr14?.toFixed(2)]];
  $("indicators").innerHTML = fields.map(([label, value]) => `<div><small>${label}</small><b>${escape(value ?? "—")}</b></div>`).join("");
  const verdict = analysis?.direction ?? "WAIT";
  $("verdict").textContent = verdict;
  $("verdict").className = `verdict ${verdict === "UP" ? "verdict-up" : verdict === "DOWN" ? "verdict-down" : "verdict-wait"}`;
  $("up-score").textContent = `${analysis?.upScore ?? 50}%`; $("down-score").textContent = `${analysis?.downScore ?? 50}%`;
  $("up-fill").style.width = `${analysis?.upScore ?? 0}%`; $("down-fill").style.width = `${analysis?.downScore ?? 0}%`;
  $("estimate").textContent = analysis?.heuristicProbability == null ? "Unavailable" : pct(analysis.heuristicProbability);
  $("break-even").textContent = analysis ? pct(analysis.breakEvenProbability) : "—";
  $("confidence").textContent = analysis?.confidence ?? "—"; $("model").textContent = analysis?.modelVersion ?? "—";
  $("reasons").innerHTML = (analysis?.reasons ?? ["Waiting for verified candles."]).slice(0, 5).map((reason) => `<li>${escape(reason)}</li>`).join("");
  renderBook(snapshot.orderBook.data);
}

function renderBook(book) {
  const levels = [...(book?.bids ?? []), ...(book?.asks ?? [])];
  const max = Math.max(1, ...levels.map((level) => level.quantity));
  const rows = (items, type) => items.map((level) => `<div class="book-row ${type}"><i style="width:${level.quantity / max * 100}%"></i><span>${money(level.price, 2)}</span><span>${money(level.quantity, 5)}</span></div>`).join("");
  $("asks").innerHTML = rows((book?.asks ?? []).slice(0, 6).reverse(), "ask");
  $("bids").innerHTML = rows((book?.bids ?? []).slice(0, 6), "bid");
}

function manualConfidenceFor(symbol, horizonMinutes, strategyVersion = "0.3.0") {
  return state.manualSignals?.empiricalConfidence?.find((item) => item.symbol === symbol && item.horizonMinutes === horizonMinutes && item.strategyVersion === strategyVersion) ?? null;
}

function renderManualSignals() {
  const manual = state.manualSignals;
  if (!manual) return;
  const bySegment = new Map((manual.current ?? []).map((signal) => [`${signal.symbol}:${signal.horizonMinutes}`, signal]));
  const segments = ["BTCUSDT", "ETHUSDT"].flatMap((symbol) => [10, 30].map((horizonMinutes) => ({ symbol, horizonMinutes })));
  $("manual-signal-state").textContent = manual.enabled ? "SCANNING" : "DISABLED";
  $("manual-signal-state").className = `mode ${manual.enabled ? "auto-running" : "auto-paused"}`;
  $("manual-signal-scan").textContent = manual.nextScanAt ? time(manual.nextScanAt) : "—";
  $("manual-signal-source").textContent = state.snapshot?.market?.status === "LIVE" ? `${state.snapshot.market.sourceName ?? state.snapshot.market.source} · ${time(state.snapshot.market.sourceTimestamp)}` : "No fresh verified Spot ticker";
  $("manual-signal-cards").innerHTML = segments.map(({ symbol, horizonMinutes }) => {
    const signal = bySegment.get(`${symbol}:${horizonMinutes}`);
    const confidence = manualConfidenceFor(symbol, horizonMinutes, signal?.strategyVersion);
    if (!signal) return `<article class="manual-card manual-wait"><div class="manual-card-head"><strong>${symbol} · ${horizonMinutes}m</strong><span>WAIT</span></div><p>No completed-candle evaluation has been recorded yet.</p><small>Entry and confidence remain unavailable.</small></article>`;
    const actionState = localManualActionState(signal);
    const actionable = actionState === "ENTER_NOW";
    const tracking = actionState === "TRACKING_DO_NOT_ENTER_LATE";
    const confidenceText = confidence?.measuredRate == null ? "N/A" : pct(confidence.measuredRate);
    const confidenceDetail = confidence?.measuredRate == null
      ? `${confidence?.decisiveSample ?? 0}/${confidence?.minDecisiveSample ?? manual.policy?.minDecisiveSample ?? 20} decisive proxy outcomes`
      : `Wilson 95% ${pct(confidence.wilson95.lower)}–${pct(confidence.wilson95.upper)} · n=${confidence.decisiveSample}`;
    const instruction = actionable ? `ENTER ${signal.direction} NOW` : tracking ? "TRACKING · DO NOT ENTER LATE" : actionState === "DISABLED" ? "DISABLED · NO ENTRY" : signal.status === "EXPIRED" ? `PROXY RESULT · ${signal.proxyOutcome ?? "EXPIRED"}` : "WAIT · NO ENTRY";
    const timer = actionable ? `entry closes ${remaining(signal.entryValidUntil)}` : tracking ? `proxy observation in ${remaining(signal.resolvesAt)}` : signal.status === "EXPIRED" ? `resolved ${time(signal.resolvedAt)}` : "no entry window";
    const sourceName = signal.entrySource?.sourceName ?? signal.entrySource?.source ?? "No entry source";
    const fallback = signal.entrySource?.failover?.active === true;
    const invalidation = signal.invalidation?.text ?? (Number.isFinite(signal.invalidationPrice) ? `Completed-candle invalidation ${money(signal.invalidationPrice)}` : "No finite invalidation");
    return `<article class="manual-card manual-${manualLifecycleClass(actionState)}">
      <div class="manual-card-head"><strong>${escape(symbol)} · ${horizonMinutes}m</strong><span>${escape(actionState)}</span></div>
      <div class="manual-instruction ${directionClass(signal.direction)}">${escape(instruction)}</div>
      <div class="manual-price"><small>SPOT-PROXY ENTRY</small><b>${Number.isFinite(signal.entryPrice) ? money(signal.entryPrice) : "—"}</b><span>${escape(timer)}</span></div>
      <div class="manual-stats"><div><small>SETUP QUALITY</small><b>${signal.qualityScore}/100</b><span>${escape(signal.qualityBand)}</span></div><div><small>EMPIRICAL CONFIDENCE</small><b>${confidenceText}</b><span>${escape(confidenceDetail)}</span></div></div>
      <p class="manual-invalidation">${escape(invalidation)}</p>
      <div class="provenance"><span>${escape(sourceName)}</span><span>${time(signal.entrySource?.sourceTimestamp)}</span><span class="${fallback ? "fallback-badge" : "raw-tag"}">${fallback ? "FALLBACK" : "PRIMARY/ATTRIBUTED"}</span></div>
      <small>${escape(signal.reasons?.at(-1) ?? "Completed-candle evaluation recorded.")}</small>
    </article>`;
  }).join("");
  $("manual-confidence").innerHTML = (manual.empiricalConfidence ?? []).map((confidence) => `<div class="confidence-row">
    <strong>${escape(confidence.symbol)} · ${confidence.horizonMinutes}m</strong><span class="segment-${segmentClass(confidence.status)}">${escape(confidence.status)}</span>
    <b>${confidence.measuredRate == null ? "Not available" : pct(confidence.measuredRate)}</b><small>${confidence.decisiveSample}/${confidence.minDecisiveSample} decisive · ${confidence.correct} correct / ${confidence.incorrect} incorrect · Spot proxy only</small>
  </div>`).join("") || '<div class="empty-card">No prospective proxy outcomes yet.</div>';
  $("manual-history").innerHTML = (manual.recent ?? []).slice(0, 12).map((signal) => `<div class="manual-history-row">
    <span>${time(signal.generatedAt)}</span><strong>${escape(signal.symbol)} · ${signal.horizonMinutes}m</strong><b class="${directionClass(signal.direction)}">${escape(signal.direction)}</b><span>${escape(localManualActionState(signal))}</span><span>${signal.qualityScore}/100</span><small>${escape(signal.proxyOutcome ?? signal.reasons?.at(-1) ?? "Recorded")}</small>
  </div>`).join("") || '<div class="empty-card">No manual research signal history yet.</div>';
  notifyNewManualSignal(manual.ready ?? []);
  if (manualDeadlineTimer) clearTimeout(manualDeadlineTimer);
  const now = Date.now();
  const nextDeadline = (manual.ready ?? []).map((signal) => new Date(signal.entryValidUntil).getTime()).filter((deadline) => Number.isFinite(deadline) && deadline > now).sort((left, right) => left - right)[0];
  manualDeadlineTimer = nextDeadline === undefined ? null : setTimeout(() => { manualDeadlineTimer = null; renderManualSignals(); }, Math.max(1, nextDeadline - now + 1));
}

function renderLiveSetups() {
  const candidates = state.autonomous?.liveCandidates ?? [];
  const safeguards = state.performance?.segments ?? [];
  const safeguardMap = new Map(safeguards.map((item) => [`${item.symbol}:${item.horizonMinutes}`, item]));
  $("live-setups").innerHTML = candidates.length ? candidates.map((candidate) => {
    const segment = safeguardMap.get(`${candidate.symbol}:${candidate.horizonMinutes}`);
    const score = candidate.qualityScore == null ? "—" : `${candidate.qualityScore}/100`;
    const components = (candidate.confluenceComponents ?? []).filter((item) => item.active && item.direction === candidate.direction).slice(0, 3);
    return `<article class="live-setup ${candidate.direction === "UP" ? "setup-up" : candidate.direction === "DOWN" ? "setup-down" : "setup-wait"}">
      <div class="setup-card-head"><strong>${escape(candidate.symbol)} · ${candidate.horizonMinutes}m</strong><span class="${directionClass(candidate.direction)}">${escape(candidate.direction ?? "WAIT")}</span></div>
      <div class="setup-card-score"><b>${score}</b><span>${escape(candidate.qualityBand ?? candidate.qualityClassification ?? "UNAVAILABLE")}</span></div>
      <small>${components.length ? components.map((item) => escape(`${item.timeframe} ${item.label}`)).join(" · ") : escape(candidate.reason ?? "No aligned completed-candle structure.")}</small>
      <div class="setup-card-meta"><span>Invalidation ${Number.isFinite(candidate.invalidationPrice) ? money(candidate.invalidationPrice) : "required"}</span><span class="segment-${segmentClass(segment?.status)}">${escape(segment?.status ?? "WARMUP")}</span></div>
    </article>`;
  }).join("") : '<div class="empty-card">Waiting for the four BTC/ETH 10m/30m completed-candle candidates.</div>';
}

function renderRecentAlerts() {
  const decisions = state.autonomous?.recentDecisions ?? [];
  $("recent-alerts").innerHTML = decisions.length ? decisions.slice(0, 10).map((decision) => `<div class="alert-row">
    <span>${time(decision.updatedAt)}</span><strong>${escape(decision.symbol)} · ${decision.horizonMinutes}m</strong>
    <b class="${directionClass(decision.direction)}">${escape(decision.direction)}</b><span class="decision-action ${actionClass(decision.action)}">${escape(decision.action)}</span>
    <span>${decision.qualityScore}/100</span><small>${escape(decision.reasons?.at(-1) ?? decision.invalidation ?? "Completed-candle decision recorded.")}</small>
  </div>`).join("") : '<div class="empty-card">No autonomous decisions recorded yet.</div>';
}

function renderSegmentMetrics() {
  const segments = state.performance?.segments ?? [];
  $("segment-note").textContent = `WARMUP uses the configured minimum (${state.performance?.segmentGate?.minSample ?? segments[0]?.minSample ?? 20} decisive outcomes; default 20). VALIDATED and UNDERPERFORMING use the Wilson 95% interval against break-even, not raw small-sample win rate.`;
  $("segment-metrics").innerHTML = segments.length ? segments.map((segment) => {
    const interval = segment.wilson95?.lower == null ? "—" : `${pct(segment.wilson95.lower)}–${pct(segment.wilson95.upper)}`;
    const breakEven = segment.breakEvenReference?.rate == null ? "—" : pct(segment.breakEvenReference.rate);
    return `<article class="segment-card segment-${segmentClass(segment.status)}">
      <div><strong>${escape(segment.symbol)} · ${segment.horizonMinutes}m</strong><span>${escape(segment.status)}</span></div>
      <dl><dt>Decisive sample</dt><dd>${segment.decisiveSample}/${segment.minSample} min.</dd><dt>Outcomes</dt><dd>${segment.wins}W / ${segment.losses}L / ${segment.refunds}R</dd><dt>Measured win rate</dt><dd>${segment.winRate == null ? "—" : pct(segment.winRate)}</dd><dt>Wilson 95%</dt><dd>${interval}</dd><dt>Break-even ref.</dt><dd>${breakEven}</dd><dt>P&amp;L / ROI</dt><dd>${money(segment.pnl)} / ${segment.roi == null ? "—" : pct(segment.roi)}</dd></dl>
    </article>`;
  }).join("") : '<div class="empty-card">Segment learning is waiting for autonomous PAPER outcomes.</div>';
}

function playEntrySound() {
  if (!soundEnabled) return;
  try {
    audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine"; oscillator.frequency.setValueAtTime(740, audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(980, audioContext.currentTime + .16);
    gain.gain.setValueAtTime(.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.16, audioContext.currentTime + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .24);
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + .25);
  } catch { /* Browser audio is optional and may be unavailable. */ }
}

function notifyNewManualSignal(signals) {
  const currentIds = new Set(signals.filter((signal) => localManualActionState(signal) === "ENTER_NOW").map((signal) => signal.id));
  if (!manualSignalBaselineReady) {
    knownReadySignalIds = currentIds;
    manualSignalBaselineReady = true;
    return;
  }
  if ([...currentIds].some((id) => !knownReadySignalIds.has(id))) playEntrySound();
  knownReadySignalIds = new Set([...knownReadySignalIds, ...currentIds]);
}

function renderAutonomous() {
  const autonomous = state.autonomous;
  const performance = state.performance;
  if (!autonomous || !performance) return;
  const runtime = autonomous.state ?? {};
  const policy = autonomous.policy ?? {};
  const decision = autonomous.latestDecision;
  const position = autonomous.openPosition;
  const running = autonomous.enabled && runtime.status === "RUNNING";
  $("auto-state").textContent = autonomous.enabled ? runtime.status ?? "STARTING" : "DISABLED";
  $("auto-state").className = `mode ${running ? "auto-running" : "auto-paused"}`;
  $("auto-toggle").textContent = running ? "Pause autonomous paper" : "Resume autonomous paper";
  $("auto-toggle").disabled = !autonomous.enabled;
  $("auto-profile").textContent = policy.profile ?? "—";
  $("auto-stage").textContent = `${runtime.recoveryStage ?? 0}${runtime.previousLoss ? ` · loss ${money(runtime.previousLoss)}` : ""}`;
  $("auto-next-scan").textContent = autonomous.nextScanAt ? time(autonomous.nextScanAt) : "—";
  $("auto-position").innerHTML = position
    ? `<strong>OPEN PAPER</strong><span>${escape(position.symbol)} · ${escape(position.direction)} · ${position.horizonMinutes}m · ${money(position.stake)} USDT</span><small>Quality ${position.qualityScore}/100 · resolves ${time(position.resolvesAt)}</small>`
    : `<strong>${runtime.status === "PAUSED" ? "PAUSED" : "SCANNING"}</strong><span>${escape(runtime.pauseReason ?? "No autonomous position is open.")}</span><small>One-position lock is active.</small>`;
  const action = decision?.action ?? "WAIT";
  $("auto-action").textContent = action; $("auto-action").className = `verdict ${actionClass(action)}`;
  $("auto-quality").textContent = decision ? `${decision.qualityScore}/100` : "—";
  $("auto-band").textContent = decision ? `${decision.qualityBand} setup quality · not probability` : "No completed setup yet";
  $("auto-market").textContent = decision ? `${decision.symbol} / ${decision.horizonMinutes}m` : "—";
  $("auto-direction").textContent = decision?.direction ?? "—";
  $("auto-cap").textContent = policy.absoluteStakeCap == null ? "—" : `${money(policy.absoluteStakeCap)} USDT · ${(policy.maxStakeFraction * 100).toFixed(1)}% equity`;
  const stopAtProfit = policy.dailyStopAtProfit ?? performance.targets?.dailyStopAtProfit;
  $("auto-limits").textContent = stopAtProfit == null ? "—" : `stop after +${money(stopAtProfit)} / loss stop −${money(policy.dailyLossLimit)} USDT`;
  $("auto-invalidation").textContent = decision?.invalidation ?? (Number.isFinite(decision?.invalidationPrice) ? `Completed-candle invalidation at ${money(decision.invalidationPrice)}.` : "No finite invalidation is available yet.");
  const components = decision?.details?.confluenceComponents ?? [];
  $("auto-components").innerHTML = components.filter((item) => item.active).slice(0, 8).map((item) => `<span class="component ${directionClass(item.direction)}"><b>${escape(item.timeframe)}</b>${escape(item.label)}</span>`).join("") || '<span class="component component-empty">No active market-structure component.</span>';
  $("auto-reasons").innerHTML = (decision?.reasons ?? [runtime.pauseReason ?? "Waiting for completed-candle evaluation."]).slice(0, 5).map((reason) => `<li>${escape(reason)}</li>`).join("");
  const totals = performance.allTime;
  const daily = performance.daily;
  $("auto-sample").textContent = `${totals.positions} settled · ${performance.scope?.profile ?? policy.profile ?? "current profile"}`;
  $("auto-daily-pnl").textContent = `${money(daily.pnl)} USDT`; $("auto-daily-pnl").className = daily.pnl >= 0 ? "positive" : "negative";
  $("auto-total-pnl").textContent = `${money(totals.pnl)} USDT`; $("auto-total-pnl").className = totals.pnl >= 0 ? "positive" : "negative";
  $("auto-win-rate").textContent = totals.winRate == null ? "—" : `${(totals.winRate * 100).toFixed(1)}% (${totals.wins}W/${totals.losses}L)`;
  $("auto-roi").textContent = totals.roiOnStake == null ? "—" : pct(totals.roiOnStake);
  $("auto-drawdown").textContent = `${money(totals.maxDrawdown)} USDT`; $("auto-loss-streak").textContent = String(totals.maxConsecutiveLosses);
  renderLiveSetups(); renderRecentAlerts(); renderSegmentMetrics();
}

function renderAccount() {
  const account = state.account;
  if (!account) return;
  $("payout").textContent = pct(account.payout.value); $("equity").textContent = `${money(account.equity)} USDT`;
  $("available").textContent = money(account.available); $("pnl").textContent = money(account.realizedPnl);
  $("pnl").className = account.realizedPnl >= 0 ? "positive" : "negative";
  $("database").textContent = `Database: ${account.persistence.mode}`; $("record-count").textContent = `${account.positions.length} records`;
  $("positions").innerHTML = account.positions.length ? account.positions.slice(0, 10).map((position) => `<tr><td>${time(position.openedAt)}</td><td><span class="origin origin-${position.origin === "AUTONOMOUS" ? "autonomous" : "manual"}">${escape(position.origin ?? "MANUAL")}</span></td><td>${escape(position.symbol)}</td><td class="${directionClass(position.direction)}">${escape(position.direction)}</td><td>${position.horizonMinutes}m</td><td>${money(position.entryPrice)}</td><td>${money(position.stake)}</td><td><span class="position-status">${escape(position.status)}</span></td><td>${position.pnl == null ? "—" : money(position.pnl)}</td></tr>`).join("") : '<tr><td colspan="9" class="empty">No paper positions yet.</td></tr>';
}

async function refresh() {
  try {
    const [snapshot, account, autonomous, performance, manualSignals] = await Promise.all([request(`/api/v1/market/${state.symbol}`), request("/api/v1/paper/account"), request("/api/v1/autonomous/status"), request("/api/v1/autonomous/performance"), request("/api/v1/manual-signals/status")]);
    state.snapshot = snapshot; state.account = account; state.autonomous = autonomous; state.performance = performance; state.manualSignals = manualSignals;
    renderMarket(); renderAccount(); renderAutonomous(); renderManualSignals(); $("connection-error").classList.add("hidden");
  } catch (error) {
    $("connection-error").classList.remove("hidden"); $("connection-error").querySelector("span").textContent = error.message; status($("health"), "OFFLINE");
  }
}

async function openPaper(direction) {
  const notice = $("notice");
  try {
    await request("/api/v1/paper/positions", { method: "POST", body: JSON.stringify({ symbol: state.symbol, direction, horizonMinutes: Number($("horizon").value), stake: Number($("stake").value) }) });
    notice.textContent = `PAPER ${direction} opened. No MEXC order was sent.`; notice.classList.remove("hidden"); await refresh();
  } catch (error) { notice.textContent = error.message; notice.classList.remove("hidden"); }
}

async function riskQuote() {
  const output = $("risk-result");
  try {
    const result = await request("/api/v1/paper/risk-quote", { method: "POST", body: JSON.stringify({ symbol: state.symbol, cumulativeLoss: Number($("loss").value), targetProfit: 4, baseStake: 5, estimatedProbability: null }) });
    output.innerHTML = `<div class="risk-result ${result.allowed ? "allowed" : "blocked"}"><strong>${result.allowed ? "ALLOWED" : "BLOCKED"}</strong><span>Required stake: ${money(result.requiredRecoveryStake)} USDT</span><span>Expected value: ${result.expectedValue == null ? "Unavailable" : money(result.expectedValue)}</span><ul>${result.reasons.map((reason) => `<li>${escape(reason)}</li>`).join("")}</ul></div>`;
  } catch (error) { output.textContent = error.message; }
}

async function changeAutonomousState() {
  const action = state.autonomous?.state?.status === "RUNNING" ? "pause" : "resume";
  const button = $("auto-toggle"); button.disabled = true;
  try { await request("/api/v1/autonomous/state", { method: "POST", body: JSON.stringify({ action }) }); await refresh(); }
  catch (error) { $("auto-position").innerHTML = `<strong>REQUEST FAILED</strong><span>${escape(error.message)}</span>`; }
  finally { button.disabled = false; }
}

function configureSound() {
  const input = $("entry-sound");
  input.checked = soundEnabled;
  input.addEventListener("change", () => {
    soundEnabled = input.checked;
    try { localStorage.setItem("signal-expert-manual-signal-sound", soundEnabled ? "enabled" : "disabled"); } catch { /* Persistence is optional. */ }
    if (soundEnabled) {
      try { audioContext ??= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume(); } catch { /* Audio remains optional. */ }
    }
  });
}

document.querySelectorAll("[data-symbol]").forEach((button) => button.addEventListener("click", () => {
  state.symbol = button.dataset.symbol;
  document.querySelectorAll("[data-symbol]").forEach((item) => item.classList.toggle("active", item === button));
  state.snapshot = null; refresh();
}));
document.querySelectorAll("[data-timeframe]").forEach((button) => button.addEventListener("click", () => {
  state.timeframe = button.dataset.timeframe;
  document.querySelectorAll("[data-timeframe]").forEach((item) => item.classList.toggle("active", item === button));
  renderMarket();
}));
document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => openPaper(button.dataset.direction)));
$("risk-button").addEventListener("click", riskQuote);
$("auto-toggle").addEventListener("click", changeAutonomousState);
configureSound();
setInterval(() => { $("clock").textContent = `UTC ${new Date().toISOString().slice(11, 19)}`; }, 1000);
setInterval(refresh, 3000);
refresh();
