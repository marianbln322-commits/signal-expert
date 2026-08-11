import test from "node:test";
import assert from "node:assert/strict";
import { adaptiveStake, analyzeMarket, breakEvenProbability } from "../app/quant.mjs";

const series=(direction,count=60)=>Array.from({length:count},(_,index)=>{const open=100+direction*index*.2,close=open+direction*.12;return{openTime:index*60000,closeTime:(index+1)*60000-1,open,high:Math.max(open,close)+.05,low:Math.min(open,close)-.05,close,volume:100+index,quoteVolume:(100+index)*close,trades:10,closed:true}});
test("payout break-even is mathematically correct",()=>assert.ok(Math.abs(breakEvenProbability(.8)-.5555555)<1e-6));
test("aligned bullish candles produce a higher UP score",()=>{const rising=series(1);const result=analyzeMarket({"1m":rising,"5m":rising,"15m":rising},.8,new Date(0));assert.ok(result.upScore>result.downScore);assert.equal(result.timeframes["15m"].regime,"BULLISH");assert.equal(result.calibrationStatus,"UNCALIBRATED")});
test("insufficient history produces WAIT",()=>{const short=series(1,10);assert.equal(analyzeMarket({"1m":short,"5m":short,"15m":short},.8).direction,"WAIT")});
test("adaptive recovery blocks a capped loss chase",()=>{const result=adaptiveStake({bankroll:1200,baseStake:5,cumulativeLoss:185,targetProfit:4,payoutRate:.8,estimatedProbability:.62,maxStake:150,maxBankrollFraction:.15,dailyLoss:0,dailyLossLimit:60,openPositions:0,maxOpenPositions:2,dataHealthy:true,volatilityRegime:"NORMAL",correlatedExposureFraction:0});assert.equal(result.allowed,false);assert.ok(result.requiredRecoveryStake>150)});
test("adaptive recovery blocks uncalibrated probabilities",()=>{const result=adaptiveStake({bankroll:1200,baseStake:5,cumulativeLoss:5,targetProfit:4,payoutRate:.8,estimatedProbability:null,maxStake:150,maxBankrollFraction:.15,dailyLoss:0,dailyLossLimit:60,openPositions:0,maxOpenPositions:2,dataHealthy:true,volatilityRegime:"NORMAL",correlatedExposureFraction:0});assert.equal(result.allowed,false);assert.match(result.reasons.join(" "),/calibrated/)});
