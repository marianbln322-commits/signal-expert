import { resolve } from "node:path";
import { Database } from "../app/database.mjs";
import { createApplication } from "../app/server.mjs";

const now = Date.now();
function candles(minutes, base) {
  return Array.from({ length: 100 }, (_, index) => {
    const openTime = now - (100 - index) * minutes * 60_000;
    const trend = index * (minutes === 1 ? 1.5 : 2.5);
    const wave = Math.sin(index / 4) * 16;
    const open = base + trend + wave;
    const close = open + Math.sin(index / 2) * 5;
    return { openTime, closeTime: openTime + minutes * 60_000 - 1, open, high: Math.max(open, close) + 7, low: Math.min(open, close) - 6, close, volume: 80 + Math.abs(Math.sin(index)) * 110, quoteVolume: (80 + index) * close, trades: 40 + index, closed: true };
  });
}
const envelope = (data) => ({ data, source: "DEVELOPMENT_FIXTURE", sourceUrl: "fixture://browser-validation", sourceTimestamp: new Date().toISOString(), receivedAt: new Date().toISOString() });
const provider = {
  name: "Development fixture — not live",
  async ticker(symbol) { const eth = symbol === "ETHUSDT"; return envelope({ symbol, lastPrice: eth ? 1927.71 : 65266.4, bidPrice: eth ? 1927.70 : 65266.3, askPrice: eth ? 1927.72 : 65266.5, priceChange: eth ? 1.2 : 82.4, priceChangePercent: eth ? 0.06 : 0.13, high24h: eth ? 1937.86 : 65320, low24h: eth ? 1912.28 : 64730.5, baseVolume24h: 12000, quoteVolume24h: eth ? 23_000_000 : 390_000_000, tradeCount24h: 32000 }); },
  async depth(symbol) { const base = symbol === "ETHUSDT" ? 1927.71 : 65266.4; return envelope({ lastUpdateId: 1, bids: Array.from({ length: 20 }, (_, i) => ({ price: base - (i + 1) * 0.5, quantity: 0.2 + Math.abs(Math.sin(i)) * 2 })), asks: Array.from({ length: 20 }, (_, i) => ({ price: base + (i + 1) * 0.5, quantity: 0.2 + Math.abs(Math.cos(i)) * 2 })) }); },
  async klines(symbol, timeframe) { const minutes = { "1m": 1, "5m": 5, "15m": 15 }[timeframe]; return envelope(candles(minutes, symbol === "ETHUSDT" ? 1750 : 65000)); },
};
const database = new Database(resolve("data/browser-fixture.db"), resolve("migrations"));
const application = await createApplication({ database, provider });
application.server.listen(4100, "127.0.0.1", () => console.log("DEVELOPMENT_FIXTURE http://127.0.0.1:4100"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { await application.close(); process.exit(0); });
