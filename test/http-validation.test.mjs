import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard visibly labels unavailable, fallback diagnostics and paper-only data",()=>{const html=readFileSync("public/index.html","utf8");assert.match(html,/EVENT FUTURES FEED UNAVAILABLE/);assert.match(html,/MARKET DATA PROVIDER/);assert.match(html,/PAPER ONLY/);assert.match(html,/CONFIGURED · NOT LIVE/);const app=readFileSync("public/app.js","utf8");assert.match(app,/MEXC UNAVAILABLE — FALLBACK ACTIVE/);assert.match(app,/MARKET DATA UNAVAILABLE/)});
test("environment template contains no secret values",()=>{const env=readFileSync(".env.example","utf8");assert.doesNotMatch(env,/API_KEY|PRIVATE_KEY|SECRET=/)});
