import test from "node:test";
import assert from "node:assert/strict";
import { MexcSpotProvider } from "../app/mexc-provider.mjs";

const ticker={symbol:"BTCUSDT",priceChange:"100",priceChangePercent:"0.2",lastPrice:"65000",bidPrice:"64999",askPrice:"65001",openPrice:"64900",highPrice:"65100",lowPrice:"64800",volume:"10",quoteVolume:"650000",openTime:1,closeTime:1700000000000,count:42};
test("provider validates and timestamps a ticker",async()=>{const provider=new MexcSpotProvider("https://example.test",{fetchImpl:async()=>new Response(JSON.stringify(ticker),{status:200,headers:{"content-type":"application/json"}})});const result=await provider.ticker("BTCUSDT");assert.equal(result.data.lastPrice,65000);assert.equal(result.source,"CONFIGURED_MARKET_PROVIDER");assert.equal(result.sourceTimestamp,new Date(ticker.closeTime).toISOString())});
test("provider rejects malformed external data",async()=>{const provider=new MexcSpotProvider("https://example.test",{fetchImpl:async()=>new Response(JSON.stringify({...ticker,lastPrice:null}),{status:200})});await assert.rejects(()=>provider.ticker("BTCUSDT"),/missing/)});
