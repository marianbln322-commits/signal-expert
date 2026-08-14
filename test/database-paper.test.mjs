import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../app/database.mjs";
import { PaperService } from "../app/paper-service.mjs";

test("paper positions persist with immutable source metadata",()=>{const directory=mkdtempSync(join(tmpdir(),"signal-expert-"));const database=new Database(join(directory,"test.db"),resolve("migrations"));const candidate={symbol:"BTCUSDT",horizonMinutes:10,direction:"UP"};const entryGate={allowed:true,policyVersion:"entry-gates-v0.5.0",checks:[{code:"TEST_FIXTURE",status:"PASS",reason:"Trusted unit fixture."}]};const snapshot={health:{overall:"LIVE",market:"LIVE",dataUsable:true},market:{data:{lastPrice:65000},source:"MEXC_SPOT_REST",sourceTimestamp:new Date().toISOString()},analysis:{modelVersion:"test",candidates:[candidate]}};const market={snapshot:()=>snapshot,evaluateEntry:()=>entryGate};const paper=new PaperService({market,database,settings:{payoutRate:.8,initialBankroll:1200,dailyLossLimit:60,maxOpenPositions:2,btcMaxStake:250,ethMaxStake:150}});paper.initialize();const position=paper.open({symbol:"BTCUSDT",direction:"UP",horizonMinutes:10,stake:5});assert.equal(position.entryPrice,65000);assert.equal(database.positions()[0].sourceName,"MEXC_SPOT_REST");assert.equal(database.positions()[0].entryGate.policyVersion,"entry-gates-v0.5.0");paper.stop();database.close();rmSync(directory,{recursive:true,force:true})});
