import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../app/database.mjs";
import { createApplication } from "../app/server.mjs";

function candles(intervalMinutes) {
  const now = Date.now();
  return Array.from({ length: 80 }, (_, index) => {
    const openTime = now - (80 - index) * intervalMinutes * 60_000;
    const open = 65000 + index * 2;
    const close = index === 79 ? open + 7 : open + 2;
    const volume = index === 79 ? 500 : 100 + index;
    return { openTime, closeTime: openTime + intervalMinutes * 60_000 - 1, open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume, quoteVolume: volume * close, trades: 20 + index, closed: true };
  });
}
function envelope(data, sourceTimestamp = new Date()) {
  return { data, source: "DEVELOPMENT_FIXTURE", sourceUrl: "fixture://integration", sourceTimestamp: sourceTimestamp.toISOString(), receivedAt: new Date().toISOString() };
}
const provider = {
  name: "Development fixture",
  async ticker(symbol) { return envelope({ symbol, lastPrice: 65160, bidPrice: 65159, askPrice: 65161, priceChange: 160, priceChangePercent: 0.25, high24h: 65200, low24h: 64700, baseVolume24h: 1000, quoteVolume24h: 65_000_000, tradeCount24h: 12000 }); },
  async depth() { return envelope({ lastUpdateId: 1, bids: [{ price: 65159, quantity: 1.2 }], asks: [{ price: 65161, quantity: 1.1 }] }); },
  async klines(_symbol, timeframe) { const minutes = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 }[timeframe]; return envelope(candles(minutes)); },
};

test("HTTP application serves health, verified classifications, dashboard and paper workflow", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "signal-expert-http-"));
  const database = new Database(join(directory, "test.db"), resolve("migrations"));
  const application = await createApplication({ database, provider });
  await new Promise((resolveListen) => application.server.listen(0, "127.0.0.1", resolveListen));
  const address = application.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  context.after(async () => { await application.close(); rmSync(directory, { recursive: true, force: true }); });

  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.status, "ok");
  assert.equal(health.liveExecution.available, false);

  const market = await fetch(`${base}/api/v1/market/BTCUSDT`).then((response) => response.json());
  assert.equal(market.market.classification, "RAW");
  assert.equal(market.market.source, "DEVELOPMENT_FIXTURE");
  assert.equal(market.analysis.timeframes["1h"].regime, "BULLISH");
  assert.ok(market.candles["1h"].data.every((candle) => candle.closed));
  assert.equal(market.eventFutures.status, "UNAVAILABLE");
  assert.equal(market.analysis.calibrationStatus, "UNCALIBRATED");

  const page = await fetch(base).then((response) => response.text());
  assert.match(page, /Signal Expert/);
  assert.match(page, /PAPER ONLY/);

  const opened = await fetch(`${base}/api/v1/paper/positions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: "BTCUSDT", direction: "UP", horizonMinutes: 10, stake: 5 }) });
  assert.equal(opened.status, 201);
  const account = await fetch(`${base}/api/v1/paper/account`).then((response) => response.json());
  assert.equal(account.openPositions, 1);
  assert.equal(account.locked, 5);
});
