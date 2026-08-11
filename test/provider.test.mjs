import test from "node:test";
import assert from "node:assert/strict";
import { FailoverMarketProvider, MexcSpotProvider } from "../app/mexc-provider.mjs";

const ticker = { symbol: "BTCUSDT", priceChange: "100", priceChangePercent: "0.2", lastPrice: "65000", bidPrice: "64999", askPrice: "65001", openPrice: "64900", highPrice: "65100", lowPrice: "64800", volume: "10", quoteVolume: "650000", openTime: 1, closeTime: 1700000000000, count: 42 };
const tickerEnvelope = (source) => ({ data: { symbol: "BTCUSDT", lastPrice: 65000 }, source, sourceName: source, sourceUrl: "https://example.test", sourceTimestamp: new Date().toISOString(), receivedAt: new Date().toISOString(), failover: { active: false, primarySource: source, primaryError: null } });

test("provider validates, identifies and timestamps a configured ticker source", async () => {
  const provider = new MexcSpotProvider("https://example.test", { attempts: 1, fetchImpl: async () => new Response(JSON.stringify(ticker), { status: 200, headers: { "content-type": "application/json" } }) });
  const result = await provider.ticker("BTCUSDT");
  assert.equal(result.data.lastPrice, 65000);
  assert.equal(result.source, "CONFIGURED_MARKET_PROVIDER");
  assert.equal(result.sourceTimestamp, new Date(ticker.closeTime).toISOString());
});

test("provider rejects malformed external data", async () => {
  const provider = new MexcSpotProvider("https://example.test", { attempts: 1, fetchImpl: async () => new Response(JSON.stringify({ ...ticker, lastPrice: null }), { status: 200 }) });
  await assert.rejects(() => provider.ticker("BTCUSDT"), /missing/);
});

test("failover uses and explicitly attributes fallback after primary failure", async () => {
  const primary = { name: "MEXC Spot REST v3", sourceId: "MEXC_SPOT_REST", official: true, async ticker() { throw new Error("MEXC blocked [ECONNREFUSED]"); } };
  const fallback = { name: "Binance Spot Market Data", sourceId: "BINANCE_SPOT_REST", official: true, async ticker() { return tickerEnvelope("BINANCE_SPOT_REST"); } };
  const provider = new FailoverMarketProvider(primary, fallback);
  const result = await provider.ticker("BTCUSDT");
  assert.equal(result.source, "BINANCE_SPOT_REST");
  assert.equal(result.failover.active, true);
  assert.match(result.failover.primaryError, /ECONNREFUSED/);
  assert.equal(result.failover.fallbackName, "Binance Spot Market Data");
});

test("failover reports both exact errors when all providers fail", async () => {
  const failing = (name, sourceId, message) => ({ name, sourceId, official: true, async depth() { throw new Error(message); } });
  const provider = new FailoverMarketProvider(failing("MEXC", "MEXC_SPOT_REST", "primary timeout"), failing("Binance", "BINANCE_SPOT_REST", "fallback blocked"));
  await assert.rejects(() => provider.depth("BTCUSDT"), /primary timeout.*fallback blocked/);
});
