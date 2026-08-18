const state = { symbol: "BTCUSDT", timeframe: "1m", snapshot: null, account: null, autonomous: null, performance: null, manualSignals: null, operations: null, alerts: [], calibration: null, replay: null, engines: {}, counterfactuals: [] };
const $ = (id) => document.getElementById(id);
const money = (value, digits = 2) => Number(value).toLocaleString("ro-RO", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value) => `${(Number(value) * 100).toFixed(2)}%`;
const time = (value) => value ? new Date(value).toLocaleTimeString("ro-RO", { hour12: false }) : "—";
const escape = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const safeStatus = (value) => ({ LIVE: "live", SYNCED: "live", STALE: "stale", DEGRADED: "degraded", RECOVERING: "degraded", REST_FALLBACK: "degraded", STARTING: "degraded", ERROR: "error", OUT_OF_SYNC: "error", GAP: "error", OFFLINE: "offline", UNAVAILABLE: "unavailable", DISABLED: "unavailable" })[value] ?? "unavailable";
const directionClass = (value) => value === "UP" ? "positive" : value === "DOWN" ? "negative" : "";
const directionMeta = (value) => value === "UP"
  ? { label: "↑ UP", meaning: "Price is expected to finish ABOVE the recorded entry." }
  : value === "DOWN"
    ? { label: "↓ DOWN", meaning: "Price is expected to finish BELOW the recorded entry." }
    : { label: "— WAIT", meaning: "No actionable UP or DOWN direction is available." };
const actionClass = (value) => value === "OPEN" ? "verdict-up" : value === "BLOCKED" ? "verdict-down" : "verdict-wait";
const segmentClass = (value) => ["WARMUP", "MONITOR", "VALIDATED", "UNDERPERFORMING"].includes(value) ? value.toLowerCase() : "warmup";

let soundEnabled = false;
let audioContext = null;
let manualSignalBaselineReady = false;
let knownReadySignalIds = new Set();
let manualDeadlineTimer = null;
let refreshGeneration = 0;
let refreshInFlight = false;
let refreshQueued = false;
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
  return ["ENTER_NOW", "BLOCKED_CURRENT_GATES", "TRACKING_DO_NOT_ENTER_LATE", "WAIT", "EXPIRED", "DISABLED"].includes(value) ? value.toLowerCase().replaceAll("_", "-") : "wait";
}

function localManualActionState(signal, now = Date.now(), enabled = state.manualSignals?.enabled === true) {
  if (signal?.status !== "READY") return signal?.status ?? "WAIT";
  if (!enabled) return "DISABLED";
  const deadline = new Date(signal.entryValidUntil).getTime();
  if (!Number.isFinite(deadline) || now >= deadline) return "TRACKING_DO_NOT_ENTER_LATE";
  if (signal.actionState === "BLOCKED_CURRENT_GATES") return "BLOCKED_CURRENT_GATES";
  return "ENTER_NOW";
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
  element.querySelector("strong").textContent = fallback ? `${provider.failover?.primaryName ?? "PRIMARY FEED"} UNAVAILABLE — FALLBACK ACTIVE` : "MARKET DATA UNAVAILABLE";
  element.querySelector("span").textContent = provider.message;
}

function renderEntryGates(snapshot) {
  const candidate = currentCandidate();
  const checks = candidate?.entryGate?.checks ?? [];
  const check = (code) => checks.find((item) => item.code === code);
  const allPass = (codes) => codes.every((code) => check(code)?.status === "PASS");

  const mtfCodes = ["COMPLETED_1M_TRIGGER", "FIVE_MINUTE_CONFIRMATION", "FIFTEEN_MINUTE_ALIGNMENT", "TRIGGER_FRESHNESS"];
  const mtfPassed = candidate && allPass(mtfCodes);
  const direction = directionMeta(candidate?.direction);
  $("mtf-gate-status").textContent = mtfPassed ? `PASS · ${direction.label}` : "BLOCKED / WAIT";
  $("mtf-gate-status").className = mtfPassed ? "gate-pass" : "gate-blocked";
  const mtfBlocked = mtfCodes.map(check).find((item) => item?.status === "BLOCKED");
  $("mtf-gate-detail").textContent = mtfPassed
    ? `Completed 1m trigger, 5m structure and 15m trend agree · valid until ${time(candidate.triggerValidUntil)}`
    : mtfBlocked?.reason ?? "A fresh completed 1m trigger must match completed 5m structure and completed 15m trend.";

  const orderBookCodes = ["ORDER_BOOK_VALID", "SPREAD_LIMIT", "TOP_LIQUIDITY", "SOURCE_COHERENCE"];
  const bookPassed = candidate && allPass(orderBookCodes);
  const metrics = snapshot.orderBook?.metrics;
  const maximum = snapshot.entryPolicy?.maxSpreadBps;
  const minimum = snapshot.entryPolicy?.minTopNotional;
  $("spread-gate-status").textContent = bookPassed ? "PASS" : "BLOCKED / WAIT";
  $("spread-gate-status").className = bookPassed ? "gate-pass" : "gate-blocked";
  const bookBlocked = orderBookCodes.map(check).find((item) => item?.status === "BLOCKED");
  $("spread-gate-detail").textContent = metrics?.valid
    ? `${metrics.spreadBps.toFixed(3)} / max ${maximum?.toFixed(3) ?? "—"} bps · 10-level liquidity ${money(metrics.topNotional)} / min ${money(minimum)} USDT${bookBlocked ? ` · ${bookBlocked.reason}` : ""}`
    : bookBlocked?.reason ?? metrics?.reason ?? "No validated LIVE Spot top of book.";

  const macroCheck = check("MACRO_NEWS");
  const macro = snapshot.eventRisk ?? { status: "UNAVAILABLE" };
  const macroStatus = macroCheck?.status ?? (macro.status === "DISABLED" ? "SKIPPED" : macro.status === "CLEAR" ? "PASS" : "BLOCKED");
  const macroSkipped = macroStatus === "SKIPPED" || macro.status === "DISABLED";
  const macroPassed = macroStatus === "PASS" && macro.status === "CLEAR";
  $("macro-gate-status").textContent = macroSkipped ? "SKIPPED · DISABLED" : macroPassed ? "PASS · CLEAR" : `BLOCKED · ${macro.status}`;
  $("macro-gate-status").className = macroSkipped ? "gate-skipped" : macroPassed ? "gate-pass" : "gate-blocked";
  $("macro-gate-detail").textContent = macroSkipped
    ? "Macro/news filtering was not run. This entry was not news-filtered; SKIPPED is not CLEAR or PASS."
    : macroCheck?.reason ?? macro.reason ?? "No attributed macro status.";
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
  $("event-warning").querySelector("span").textContent = `${snapshot.eventFutures.reason} The app can show manual research signals and create local PAPER positions only; it cannot submit a live MEXC Event Futures order.`;
  const ticker = snapshot.market.data;
  $("chart-title").textContent = `${state.symbol} price action`;
  if (ticker) {
    $("price").textContent = money(ticker.lastPrice, state.symbol === "BTCUSDT" ? 1 : 2);
    $("change").textContent = `${ticker.priceChangePercent >= 0 ? "+" : ""}${ticker.priceChangePercent.toFixed(2)}%`;
    $("change").className = ticker.priceChangePercent >= 0 ? "positive" : "negative";
    $("source-name").textContent = snapshot.market.sourceName ?? snapshot.market.source ?? "Unavailable";
    $("source-time").textContent = `Source ${time(snapshot.market.sourceTimestamp)} · Received ${time(snapshot.market.receivedAt)}`;
    $("high-low").textContent = `${money(ticker.high24h)} / ${money(ticker.low24h)}`;
    const bookMetrics = snapshot.orderBook?.metrics;
    $("spread").textContent = bookMetrics?.valid ? `${bookMetrics.spreadBps.toFixed(3)} bps · ${money(bookMetrics.topNotional)} USDT top` : "—";
    $("volume").textContent = `${money(ticker.quoteVolume24h / 1e6, 1)}M USDT`;
    $("book-spread").textContent = bookMetrics?.valid ? `Best bid ${money(bookMetrics.bestBid, 4)} · ask ${money(bookMetrics.bestAsk, 4)} · ${bookMetrics.spreadBps.toFixed(3)} bps` : `Spread unavailable`;
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
  const verdictDirection = directionMeta(verdict);
  $("verdict").textContent = verdictDirection.label;
  $("verdict").title = verdictDirection.meaning;
  $("verdict").className = `verdict ${verdict === "UP" ? "verdict-up" : verdict === "DOWN" ? "verdict-down" : "verdict-wait"}`;
  $("up-score").textContent = `${analysis?.upScore ?? 50}%`; $("down-score").textContent = `${analysis?.downScore ?? 50}%`;
  $("up-fill").style.width = `${analysis?.upScore ?? 0}%`; $("down-fill").style.width = `${analysis?.downScore ?? 0}%`;
  $("estimate").textContent = analysis ? `${Math.max(analysis.upScore ?? 0, analysis.downScore ?? 0)}/100 · RAW NOT PROBABILITY` : "Unavailable";
  $("break-even").textContent = analysis ? pct(analysis.breakEvenProbability) : "—";
  $("confidence").textContent = analysis?.confidence ?? "—"; $("model").textContent = analysis?.modelVersion ?? "—";
  $("reasons").innerHTML = (analysis?.reasons ?? ["Waiting for verified candles."]).slice(0, 5).map((reason) => `<li>${escape(reason)}</li>`).join("");
  renderEntryGates(snapshot);
  renderBook(snapshot.orderBook.data);
}

function renderBook(book) {
  const levels = [...(book?.bids ?? []), ...(book?.asks ?? [])];
  const max = Math.max(1, ...levels.map((level) => level.quantity));
  const rows = (items, type) => items.map((level) => `<div class="book-row ${type}"><i style="width:${level.quantity / max * 100}%"></i><span>${money(level.price, 2)}</span><span>${money(level.quantity, 5)}</span></div>`).join("");
  $("asks").innerHTML = rows((book?.asks ?? []).slice(0, 6).reverse(), "ask");
  $("bids").innerHTML = rows((book?.bids ?? []).slice(0, 6), "bid");
}

function finiteText(value, digits = 2) { return Number.isFinite(value) ? Number(value).toFixed(digits) : "—"; }
function metadataValue(value) {
  if (value === null || value === undefined || value === "") return "lipsește";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function forecastBlockersMarkup(forecast) {
  const availability = forecast?.availability;
  if (!availability || !Array.isArray(availability.blockers)) return '<div class="forecast-blockers forecast-metadata-missing"><b>METADATE BLOCANTE INDISPONIBILE</b><span>Înregistrarea veche nu conține explicația structurată a indisponibilității.</span></div>';
  if (!availability.blockers.length) return "";
  return `<div class="forecast-blockers"><b>DE CE NU ESTE DISPONIBIL</b><ol>${availability.blockers.map((item) => `<li><strong>${escape(item.code ?? "BLOCANT NECUNOSCUT")}</strong><span>${escape(item.timeframe ?? "toate intervalele")} · sursă ${escape(item.source ?? "motor canonic")} · observat ${escape(metadataValue(item.observed))} · necesar ${escape(metadataValue(item.required))}</span><small>${escape(item.reason ?? "Motiv indisponibil")}</small></li>`).join("")}</ol><em>Observat la ${escape(time(availability.observedAt))}</em></div>`;
}
function reactionZoneMarkup(label, zone, kind) {
  const statusLabels = { UNAVAILABLE: "INDISPONIBILĂ", MONITORING: "MONITORIZARE", TESTING_ZONE: "ZONĂ TESTATĂ", REJECTION_CONFIRMED: "RESPINGERE CONFIRMATĂ", BREAKOUT_CONFIRMED: "BREAKOUT CONFIRMAT" };
  const suppliedStatus = statusLabels[zone?.status] ? zone.status : "UNAVAILABLE";
  const blockersComplete = Array.isArray(zone?.blockers);
  const strictReaction = suppliedStatus === "REJECTION_CONFIRMED"
    && zone?.confirmations?.zoneTouch?.confirmed === true
    && zone?.confirmations?.rejection?.confirmed === true
    && zone?.confirmations?.orderFlow?.confirmed === true
    && zone?.confirmations?.orderFlow?.live === true
    && zone?.confirmations?.breakout?.confirmed === false
    && zone?.confirmations?.breakout?.pending !== true
    && zone?.potentialSetup?.available === true
    && blockersComplete
    && zone.blockers.length === 0;
  const displayStatus = suppliedStatus === "REJECTION_CONFIRMED" && !strictReaction ? "TESTING_ZONE" : suppliedStatus;
  const range = Number.isFinite(zone?.zone?.lower) && Number.isFinite(zone?.zone?.upper) ? `${money(zone.zone.lower)} – ${money(zone.zone.upper)}` : "—";
  const relationLabels = { BELOW: "SUB ZONĂ", INSIDE: "ÎN ZONĂ", ABOVE: "PESTE ZONĂ" };
  const relation = relationLabels[zone?.reference?.relation] ?? "POZIȚIE NECUNOSCUTĂ";
  const distance = Number.isFinite(zone?.reference?.distanceToZone?.bps) && Number.isFinite(zone?.reference?.distanceToZone?.atr)
    ? `${zone.reference.distanceToZone.bps.toFixed(1)} bps · ${zone.reference.distanceToZone.atr.toFixed(2)} ATR · ${relation}`
    : Number.isFinite(zone?.reference?.distanceBps) && Number.isFinite(zone?.reference?.distanceAtr)
      ? `${zone.reference.distanceBps.toFixed(1)} bps · ${zone.reference.distanceAtr.toFixed(2)} ATR · ${relation}`
      : "—";
  const invalidation = Number.isFinite(zone?.invalidation?.price)
    ? `${zone.invalidation.condition === "COMPLETED_1M_CLOSE_ABOVE_ZONE_UPPER" ? "închidere 1m completă peste" : "închidere 1m completă sub"} ${money(zone.invalidation.price)}`
    : "regulă indisponibilă";
  const pendingBreakout = zone?.confirmations?.breakout?.pending === true;
  const nextAction = displayStatus === "BREAKOUT_CONFIRMED" ? "Nu mai trata nivelul drept zonă de reacție; așteaptă un nivel structural nou."
    : pendingBreakout ? "O închidere 1m a trecut de marginea îndepărtată; așteaptă a doua închidere pentru breakout sau revenirea completă în zonă."
      : displayStatus === "TESTING_ZONE" ? `Așteaptă respingerea ${kind === "ceiling" ? "superioară" : "inferioară"} explicită și confirmarea LIVE a order flow-ului.`
        : displayStatus === "MONITORING" ? "Monitorizează atingerea pe o lumânare 1m completă, apoi cere ambele confirmări stricte."
          : strictReaction ? "Folosește descrierea numai ca context; porțile existente ale candidatului rămân neschimbate."
            : "Așteaptă ancora, ATR-ul, referința și atribuirea completă.";
  return `<section class="reaction-zone reaction-zone-${kind} status-${String(displayStatus).toLowerCase()}"><header><div><small>${escape(label)}</small><b>${escape(range)}</b></div><span>${escape(statusLabels[displayStatus])}</span></header><div class="reaction-zone-state ${strictReaction ? "reaction-confirmed" : "reaction-waiting"}">${strictReaction ? "REACȚIE CONFIRMATĂ" : "AȘTEAPTĂ CONFIRMAREA"}</div><dl><dt>Distanță până la zonă</dt><dd>${escape(distance)}</dd><dt>Respingere 1m</dt><dd>${zone?.confirmations?.rejection?.confirmed ? "CONFIRMATĂ" : "NECONFIRMATĂ"}</dd><dt>Order flow LIVE</dt><dd>${zone?.confirmations?.orderFlow?.confirmed && zone?.confirmations?.orderFlow?.live ? `CONFIRMĂ ${escape(zone.potentialDirection)}` : `NU CONFIRMĂ · ${escape(zone?.confirmations?.orderFlow?.observedDirection ?? "NEUTRU")}`}</dd><dt>Invalidare</dt><dd>${escape(invalidation)}</dd></dl><p><b>ACȚIUNEA URMĂTOARE:</b> ${escape(nextAction)}</p><small class="reaction-disclaimer">Nu este garantată, nu este un nivel exact de inversare și nu este niciodată un motiv pentru a mări miza.</small></section>`;
}
function renderDeepDashboard() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const operations = state.operations ?? snapshot.operations ?? { status: "UNAVAILABLE", totals: {}, channels: [] };
  status($("operations-status"), operations.status ?? "UNAVAILABLE");
  const totals = operations.totals ?? {};
  $("operations-summary").innerHTML = [["LATENCY P95", `${finiteText(operations.latencyMs?.p95, 0)} ms`], ["GAPS / MISSING", `${totals.gaps ?? 0} / ${totals.missingMessages ?? 0}`], ["RECONNECT / FAILOVER", `${totals.reconnects ?? 0} / ${totals.failovers ?? 0}`], ["STALL / INVALID", `${totals.stalls ?? 0} / ${totals.invalidations ?? 0}`]].map(([label, value]) => `<div class="deep-stat"><small>${label}</small><b>${escape(value)}</b></div>`).join("");
  $("operations-channels").innerHTML = (operations.channels ?? []).map((channel) => `<div class="deep-row"><strong>${escape(channel.symbol)} · ${escape(channel.channel)}</strong><b class="status-${safeStatus(channel.status)}">${escape(channel.status)}</b><span>lag p95 ${finiteText(channel.latencyMs?.p95, 0)} ms · age ${finiteText(channel.ageMs?.current, 0)} ms · gap ${channel.gaps ?? 0} · duplicate ${channel.duplicates ?? 0} · watermark stall ${channel.stalls ?? 0}</span></div>`).join("") || '<div class="empty-card">No operational samples yet.</div>';

  const feed = snapshot.health?.feed ?? {};
  status($("feed-status"), feed.status ?? "UNAVAILABLE");
  $("feed-summary").innerHTML = (feed.channels ?? []).map((channel) => `<div class="deep-row"><strong>${escape(channel.channel)}</strong><b class="status-${safeStatus(channel.status)}">${escape(channel.status)}</b><span>lag ${finiteText(channel.lagMs, 0)} ms · seq ${escape(channel.lastSequence ?? "—")} · gap ${channel.gapCount ?? 0} · reconnect ${channel.reconnectCount ?? 0}</span></div>`).join("") || `<div class="empty-card">Stream ${escape(feed.status ?? "UNAVAILABLE")}.</div>`;
  const book = snapshot.orderBook ?? {};
  $("depth-summary").textContent = `${book.status ?? "UNAVAILABLE"} · synchronized ${book.synchronized === true ? "YES" : "NO"} · last update ${book.data?.lastUpdateId ?? "—"} · buffer ${book.bufferSize ?? 0} · ${book.reason ?? "No depth reason."}`;

  const flow = snapshot.orderFlow ?? {};
  status($("orderflow-status"), flow.status ?? "UNAVAILABLE");
  $("orderflow-imbalance").innerHTML = [5, 10, 20].map((level) => { const item = flow.imbalance?.[level]; return `<div class="flow-stat"><small>IMBALANCE ${level} LEVELS</small><b>${finiteText(item?.quantityImbalance, 4)} qty</b><span>${finiteText(item?.notionalImbalance, 4)} notional</span></div>`; }).join("");
  $("orderflow-windows").innerHTML = ["10s", "30s", "60s", "5m"].map((windowName) => { const volume = flow.aggressorVolume?.[windowName]; const cvd = flow.cvd?.[windowName]; return `<div class="flow-window"><strong>${windowName}</strong><span>BUY ${finiteText(volume?.buyNotional, 0)} / SELL ${finiteText(volume?.sellNotional, 0)}</span><span>CVD ${finiteText(cvd?.notional, 0)} · ${volume?.tradeCount ?? 0} trades</span></div>`; }).join("");
  const heuristicRows = [
    ["ABSORPTION", flow.absorption?.detected ? `${flow.absorption.side} · score ${finiteText(flow.absorption.score, 1)}` : `none · score ${finiteText(flow.absorption?.score, 1)}`, flow.absorption?.reason],
    ["REPLENISHMENT", flow.replenishment?.dominantSide ?? "—", `bid ${finiteText(flow.replenishment?.bid?.notional, 0)} · ask ${finiteText(flow.replenishment?.ask?.notional, 0)}`],
    ["DISAPPEARING", flow.disappearingLiquidity?.warning ? "WARNING" : "MONITOR", `bid unexplained ${finiteText(flow.disappearingLiquidity?.bid?.unexplainedRatio, 3)} · ask ${finiteText(flow.disappearingLiquidity?.ask?.unexplainedRatio, 3)}`],
    ["SPREAD / MICROPRICE", `${finiteText(flow.spreadInstability?.score, 1)} raw`, `micro ${finiteText(flow.microprice?.microprice, 4)} · deviation ${finiteText(flow.microprice?.deviationBps, 3)} bps`],
    ["SPOOF-RISK HEURISTIC", `${flow.spoofRisk?.level ?? "—"} · ${finiteText(flow.spoofRisk?.score, 1)}/100`, "HEURISTIC ONLY · NOT PROBABILITY"],
  ];
  $("orderflow-heuristics").innerHTML = heuristicRows.map(([label, value, detail]) => `<div class="deep-row"><strong>${escape(label)}</strong><b>${escape(value)}</b><span>${escape(detail ?? "Unavailable")}</span></div>`).join("");

  const candidates = snapshot.analysis?.candidates ?? [];
  const counterfactualByHorizon = new Map((state.counterfactuals ?? snapshot.counterfactuals ?? []).map((item) => [item.horizonMinutes, item]));
  $("engine-cards").innerHTML = candidates.map((candidate) => {
    const engine = candidate.engine ?? state.engines?.[candidate.horizonMinutes];
    const regime = candidate.extendedRegime ?? candidate.marketRegime?.extended;
    const blockers = candidate.engineBlockers ?? engine?.blockers ?? [];
    const readiness = counterfactualByHorizon.get(candidate.horizonMinutes) ?? {};
    const technical = engine?.technical ?? {};
    const forecastAvailable = candidate.forecast?.availability?.status === "AVAILABLE" && Array.isArray(candidate.forecast?.availability?.blockers) && candidate.forecast.availability.blockers.length === 0 && candidate.forecast?.available === true && Number.isFinite(candidate.forecast?.upPercent) && Number.isFinite(candidate.forecast?.downPercent);
    return `<article class="engine-card"><header><strong>${candidate.horizonMinutes}m · ${escape(engine?.version ?? "ENGINE UNAVAILABLE")}</strong><span class="${directionClass(candidate.direction)}">${escape(directionMeta(candidate.direction).label)}</span></header><dl><dt>Extended regime</dt><dd>${escape(regime?.regime ?? "UNAVAILABLE")}${regime?.failClosed ? " · FAIL CLOSED" : ""}</dd><dt>Raw technical split</dt><dd>${forecastAvailable ? `${finiteText(candidate.forecast.upPercent, 0)} UP / ${finiteText(candidate.forecast.downPercent, 0)} DOWN` : "— UP / — DOWN"}</dd><dt>Raw signed score</dt><dd>${finiteText(engine?.signedScore ?? technical.signedScore, 4)}</dd><dt>READY</dt><dd>${readiness.ready ? "YES" : `NO · ${readiness.blockedCount ?? blockers.length} blockers`}</dd></dl><div class="engine-score-note">RAW SCORES · NOT PROBABILITY</div>${forecastAvailable ? "" : forecastBlockersMarkup(candidate.forecast)}<ul class="blocker-list">${blockers.map((item) => `<li><b>${escape(item.code)}</b> · ${escape(item.reason)}${item.observed !== undefined || item.required !== undefined ? `<small>${escape(item.timeframe ?? "toate intervalele")} · observat ${escape(metadataValue(item.observed))} · necesar ${escape(metadataValue(item.required))}</small>` : ""}</li>`).join("") || "<li>No canonical engine blocker.</li>"}</ul><div class="counterfactual-list">${(readiness.requirements ?? readiness.counterfactuals ?? []).map((item) => `<div class="counterfactual"><b>${escape(item.code)}</b> · ${escape(item.reason ?? "Blocked")}${item.operator ? ` · exact ${escape(item.operator)} ${escape(item.threshold)} (delta ${escape(item.delta)})` : (item.nextCloseAt ?? item.nextObservableAt) ? ` · next completed observation ${time(item.nextCloseAt ?? item.nextObservableAt)}` : " · path-dependent, no invented threshold"}</div>`).join("") || '<div class="counterfactual">No missing READY requirement.</div>'}</div></article>`;
  }).join("") || '<div class="empty-card">Canonical 10m/30m engines await coherent completed candles and LIVE order flow.</div>';
}

function renderCalibrationAndReplay() {
  const calibration = state.calibration ?? state.snapshot?.calibration ?? {};
  const modelStates = calibration.status ?? [];
  const metrics = calibration.metrics ?? [];
  const curves = modelStates.filter((item) => item.status === "READY" && item.reliabilityCurve?.length).map((item) => ({ label: `${item.symbol} ${item.horizonMinutes}m ${item.direction} · ${item.selectedMethod}`, points: item.reliabilityCurve }))
    .concat(metrics.filter((item) => item.calibrationMethod !== "RAW" && item.reliability?.length).slice(0, 4).map((item) => ({ label: `${item.symbol} ${item.horizonMinutes}m ${item.direction} · ${item.calibrationMethod}`, points: item.reliability })));
  $("calibration-reliability").innerHTML = curves.slice(0, 4).map((curve) => `<div class="reliability-card"><header><strong>${escape(curve.label)}</strong><span>observed frequency by bin</span></header><div class="reliability-bars">${curve.points.map((point) => { const rawValue = point.observedFrequency ?? point.observedRate ?? point.accuracy; const value = Number(rawValue); const available = rawValue !== null && rawValue !== undefined && Number.isFinite(value) && (point.count ?? 1) > 0; return `<i class="reliability-bar${available ? "" : " reliability-unavailable"}" style="height:${available ? Math.max(2, Math.min(100, value * 100)) : 2}%"><span>${available ? Math.round(value * 100) : "—"}</span></i>`; }).join("")}</div></div>`).join("") || '<div class="empty-card">WARMUP: no reliability curve until a model is READY.</div>';
  const replay = state.replay ?? state.snapshot?.replay ?? {};
  $("replay-baselines").innerHTML = (replay.baselines ?? []).map((name) => `<span>${escape(name)}</span>`).join("") || "<span>No baselines configured</span>";
  $("replay-runs").innerHTML = (replay.runs ?? []).map((run) => `<div class="deep-row"><strong>${escape(run.id)} · ${escape(run.status)}</strong><b>${escape((run.symbols ?? []).join(", ") || "ALL")}</b><span>${time(run.createdAt)} · seed ${escape(run.seed)} · ${run.metrics?.predictions ?? 0} predictions · ${run.metrics?.resolved ?? 0} resolved</span></div>`).join("") || '<div class="empty-card">No persisted replay runs. Use npm run replay for deterministic offline research.</div>';
  $("operational-alerts").innerHTML = (state.alerts ?? state.snapshot?.alerts ?? []).slice(0, 30).map((alert) => `<div class="deep-row"><strong class="alert-severity-${String(alert.severity ?? "INFO").toLowerCase()}">${escape(alert.alertType)} · ${escape(alert.status)}</strong><b>${escape(alert.symbol)} / ${escape(alert.channel)}</b><span>${time(alert.lastSeenAt)} · ${escape(alert.payload?.state ?? alert.fingerprint)} · occurrences ${alert.occurrenceCount ?? 1}</span></div>`).join("") || '<div class="empty-card">No research alerts recorded.</div>';
}

function manualConfidenceFor(symbol, horizonMinutes, strategyVersion = "0.9.0") {
  return state.manualSignals?.empiricalConfidence?.find((item) => item.symbol === symbol && item.horizonMinutes === horizonMinutes && item.strategyVersion === strategyVersion) ?? null;
}

function renderLegacyManualSignals() {
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
    if (!signal) return `<article class="manual-card manual-wait"><div class="manual-card-head"><strong>${symbol} · ${horizonMinutes}m</strong><span>WAIT</span></div><div class="manual-direction manual-direction-wait"><small>SIGNAL DIRECTION</small><div><b aria-hidden="true">—</b><strong>WAIT</strong></div><span>No UP or DOWN signal yet.</span></div><div class="manual-instruction manual-action-wait">WAIT · DO NOT ENTER</div><small>Waiting for a completed-candle evaluation. Entry and confidence remain unavailable.</small></article>`;
    const actionState = localManualActionState(signal);
    const actionable = actionState === "ENTER_NOW";
    const tracking = actionState === "TRACKING_DO_NOT_ENTER_LATE";
    const currentlyBlocked = actionState === "BLOCKED_CURRENT_GATES";
    const confidenceText = confidence?.measuredRate == null ? "N/A" : pct(confidence.measuredRate);
    const confidenceDetail = confidence?.measuredRate == null
      ? `${confidence?.decisiveSample ?? 0}/${confidence?.minDecisiveSample ?? manual.policy?.minDecisiveSample ?? 20} decisive proxy outcomes`
      : `Wilson 95% ${pct(confidence.wilson95.lower)}–${pct(confidence.wilson95.upper)} · n=${confidence.decisiveSample}`;
    const hasDirection = signal.direction === "UP" || signal.direction === "DOWN";
    const direction = hasDirection ? signal.direction : "WAIT";
    const directionArrow = direction === "UP" ? "↑" : direction === "DOWN" ? "↓" : "—";
    const directionMeaning = direction === "UP"
      ? "Prediction: price will finish ABOVE the recorded entry."
      : direction === "DOWN"
        ? "Prediction: price will finish BELOW the recorded entry."
        : "No UP or DOWN signal right now.";
    const currentBlockReason = signal.currentEntryGate?.checks?.find((check) => check.status === "BLOCKED")?.reason;
    const instruction = actionable
      ? `PROXY SETUP READY · ${directionArrow} ${direction}`
      : tracking
        ? "RESEARCH WINDOW CLOSED · WATCH ONLY"
        : currentlyBlocked
          ? "CURRENT PROXY GATES BLOCKED"
          : actionState === "DISABLED"
            ? "DISABLED · DO NOT ENTER"
            : signal.status === "EXPIRED"
              ? `RESULT RECORDED · ${signal.proxyOutcome ?? "EXPIRED"}`
              : "WAIT · DO NOT ENTER";
    const actionNote = actionable
      ? "This is the only active entry window. Stop when the countdown reaches zero."
      : tracking
        ? `Entry window closed. The ${directionArrow} ${direction} call is shown for outcome tracking only.`
        : currentlyBlocked
          ? `The creation-time call remains in the audit, but live entry checks now block action. ${currentBlockReason ?? "Waiting for the next live recheck."}`
          : signal.status === "EXPIRED"
            ? "This call has finished. It is history, not a new entry."
            : "Wait for a proxy setup-ready state before reviewing the direction.";
    const statusLabel = actionable ? "PROXY READY" : tracking ? "WATCH ONLY" : currentlyBlocked ? "GATES BLOCKED" : actionState === "DISABLED" ? "DISABLED" : signal.status === "EXPIRED" ? "FINISHED" : "WAIT";
    const actionClass = actionable ? "enter-now" : tracking ? "watch-only" : "wait";
    const timer = actionable ? `research window closes ${remaining(signal.entryValidUntil)}` : tracking ? `proxy observation in ${remaining(signal.resolvesAt)}` : currentlyBlocked ? `research window ${remaining(signal.entryValidUntil)} · live recheck pending` : signal.status === "EXPIRED" ? `resolved ${time(signal.resolvedAt)}` : "no research window";
    const sourceName = signal.entrySource?.sourceName ?? signal.entrySource?.source ?? "No entry source";
    const fallback = signal.entrySource?.failover?.active === true;
    const invalidation = signal.invalidation?.text ?? (Number.isFinite(signal.invalidationPrice) ? `Completed-candle invalidation ${money(signal.invalidationPrice)}` : "No finite invalidation");
    const gateChecks = signal.currentEntryGate?.checks ?? signal.details?.entryGate?.checks ?? [];
    const importantChecks = ["CURRENT_ENTRY_RECHECK", "COMPLETED_1M_TRIGGER", "FIVE_MINUTE_CONFIRMATION", "TRIGGER_FRESHNESS", "SPREAD_LIMIT", "TOP_LIQUIDITY", "SOURCE_COHERENCE", "MACRO_NEWS"].map((code) => gateChecks.find((check) => check.code === code)).filter(Boolean);
    const gateMarkup = importantChecks.length ? importantChecks.map((check) => {
      const statusText = check.code === "MACRO_NEWS" && check.status === "SKIPPED" ? "SKIPPED (FILTER DISABLED)" : check.status;
      return `<span class="manual-gate gate-${check.status.toLowerCase()}">${escape(check.code.replaceAll("_", " "))}: ${escape(statusText)}</span>`;
    }).join("") : '<span class="manual-gate gate-blocked">ENTRY GATES: WAITING</span>';
    return `<article class="manual-card manual-${manualLifecycleClass(actionState)}">
      <div class="manual-card-head"><strong>${escape(symbol)} · ${horizonMinutes}m</strong><span>${escape(statusLabel)}</span></div>
      <div class="manual-direction manual-direction-${direction.toLowerCase()}"><small>SIGNAL DIRECTION</small><div><b aria-hidden="true">${directionArrow}</b><strong>${direction}</strong></div><span>${escape(directionMeaning)}</span></div>
      <div class="manual-instruction manual-action-${actionClass}">${escape(instruction)}</div>
      <div class="manual-action-note">${escape(actionNote)}</div>
      <div class="manual-gates">${gateMarkup}</div>
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
    <span>${time(signal.generatedAt)}</span><strong>${escape(signal.symbol)} · ${signal.horizonMinutes}m</strong><b class="${directionClass(signal.direction)}">${escape(directionMeta(signal.direction).label)}</b><span>${escape(localManualActionState(signal))}</span><span>${signal.qualityScore}/100</span><small>${escape(signal.proxyOutcome ?? signal.reasons?.at(-1) ?? "Recorded")}</small>
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
    const direction = directionMeta(candidate.direction);
    return `<article class="live-setup ${candidate.direction === "UP" ? "setup-up" : candidate.direction === "DOWN" ? "setup-down" : "setup-wait"}">
      <div class="setup-card-head"><strong>${escape(candidate.symbol)} · ${candidate.horizonMinutes}m</strong><span class="${directionClass(candidate.direction)}">${escape(direction.label)}</span></div>
      <div class="setup-direction-note">${escape(direction.meaning)}</div>
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
    <b class="${directionClass(decision.direction)}" title="${escape(directionMeta(decision.direction).meaning)}">${escape(directionMeta(decision.direction).label)}</b><span class="decision-action ${actionClass(decision.action)}">${escape(decision.action)}</span>
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
  const positionDirection = directionMeta(position?.direction);
  $("auto-position").innerHTML = position
    ? `<strong>OPEN LOCAL PAPER POSITION</strong><span>${escape(position.symbol)} · ${escape(positionDirection.label)} · ${position.horizonMinutes}m · ${money(position.stake)} USDT</span><small>${escape(positionDirection.meaning)} Quality ${position.qualityScore}/100 · resolves ${time(position.resolvesAt)} · no exchange order.</small>`
    : `<strong>${runtime.status === "PAUSED" ? "PAUSED" : "SCANNING"}</strong><span>${escape(runtime.pauseReason ?? "No autonomous PAPER position is open.")}</span><small>One-position PAPER lock is active; no exchange order path exists.</small>`;
  const action = decision?.action ?? "WAIT";
  $("auto-action").textContent = action; $("auto-action").className = `verdict ${actionClass(action)}`;
  $("auto-quality").textContent = decision ? `${decision.qualityScore}/100` : "—";
  $("auto-band").textContent = decision ? `${decision.qualityBand} setup quality · not probability` : "No completed setup yet";
  $("auto-market").textContent = decision ? `${decision.symbol} / ${decision.horizonMinutes}m` : "—";
  const decisionDirection = directionMeta(decision?.direction);
  $("auto-direction").textContent = decision ? `${decisionDirection.label} · ${decisionDirection.meaning}` : "— WAIT · No actionable direction.";
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
  $("positions").innerHTML = account.positions.length ? account.positions.slice(0, 10).map((position) => `<tr><td>${time(position.openedAt)}</td><td><span class="origin origin-${position.origin === "AUTONOMOUS" ? "autonomous" : "manual"}">${escape(position.origin ?? "MANUAL")}</span></td><td>${escape(position.symbol)}</td><td class="${directionClass(position.direction)}" title="${escape(directionMeta(position.direction).meaning)}">${escape(directionMeta(position.direction).label)}</td><td>${position.horizonMinutes}m</td><td>${money(position.entryPrice)}</td><td>${money(position.stake)}</td><td><span class="position-status">${escape(position.status)}</span></td><td>${position.pnl == null ? "—" : money(position.pnl)}</td></tr>`).join("") : '<tr><td colspan="9" class="empty">No paper positions yet.</td></tr>';
}

async function refresh() {
  if (document.hidden) { refreshQueued = true; return; }
  if (refreshInFlight) { refreshQueued = true; return; }
  refreshInFlight = true;
  refreshQueued = false;
  const requestedSymbol = state.symbol;
  const generation = ++refreshGeneration;
  try {
    const dashboard = await request(`/api/v1/dashboard?symbol=${encodeURIComponent(requestedSymbol)}`);
    if (generation !== refreshGeneration || requestedSymbol !== state.symbol) return;
    state.snapshot = dashboard.snapshot; state.account = dashboard.account; state.autonomous = dashboard.autonomous; state.performance = dashboard.performance; state.manualSignals = dashboard.manualSignals;
    state.operations = dashboard.operations ?? dashboard.snapshot.operations; state.alerts = dashboard.alerts ?? dashboard.snapshot.alerts ?? []; state.calibration = dashboard.calibration ?? dashboard.snapshot.calibration; state.replay = dashboard.replay ?? dashboard.snapshot.replay; state.engines = dashboard.engines ?? dashboard.snapshot.engines ?? {}; state.counterfactuals = dashboard.counterfactuals ?? dashboard.snapshot.counterfactuals ?? [];
    renderMarket(); renderAccount(); renderAutonomous(); renderManualSignals(); renderDeepDashboard(); renderCalibrationAndReplay(); $("connection-error").classList.add("hidden");
  } catch (error) {
    if (generation !== refreshGeneration || requestedSymbol !== state.symbol) return;
    $("connection-error").classList.remove("hidden"); $("connection-error").querySelector("span").textContent = error.message; status($("health"), "OFFLINE");
  } finally {
    refreshInFlight = false;
    if (refreshQueued && !document.hidden) queueMicrotask(refresh);
  }
}

async function openPaper(direction) {
  const notice = $("notice");
  try {
    await request("/api/v1/paper/positions", { method: "POST", body: JSON.stringify({ symbol: state.symbol, direction, horizonMinutes: Number($("horizon").value), stake: Number($("stake").value) }) });
    notice.textContent = `Local PAPER ${directionMeta(direction).label} position opened. No MEXC Event Futures order was sent.`; notice.classList.remove("hidden"); await refresh();
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
  const nextSymbol = button.dataset.symbol;
  if (state.symbol === nextSymbol && state.snapshot && state.manualSignals) return;
  state.symbol = nextSymbol;
  document.querySelectorAll("[data-symbol]").forEach((item) => item.classList.toggle("active", item === button));
  state.snapshot = null; state.manualSignals = null; state.operations = null; state.alerts = []; state.calibration = null; state.replay = null; state.engines = {}; state.counterfactuals = []; refresh();
}));
document.querySelectorAll("[data-timeframe]").forEach((button) => button.addEventListener("click", () => {
  state.timeframe = button.dataset.timeframe;
  document.querySelectorAll("[data-timeframe]").forEach((item) => item.classList.toggle("active", item === button));
  renderMarket();
}));
document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => openPaper(button.dataset.direction)));
$("risk-button").addEventListener("click", riskQuote);
$("auto-toggle").addEventListener("click", changeAutonomousState);
const terminalPanel = document.querySelector(".terminal-command");
const metricsPanel = document.querySelector(".metrics-grid");
if (terminalPanel && metricsPanel) metricsPanel.before(terminalPanel);
configureSound();
setInterval(() => { $("clock").textContent = `UTC ${new Date().toISOString().slice(11, 19)}`; }, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(refresh, 3000);
refresh();



function renderManualSignals() {
  const manual = state.manualSignals;
  if (!manual) return;
  const terminal = manual.terminal;
  $("manual-signal-state").textContent = manual.enabled ? "SCANNING" : "DISABLED";
  $("manual-signal-state").className = `mode ${manual.enabled ? "auto-running" : "auto-paused"}`;
  $("manual-signal-scan").textContent = manual.nextScanAt ? time(manual.nextScanAt) : "—";
  const terminalSource = terminal?.source;
  const feed = terminalSource?.feed;
  const streamDetail = feed?.enabled ? ` · STREAM ${feed.status} · reconectări ${feed.channels?.reduce((sum, channel) => sum + (channel.reconnectCount ?? 0), 0) ?? 0} · gap-uri ${feed.channels?.reduce((sum, channel) => sum + (channel.gapCount ?? 0), 0) ?? 0}` : " · STREAM DEZACTIVAT";
  $("manual-signal-source").textContent = terminalSource?.status === "LIVE"
    ? `${terminalSource.sourceName ?? terminalSource.source} · tick ${time(terminalSource.sourceTimestamp)}${terminalSource.fallback?.active ? ` · FALLBACK ${terminalSource.fallback.fallbackName ?? terminalSource.sourceName ?? terminalSource.source}` : " · PRIMARY"}${terminalSource.actionSourceCoherent === false ? " · SURSE DIFERITE — BLOCAT" : ""}${streamDetail}`
    : `Fără preț Spot proaspăt${streamDetail}`;
  $("manual-candle-freshness").textContent = `1m ${time(terminalSource?.completedOneMinuteAt)} (${terminalSource?.candleStatuses?.["1m"] ?? "—"}) · 5m ${time(terminalSource?.completedFiveMinuteAt)} (${terminalSource?.candleStatuses?.["5m"] ?? "—"}) · analiză ${time(terminalSource?.analysisCalculatedAt)}`;

  const checkLabel = (code) => ({
    CURRENT_ENTRY_RECHECK: "Revalidare setup", SIGNAL_DESK_DISABLED: "Scanner dezactivat", FEED_HEALTH: "Feed WebSocket", CORRECTION_STATE: "Stare corecție", LEVEL_STATE: "Stare nivel",
    COMPLETED_1M_TRIGGER: "Trigger 1m", FIVE_MINUTE_CONFIRMATION: "Trend 5m", FIFTEEN_MINUTE_ALIGNMENT: "Trend 15m",
    TRIGGER_FRESHNESS: "Fereastră intrare", QUALITY: "Calitate", FINITE_INVALIDATION: "Invalidare",
    CANDLE_SOURCE_COHERENCE: "Sursă lumânări", MARKET_FRESHNESS: "Date proaspete", ORDER_FLOW: "Order flow LIVE", EXTENDED_REGIME: "Regim extins", HORIZON_ENGINE: "Motor orizont", ORDER_BOOK_VALID: "Order book",
    SPREAD_LIMIT: "Spread", TOP_LIQUIDITY: "Lichiditate", SOURCE_COHERENCE: "Sursă preț/book", MACRO_NEWS: "Macro/news", DIRECTION: "Direcție", NO_CURRENT_CANDIDATE: "Niciun candidat curent",
  })[code] ?? code.replaceAll("_", " ");
  const confirmation = (label, item) => {
    const passed = item?.status === "PASS";
    const skipped = item?.status === "SKIPPED";
    const direction = ["UP", "DOWN"].includes(item?.direction) ? ` · ${directionMeta(item.direction).label}` : "";
    return `<div class="terminal-confirm ${passed ? "terminal-pass" : skipped ? "terminal-skip" : "terminal-block"}"><small>${escape(label)}</small><b>${passed ? "CONFIRMAT" : skipped ? "NEVERIFICAT" : "AȘTEAPTĂ"}${escape(direction)}</b><span>${time(item?.completedAt)}</span></div>`;
  };
  const interactionLabel = (value) => ({ CLEAR: "DEPARTE", APPROACHING: "SE APROPIE", TESTING: "TESTEAZĂ NIVELUL", REJECTED: "RESPINGERE CONFIRMATĂ", BREAK_PENDING_CONFIRMATION: "BREAKOUT NEConfirmat", BREAK_CONFIRMED: "BREAKOUT CONFIRMAT", UNAVAILABLE: "NEVERIFICAT" })[value] ?? String(value ?? "NEVERIFICAT").replaceAll("_", " ");
  const interactionSummary = (item) => `${interactionLabel(item?.status)}${item?.hasConfirmedBreak && item?.status !== "BREAK_CONFIRMED" ? ` + BREAK CONFIRMAT LA ${Number.isFinite(item.confirmedBreakLevel) ? money(item.confirmedBreakLevel) : "NIVEL ANTERIOR"}` : ""}`;
  const correctionLabel = (value) => ({ NO_CORRECTION: "FĂRĂ CORECȚIE", CORRECTION_STARTING: "CORECȚIE POSIBILĂ", CORRECTION_ACTIVE: "CORECȚIE ACTIVĂ", CORRECTION_END_CONFIRMED: "FINAL CORECȚIE CONFIRMAT", LOCAL_LEVEL_BREAK_CONFIRMED: "NIVEL LOCAL STRĂPUNS", NO_TREND: "FĂRĂ TREND", INSUFFICIENT_DATA: "DATE INSUFICIENTE", UNAVAILABLE: "NEVERIFICAT" })[value] ?? String(value ?? "NEVERIFICAT").replaceAll("_", " ");
  const outlookLabel = (value) => ({ CONTINUATION_UP: "CONTINUARE PROBABILĂ UP", CONTINUATION_DOWN: "CONTINUARE PROBABILĂ DOWN", REVERSAL_WATCH_UP: "POSIBILĂ TRANZIȚIE UP", REVERSAL_WATCH_DOWN: "POSIBILĂ TRANZIȚIE DOWN", RANGE_OR_TRANSITION: "RANGE / TRANZIȚIE", UNAVAILABLE: "NEVERIFICAT" })[value] ?? String(value ?? "NEVERIFICAT").replaceAll("_", " ");
  const level = (label, item, kind) => {
    const interaction = interactionSummary(item?.interaction);
    const context = Number.isFinite(item?.distanceBps)
      ? `${item.distanceBps.toFixed(1)} bps · ${interaction} · ${item.timeframe ?? "—"} · ${(item.source ?? "SURSA NECUNOSCUTĂ").replaceAll("_", " ")}`
      : "nivel indisponibil";
    return `<div class="terminal-level ${kind}"><small>${label}</small><b>${Number.isFinite(item?.price) ? money(item.price) : "—"}</b><span title="${escape(context)}">${escape(context)}</span></div>`;
  };
  const decisionExplanation = (round) => {
    const correction = round.correction;
    const code = round.actionable?.primaryBlocker?.code;
    if (["CORRECTION_ACTIVE", "CORRECTION_STARTING"].includes(correction?.status)) return `Trendul 5m rămâne ${correction.trendDirection}, dar corecția 1m este încă activă; așteaptă confirmarea finalului ei.`;
    if (correction?.status === "LOCAL_LEVEL_BREAK_CONFIRMED") return `Două lumânări 1m închise au străpuns nivelul local de ${correction.levelInteraction?.kind === "SUPPORT" ? "suport" : "rezistență"}${Number.isFinite(correction.levelInteraction?.confirmedBreakLevel) ? ` la ${money(correction.levelInteraction.confirmedBreakLevel)}` : ""}. Intrarea rămâne blocată până la reconfirmare; trendul 5m nu este declarat invalid fără închiderea sa structurală.`;
    return ({
      FEED_HEALTH: "Canalele Binance WebSocket necesare nu sunt toate LIVE; intrarea rămâne blocată până la refacerea feedului.",
      CORRECTION_STATE: "Corecția persistentă nu a ajuns încă într-o stare care permite intrarea.",
      LEVEL_STATE: "Nivelul relevant este indisponibil sau are o străpungere în confirmare/confirmată.",
      COMPLETED_1M_TRIGGER: "Așteaptă o lumânare 1m închisă cu impuls sau respingere clară în direcția trendului.",
      FIVE_MINUTE_CONFIRMATION: "Triggerul 1m nu este încă susținut de structura trendului 5m.",
      FIFTEEN_MINUTE_ALIGNMENT: "Contextul 15m este opus sau neutru; direcția nu are încă aliniere completă.",
      QUALITY: "Scorul setupului este sub pragul minim de calitate.",
      TRIGGER_FRESHNESS: "Triggerul 1m a expirat; se așteaptă următoarea lumânare relevantă.",
      CANDLE_SOURCE_COHERENCE: "Lumânările, prețul și order book-ul nu vin momentan din aceeași sursă.",
      MARKET_FRESHNESS: "Datele de piață nu sunt suficient de proaspete pentru evaluare.",
      ORDER_FLOW: "Order flow-ul canonic nu este LIVE sau nu este suficient de proaspăt; evaluarea rămâne blocată.",
      EXTENDED_REGIME: "Regimul extins lipsește sau impune închiderea preventivă a evaluării.",
      HORIZON_ENGINE: "Motorul canonic al orizontului este WAIT, indisponibil, în conflict sau blocat.",
      NO_CURRENT_CANDIDATE: "Nu există un candidat canonic curent pentru acest simbol și orizont.",
      CURRENT_ENTRY_RECHECK: "Setupul inițial nu mai este prezent în analiza actuală.",
    })[code] ?? round.actionable?.primaryBlocker?.text ?? "Așteaptă alinierea fluxului 1m, trendului 5m și contextului 15m.";
  };
  const roundMarkup = (round) => {
    const forecast = round.forecast ?? { upPercent: null, downPercent: null, leader: "NEUTRAL", confidence: "LOW", available: false };
    const forecastAvailable = forecast.availability?.status === "AVAILABLE" && Array.isArray(forecast.availability?.blockers) && forecast.availability.blockers.length === 0 && forecast.available === true && Number.isFinite(forecast.upPercent) && Number.isFinite(forecast.downPercent);
    const forecastAvailabilityMarkup = forecastAvailable ? "" : forecastBlockersMarkup(forecast);
    const reactionZonesMarkup = `<div class="reaction-zone-grid">${reactionZoneMarkup("PLAFON POTENȚIAL", round.reactionZones?.ceiling, "ceiling")}${reactionZoneMarkup("PODEA POTENȚIAL", round.reactionZones?.floor, "floor")}</div>`;
    const flow = round.marketFlow?.oneMinute ?? { direction: "NEUTRAL", strengthPercent: 0, momentum: "UNAVAILABLE", bars: 0 };
    const fiveTrend = round.marketFlow?.fiveMinute ?? { direction: "NEUTRAL", establishedDirection: "NEUTRAL", outlook: "UNAVAILABLE", confidencePercent: 0 };
    const correction = round.correction ?? { status: "UNAVAILABLE", depthAtr: null, depthBps: null, durationBars: 0, levelInteraction: { status: "UNAVAILABLE" } };
    const correctionRoute = correction.correctionDirection === "DOWN" ? "PULLBACK DOWN CĂTRE SUPORT" : correction.correctionDirection === "UP" ? "RALIU CORECTIV UP CĂTRE REZISTENȚĂ" : "FĂRĂ DIRECȚIE CORECTIVĂ";
    const supportInteraction = round.levelInteractions?.support;
    const resistanceInteraction = round.levelInteractions?.resistance;
    const trendDirection = ["UP", "DOWN"].includes(fiveTrend.establishedDirection) ? fiveTrend.establishedDirection : fiveTrend.direction;
    const bias = ["UP", "DOWN"].includes(trendDirection) ? directionMeta(trendDirection) : { label: "— NEUTRU", meaning: "Trendul 5m nu este suficient de clar." };
    const actionDirection = round.actionable?.direction;
    const action = round.state === "ENTER_NOW"
      ? { label: `SETUP PROXY VALID ${directionMeta(actionDirection).label}`, className: actionDirection === "UP" ? "terminal-action-up" : "terminal-action-down", note: "Toate filtrele Spot proxy au trecut. Verifică separat contractul Event Futures; aceasta nu este o instrucțiune sau confirmare de ordin live." }
      : round.state === "TRACKING"
        ? { label: "FEREASTRĂ ÎNCHISĂ · URMĂRIRE", className: "terminal-action-track", note: "Fereastra setupului s-a închis; semnalul este urmărit numai pentru rezultatul proxy." }
        : round.state === "RESOLVED"
          ? { label: "ÎNCHEIAT · ISTORIC", className: "terminal-action-track", note: "Acest rezultat proxy nu este un setup nou." }
          : round.state === "DISABLED"
            ? { label: "SCANNER DEZACTIVAT", className: "terminal-action-wait", note: round.actionable?.primaryBlocker?.text ?? "Scannerul manual este dezactivat." }
            : { label: "WAIT · FĂRĂ SETUP", className: "terminal-action-wait", note: decisionExplanation(round) };
    const countdownTarget = round.state === "ENTER_NOW" ? round.actionable.entryValidUntil : round.state === "TRACKING" ? round.timing.targetAt : round.timing.entryValidUntil;
    const quality = round.quality ?? { score: 0, band: "BELOW_STANDARD", minimum: 68 };
    const invalidation = round.levels?.invalidation;
    const invalidationCondition = invalidation?.condition === "COMPLETED_CLOSE_BELOW"
      ? "închidere completă sub nivel"
      : invalidation?.condition === "COMPLETED_CLOSE_ABOVE" ? "închidere completă peste nivel" : "regulă indisponibilă";
    const invalidationContext = [invalidation?.timeframe, invalidationCondition, invalidation?.source?.replaceAll("_", " ")].filter(Boolean).join(" · ");
    const checks = round.details?.checks ?? [];
    const readiness = round.readiness ?? { ready: false, requirements: [] };
    const readinessMarkup = readiness.ready
      ? '<div class="terminal-readiness readiness-ready"><strong>READY</strong><span>Nu lipsește nicio condiție auditată.</span></div>'
      : `<div class="terminal-readiness"><strong>CE LIPSEȘTE PENTRU READY · ${readiness.blockedCount ?? readiness.requirements?.length ?? 0}</strong><ol>${(readiness.requirements ?? []).map((item) => `<li><b>${escape(checkLabel(item.code))}</b><span>${escape(item.reason ?? item.condition ?? "Condiție neîndeplinită")}${(item.nextCloseAt ?? item.nextObservableAt) ? ` · următoarea observație ${time(item.nextCloseAt ?? item.nextObservableAt)}` : ""}</span></li>`).join("") || "<li><span>Se așteaptă evaluarea contrafactuală.</span></li>"}</ol></div>`;
    const regime = round.marketRegime;
    const persistent = round.persistentState;
    const stateMarkup = `<div class="terminal-state-line"><span>REGIM ${escape(regime?.phase ?? "NECUNOSCUT")} · VOLATILITATE ${escape(regime?.volatility ?? "NECUNOSCUTĂ")}</span><span>CORECȚIE PERSISTATĂ ${escape(persistent?.correction?.state ?? "—")} · v${escape(persistent?.correction?.version ?? "—")}</span></div>`;
    const checksMarkup = checks.map((check) => `<div class="terminal-check"><span>${escape(checkLabel(check.code))}</span><b class="gate-${check.status.toLowerCase()}">${escape(check.status)}</b><small>${escape(check.reason)}</small></div>`).join("");
    const reasons = (round.details?.reasons ?? []).slice(-5).map((reason) => `<li>${escape(reason)}</li>`).join("");
    return `<article class="event-round-card event-round-${round.state.toLowerCase()}">
      <div class="event-round-head"><div><small>ORIZONT ANALIZAT</small><strong>${escape(round.symbol)} · ${round.horizonMinutes} MINUTE</strong></div><div class="event-countdown"><small>${round.state === "ENTER_NOW" ? "SETUPUL EXPIRĂ" : round.state === "TRACKING" ? "REZULTAT PROXY" : "TRIGGER VALID"}</small><b>${countdownTarget ? remaining(countdownTarget) : "—"}</b></div></div>
      <div class="terminal-forecast">
        <div class="forecast-side forecast-up"><small>SCOR BRUT UP · NOT PROBABILITY</small><b>↑ ${forecastAvailable ? `${forecast.upPercent}%` : "—"}</b></div>
        <div class="forecast-center"><div class="forecast-track"><i class="forecast-up-fill" style="width:${forecastAvailable ? forecast.upPercent : 0}%"></i><i class="forecast-down-fill" style="width:${forecastAvailable ? forecast.downPercent : 0}%"></i></div><strong>${escape(forecastAvailable ? (forecast.leader === "NEUTRAL" ? "ECHILIBRU" : `${directionMeta(forecast.leader).label} DOMINANT`) : "SCOR INDISPONIBIL")}</strong><span>${escape(forecastAvailable ? `${forecast.confidence} · RAW TECHNICAL SCORE · NOT PROBABILITY` : "Vezi blocantele exacte observate mai jos.")}</span></div>
        <div class="forecast-side forecast-down"><small>SCOR BRUT DOWN · NOT PROBABILITY</small><b>${forecastAvailable ? `${forecast.downPercent}%` : "—"} ↓</b></div>
        ${forecastAvailabilityMarkup}
      </div>
      <div class="terminal-decision-grid">
        <div class="terminal-bias ${directionClass(trendDirection)}"><small>TREND STABILIT PE 5m</small><b>${escape(bias.label)}</b><span>${escape(outlookLabel(fiveTrend.outlook))} · acord ${fiveTrend.confidencePercent ?? 0}%</span></div>
        <div class="terminal-action ${action.className}"><small>DECIZIE ACUM</small><b>${escape(action.label)}</b><span>${escape(action.note)}</span></div>
      </div>
      <div class="terminal-pulse-grid">
        <div class="terminal-pulse ${directionClass(flow.direction)}"><small>FLUX ULTIMELE ${flow.bars ?? 0} LUMÂNĂRI 1m</small><b>${escape(directionMeta(flow.direction).label)} · ${flow.strengthPercent ?? 0}%</b><span>impuls ${escape(String(flow.momentum ?? "UNAVAILABLE").replaceAll("_", " ").toLowerCase())}</span></div>
        <div class="terminal-pulse correction-${String(correction.status ?? "unavailable").toLowerCase()}"><small>CORECȚIE FAȚĂ DE TRENDUL 5m</small><b>${escape(correctionLabel(correction.status))}</b><span>${escape(correctionRoute)}${Number.isFinite(correction.depthAtr) ? ` · ${correction.depthAtr.toFixed(2)} ATR · ${correction.durationBars} lumânări 1m` : " · se așteaptă suficiente lumânări închise"}</span></div>
        <div class="terminal-pulse"><small>INTERACȚIUNI CU NIVELURILE</small><b>S ${escape(interactionSummary(supportInteraction))} · R ${escape(interactionSummary(resistanceInteraction))}</b><span>SUPORT ${Number.isFinite(supportInteraction?.level) ? money(supportInteraction.level) : "—"} · REZISTENȚĂ ${Number.isFinite(resistanceInteraction?.level) ? money(resistanceInteraction.level) : "—"}</span></div>
      </div>
      ${reactionZonesMarkup}
      <div class="terminal-prices"><div><small>REFERINȚĂ 1m ÎNCHISĂ</small><b>${Number.isFinite(round.prices?.reference?.value) ? money(round.prices.reference.value) : "—"}</b><span>${time(round.prices?.reference?.observedAt)}</span></div><div><small>PREȚ PROXY ÎNREGISTRAT</small><b>${Number.isFinite(round.prices?.entry?.value) ? money(round.prices.entry.value) : "—"}</b><span>${round.state === "ENTER_NOW" || round.state === "TRACKING" ? "observație Spot salvată" : "numai la setup proxy valid"}</span></div><div><small>PREȚ SPOT ACUM</small><b>${Number.isFinite(round.prices?.current?.value) ? money(round.prices.current.value) : "—"}</b><span>${time(round.prices?.current?.observedAt)}</span></div></div>
      <div class="terminal-confirmations">${confirmation("TRIGGER 1m", round.confirmations?.oneMinute)}${confirmation("TREND 5m", round.confirmations?.fiveMinute)}${confirmation("TREND 15m", round.confirmations?.fifteenMinute)}</div>
      <div class="terminal-levels">${level("SUPORT", round.levels?.support, "support")}${level("REZISTENȚĂ", round.levels?.resistance, "resistance")}<div class="terminal-level invalidation"><small>INVALIDARE</small><b>${Number.isFinite(invalidation?.price) ? money(invalidation.price) : "—"}</b><span title="${escape(invalidation?.text ?? invalidationContext)}">${escape(invalidationContext || "nivel necesar")}</span></div></div>
      <div class="terminal-quality"><div><small>CALITATE SETUP · MINIM ${quality.minimum}</small><b>${quality.score}/100 · ${escape(quality.band)}</b></div><i><span style="width:${Math.max(0, Math.min(100, quality.score))}%"></span></i></div>
      ${stateMarkup}
      ${readinessMarkup}
      <div class="terminal-primary-reason ${round.state === "ENTER_NOW" ? "reason-ready" : "reason-wait"}"><strong>${round.state === "ENTER_NOW" ? "TOATE FILTRELE SPOT PROXY AU TRECUT" : escape(checkLabel(round.actionable?.primaryBlocker?.code ?? "WAIT_FOR_SETUP"))}</strong><span>${escape(round.state === "ENTER_NOW" ? action.note : decisionExplanation(round))}</span></div>
      <details class="terminal-details"><summary>Vezi analiza completă și toate filtrele</summary><div class="terminal-checks">${checksMarkup || '<div class="terminal-check"><small>Se așteaptă evaluarea.</small></div>'}</div>${reasons ? `<ul>${reasons}</ul>` : ""}<p>Calitatea este un scor determinist, nu probabilitate garantată. Setupul folosește doar proxy Spot; contractul, payout-ul, lichiditatea și decontarea Event Futures trebuie verificate separat. Aplicația nu trimite ordine.</p></details>
    </article>`;
  };
  $("manual-signal-cards").innerHTML = terminal?.rounds?.length ? terminal.rounds.map(roundMarkup).join("") : '<div class="empty-card">Terminalul așteaptă date coerente pentru simbolul selectat.</div>';

  const calibrationItems = state.calibration?.status?.length ? state.calibration.status : (manual.forecastCalibration ?? []);
  $("manual-confidence").innerHTML = calibrationItems.map((item) => {
    const selectedMetrics = item.selectedMethod ? item.metrics?.[item.selectedMethod] : null;
    const brier = selectedMetrics?.brierScore ?? item.brierScore;
    const logloss = selectedMetrics?.logLoss ?? item.logLoss;
    const ece = selectedMetrics?.expectedCalibrationError ?? item.expectedCalibrationError;
    const model = item.status === "READY" ? `${item.selectedMethod ?? item.calibrationMethod ?? "MODEL"} · ${item.models?.[item.selectedMethod]?.id ?? item.calibrationModelId ?? "active"}` : "NO MODEL · RAW SCORES ONLY";
    return `<div class="confidence-row"><strong>${escape(item.symbol)} · ${item.horizonMinutes}m${item.direction ? ` · ${escape(item.direction)}` : ""}</strong><span class="segment-${segmentClass(item.status)}">${escape(item.status)}</span><b>${escape(model)}</b><small>sample ${item.sampleSize ?? item.directionalSample ?? item.decisiveSample ?? 0}/${item.minSample ?? item.minSampleSize ?? manual.policy?.forecastCalibrationMinSample ?? 50} · Brier ${finiteText(brier, 4)} · log loss ${finiteText(logloss, 4)} · ECE ${finiteText(ece, 4)} · Spot proxy research only</small></div>`;
  }).join("") || '<div class="empty-card">Calibrarea rămâne WARMUP până la eșantionul minim prospectiv.</div>';
  $("manual-history").innerHTML = (manual.recent ?? []).slice(0, 12).map((signal) => `<div class="manual-history-row"><span>${time(signal.generatedAt)}</span><strong>${escape(signal.symbol)} · ${signal.horizonMinutes}m</strong><b class="${directionClass(signal.direction)}">${escape(directionMeta(signal.direction).label)}</b><span>${escape(localManualActionState(signal))}</span><span>${signal.qualityScore}/100</span><small>${escape(signal.proxyOutcome ?? signal.reasons?.at(-1) ?? "Înregistrat")}</small></div>`).join("") || '<div class="empty-card">Nu există încă istoric.</div>';
  notifyNewManualSignal(manual.ready ?? []);
  if (manualDeadlineTimer) clearTimeout(manualDeadlineTimer);
  const futureTimes = (terminal?.rounds ?? []).flatMap((round) => [round.actionable?.entryValidUntil, round.timing?.targetAt]).map((value) => new Date(value).getTime()).filter((value) => Number.isFinite(value) && value > Date.now()).sort((left, right) => left - right);
  manualDeadlineTimer = futureTimes.length ? setTimeout(() => { manualDeadlineTimer = null; renderManualSignals(); }, Math.max(1, futureTimes[0] - Date.now() + 1)) : null;
}
