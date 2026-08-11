const state = { symbol: "BTCUSDT", timeframe: "1m", snapshot: null, account: null };
const $ = (id) => document.getElementById(id);
const money = (value, digits = 2) => Number(value).toLocaleString("ro-RO", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value) => `${(value * 100).toFixed(2)}%`;
const time = (value) => value ? new Date(value).toLocaleTimeString("ro-RO", { hour12: false }) : "—";
const escape = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...options?.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`);
  return payload;
}
function status(element, value) {
  element.className = `status status-${value.toLowerCase()}`;
  element.innerHTML = `<i></i>${escape(value)}`;
}
function chart(candles) {
  if (!candles?.length) { $("chart").innerHTML = '<div class="chart-empty">Waiting for verified candles…</div>'; return; }
  const visible = candles.slice(-80); const width = 1000; const height = 330; const pad = 28;
  const high = Math.max(...visible.map((candle) => candle.high)); const low = Math.min(...visible.map((candle) => candle.low)); const range = high - low || 1;
  const step = (width - pad * 2) / visible.length; const y = (price) => pad + (high - price) / range * (height - pad * 2);
  let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><rect width="${width}" height="${height}" fill="#0b1421" rx="12"/>`;
  for (let index = 0; index < 5; index += 1) { const price = high - range * index / 4; svg += `<line x1="${pad}" x2="${width-pad}" y1="${y(price)}" y2="${y(price)}" stroke="#223047"/><text x="${width-pad+4}" y="${y(price)+4}" class="axis-label">${money(price, 2)}</text>`; }
  visible.forEach((candle, index) => { const green = candle.close >= candle.open; const color = green ? "#18d79a" : "#ff5573"; const x = pad + index * step + step / 2; const top = y(Math.max(candle.open, candle.close)); const body = Math.max(1.4, Math.abs(y(candle.open) - y(candle.close))); const width = Math.max(3, step * .56); svg += `<g opacity="${candle.closed ? 1 : .7}"><line x1="${x}" x2="${x}" y1="${y(candle.high)}" y2="${y(candle.low)}" stroke="${color}"/><rect x="${x-width/2}" y="${top}" width="${width}" height="${body}" fill="${color}" rx=".8"/></g>`; });
  $("chart").innerHTML = `${svg}</svg>`;
}
function renderProviderDiagnostic(snapshot) {
  const element = $("provider-diagnostic"); const provider = snapshot.health.provider;
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
  const snapshot = state.snapshot; if (!snapshot) return;
  status($("health"), snapshot.health.overall); status($("book-health"), snapshot.orderBook.status); renderProviderDiagnostic(snapshot);
  $("event-warning").querySelector("span").textContent = snapshot.eventFutures.reason;
  const ticker = snapshot.market.data; $("chart-title").textContent = `${state.symbol} price action`;
  if (ticker) {
    $("price").textContent = money(ticker.lastPrice, state.symbol === "BTCUSDT" ? 1 : 2);
    $("change").textContent = `${ticker.priceChangePercent >= 0 ? "+" : ""}${ticker.priceChangePercent.toFixed(2)}%`;
    $("change").className = ticker.priceChangePercent >= 0 ? "positive" : "negative";
    $("source-name").textContent = snapshot.market.sourceName ?? snapshot.market.source ?? "Unavailable";
    $("source-time").textContent = `Source ${time(snapshot.market.sourceTimestamp)} · Received ${time(snapshot.market.receivedAt)}`;
    $("high-low").textContent = `${money(ticker.high24h)} / ${money(ticker.low24h)}`;
    const spread = ticker.askPrice && ticker.bidPrice ? ticker.askPrice - ticker.bidPrice : null;
    $("spread").textContent = spread === null ? "—" : money(spread, 4); $("volume").textContent = `${money(ticker.quoteVolume24h / 1e6, 1)}M USDT`; $("book-spread").textContent = `Spread ${spread === null ? "—" : money(spread, 4)}`;
  } else clearTicker();
  chart(snapshot.candles[state.timeframe].data);
  const analysis = snapshot.analysis; const timeframe = analysis?.timeframes[state.timeframe]; const indicators = timeframe?.indicators;
  const fields = [["REGIME", timeframe?.regime], ["RSI 14", indicators?.rsi14?.toFixed(1)], ["ATR 14", indicators?.atr14?.toFixed(2)], ["REL. VOLUME", indicators?.relativeVolume20 ? `${indicators.relativeVolume20.toFixed(2)}×` : null], ["SUPPORT", indicators?.support?.toFixed(2)], ["RESISTANCE", indicators?.resistance?.toFixed(2)]];
  $("indicators").innerHTML = fields.map(([label, value]) => `<div><small>${label}</small><b>${value ?? "—"}</b></div>`).join("");
  const verdict = analysis?.direction ?? "WAIT"; $("verdict").textContent = verdict; $("verdict").className = `verdict verdict-${verdict.toLowerCase()}`;
  $("up-score").textContent = analysis?.upScore ?? 0; $("down-score").textContent = analysis?.downScore ?? 0; $("up-fill").style.width = `${analysis?.upScore ?? 0}%`; $("down-fill").style.width = `${analysis?.downScore ?? 0}%`;
  $("estimate").textContent = analysis?.heuristicProbability == null ? "Unavailable" : pct(analysis.heuristicProbability); $("break-even").textContent = analysis ? pct(analysis.breakEvenProbability) : "—"; $("confidence").textContent = analysis?.confidence ?? "—"; $("model").textContent = analysis?.modelVersion ?? "—";
  $("reasons").innerHTML = (analysis?.reasons ?? ["Waiting for verified candles."]).slice(0, 5).map((reason) => `<li>${escape(reason)}</li>`).join("");
  renderBook(snapshot.orderBook.data);
}
function renderBook(book) {
  const levels = [...(book?.bids ?? []), ...(book?.asks ?? [])]; const max = Math.max(1, ...levels.map((level) => level.quantity));
  const rows = (items, type) => items.map((level) => `<div class="book-row ${type}"><i style="width:${level.quantity/max*100}%"></i><span>${money(level.price,2)}</span><span>${money(level.quantity,5)}</span></div>`).join("");
  $("asks").innerHTML = rows((book?.asks ?? []).slice(0, 6).reverse(), "ask"); $("bids").innerHTML = rows((book?.bids ?? []).slice(0, 6), "bid");
}
function renderAccount() {
  const account = state.account; if (!account) return;
  $("payout").textContent = pct(account.payout.value); $("equity").textContent = `${money(account.equity)} USDT`; $("available").textContent = money(account.available); $("pnl").textContent = money(account.realizedPnl); $("pnl").className = account.realizedPnl >= 0 ? "positive" : "negative"; $("database").textContent = `Database: ${account.persistence.mode}`; $("record-count").textContent = `${account.positions.length} records`;
  $("positions").innerHTML = account.positions.length ? account.positions.slice(0, 10).map((position) => `<tr><td>${time(position.openedAt)}</td><td>${position.symbol}</td><td class="${position.direction === "UP" ? "positive" : "negative"}">${position.direction}</td><td>${position.horizonMinutes}m</td><td>${money(position.entryPrice)}</td><td>${money(position.stake)}</td><td><span class="position-status">${position.status}</span></td><td>${position.pnl == null ? "—" : money(position.pnl)}</td></tr>`).join("") : '<tr><td colspan="8" class="empty">No paper positions yet.</td></tr>';
}
async function refresh() {
  try {
    const [snapshot, account] = await Promise.all([request(`/api/v1/market/${state.symbol}`), request("/api/v1/paper/account")]);
    state.snapshot = snapshot; state.account = account; renderMarket(); renderAccount(); $("connection-error").classList.add("hidden");
  } catch (error) { $("connection-error").classList.remove("hidden"); $("connection-error").querySelector("span").textContent = error.message; status($("health"), "OFFLINE"); }
}
async function openPaper(direction) {
  const notice = $("notice");
  try { await request("/api/v1/paper/positions", { method: "POST", body: JSON.stringify({ symbol: state.symbol, direction, horizonMinutes: Number($("horizon").value), stake: Number($("stake").value) }) }); notice.textContent = `PAPER ${direction} opened. No MEXC order was sent.`; notice.classList.remove("hidden"); await refresh(); }
  catch (error) { notice.textContent = error.message; notice.classList.remove("hidden"); }
}
async function riskQuote() {
  const output = $("risk-result");
  try { const result = await request("/api/v1/paper/risk-quote", { method: "POST", body: JSON.stringify({ symbol: state.symbol, cumulativeLoss: Number($("loss").value), targetProfit: 4, baseStake: 5, estimatedProbability: null }) }); output.innerHTML = `<div class="risk-result ${result.allowed ? "allowed" : "blocked"}"><strong>${result.allowed ? "ALLOWED" : "BLOCKED"}</strong><span>Required stake: ${money(result.requiredRecoveryStake)} USDT</span><span>Expected value: ${result.expectedValue == null ? "Unavailable" : money(result.expectedValue)}</span><ul>${result.reasons.map((reason) => `<li>${escape(reason)}</li>`).join("")}</ul></div>`; }
  catch (error) { output.textContent = error.message; }
}
document.querySelectorAll("[data-symbol]").forEach((button) => button.addEventListener("click", () => { state.symbol = button.dataset.symbol; document.querySelectorAll("[data-symbol]").forEach((item) => item.classList.toggle("active", item === button)); state.snapshot = null; refresh(); }));
document.querySelectorAll("[data-timeframe]").forEach((button) => button.addEventListener("click", () => { state.timeframe = button.dataset.timeframe; document.querySelectorAll("[data-timeframe]").forEach((item) => item.classList.toggle("active", item === button)); renderMarket(); }));
document.querySelectorAll("[data-direction]").forEach((button) => button.addEventListener("click", () => openPaper(button.dataset.direction)));
$("risk-button").addEventListener("click", riskQuote); setInterval(() => { $("clock").textContent = `UTC ${new Date().toISOString().slice(11,19)}`; }, 1000); setInterval(refresh, 3000); refresh();
