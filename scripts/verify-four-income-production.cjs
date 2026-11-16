"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const {fourIncomeHarness} = require('./helpers/four-income-harness.cjs');
test('real calculation and packet actions produce a dedicated four-source contract',async()=>{
  const h=fourIncomeHarness();
  const result=await h.calculate(); assert.equal(result.success,true,result.error);
  assert.equal(result.result.status,'ESTIMATE',result.result.note);
  const servicesLine=result.result.breakdown.find(line=>line.route==='services');
  assert.equal(servicesLine&&servicesLine.isFinalTax,true);
  const generated=await h.generate();assert.equal(generated.success,true,generated.error);
  const snapshot=JSON.parse(h.state.packets.at(-1).snapshotJson);
  assert.equal(snapshot.fourIncome.version,'four-income-v1');
  assert.equal(snapshot.fourIncome.calculationRevision,h.state.draft.taxCalculationRevision);
  assert.equal(snapshot.fourIncome.expectedTaxableIncome,15500000);
  assert.equal(snapshot.fourIncome.expectedNormalTax,4606000);
  assert.equal(snapshot.fourIncome.normalSurcharge,414540);
  assert.equal(snapshot.fourIncome.pensionSurcharge,10000);
  assert.equal(snapshot.fourIncome.combinedSurcharge,424540);
  assert.equal(snapshot.portalFieldMap.adjustableTaxFields.filter(x=>x.irisCode==='923184').length,1);
  assert.equal(snapshot.portalFieldMap.adjustableTaxFields.find(x=>x.irisCode==='923184').ourAmount,424540);
  assert.equal(snapshot.fourIncome.liability.totalTax,result.result.taxDue);
  assert.equal(snapshot.fourIncome.liability.taxPayable,h.state.draft.taxPayable);
});

test('stale four-income packets are refused at every read surface',async()=>{
  const h=fourIncomeHarness();
  await h.calculate();
  const generated=await h.generate();assert.equal(generated.success,true,generated.error);
  const snapshot=JSON.parse(h.state.packets.at(-1).snapshotJson);
  const { fourIncomePacketValidationError }=h.load('lib/tax/four-income-packet-validation.ts');
  assert.equal(await fourIncomePacketValidationError(snapshot,'qa-draft','qa-user'),null);
  // 1) wrong contract version
  const wrongVersion={...snapshot,fourIncome:{...snapshot.fourIncome,version:'four-income-v0'}};
  assert.match(await fourIncomePacketValidationError(wrongVersion,'qa-draft','qa-user'),/contract version/);
  // 2) stale revision (calculation advanced after approval)
  const stale={...snapshot,fourIncome:{...snapshot.fourIncome,calculationRevision:'deadbeef-dead-dead-dead-deaddeadbeef'}};
  assert.match(await fourIncomePacketValidationError(stale,'qa-draft','qa-user'),/calculation revision changed/);
  // 3) dropped normal-slab component (taxable income shrunk in IRIS expectations view)
  const wrongMath={...snapshot,fourIncome:{...snapshot.fourIncome,expectedTaxableIncome:15500001}};
  assert.match(await fourIncomePacketValidationError(wrongMath,'qa-draft','qa-user'),/contract check failed/);
  // 4) draft withholding exceeds liability at validation time (refund ambiguity)
  const original=h.state.draft.taxWithheld;
  h.state.draft.taxWithheld=999999999;
  assert.match(await fourIncomePacketValidationError(snapshot,'qa-draft','qa-user'),/withholding/i);
  h.state.draft.taxWithheld=original;
  // 5) legacy packet (no envelope) against a four-income draft must refuse
  const legacy={...snapshot};delete legacy.fourIncome;
  assert.match(await fourIncomePacketValidationError(legacy,'qa-draft','qa-user'),/predates the four-income contract/);
});
