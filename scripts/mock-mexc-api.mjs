import { createServer } from "node:http";
const port = Number(process.env.MOCK_MEXC_PORT ?? 4200);
const now = Date.now();
const json = (response, value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`); const symbol = url.searchParams.get("symbol") ?? "BTCUSDT"; const base = symbol === "ETHUSDT" ? 1927 : 65266;
  if (url.pathname.endsWith("/ticker/24hr")) return json(response, { symbol, priceChange: "10", priceChangePercent: "0.10", lastPrice: String(base), bidPrice: String(base - .1), askPrice: String(base + .1), openPrice: String(base - 10), highPrice: String(base + 20), lowPrice: String(base - 30), volume: "1000", quoteVolume: String(base * 1000), openTime: now - 86400000, closeTime: Date.now(), count: 1000 });
  if (url.pathname.endsWith("/depth")) return json(response, { lastUpdateId: 1, bids: [[String(base - .1), "1.2"]], asks: [[String(base + .1), "1.1"]] });
  if (url.pathname.endsWith("/klines")) {
    const interval = url.searchParams.get("interval"); const minutes = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 }[interval] ?? 1;
    return json(response, Array.from({ length: 80 }, (_, index) => { const openTime = now - (80 - index) * minutes * 60000; const open = base - 80 + index; const closeTime = openTime + minutes * 60000 - 1; return [openTime, String(open), String(open + 3), String(open - 2), String(open + 1), String(100 + index), closeTime, String((100 + index) * open), 10 + index]; }));
  }
  response.writeHead(404); response.end();
}).listen(port, "127.0.0.1", () => console.log(`Mock MEXC API on ${port}`));
