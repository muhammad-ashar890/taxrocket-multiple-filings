"use strict";
// Pure staged contract tests. Real calculation + expectations + plan + driver;
// no top-level packet action, database, browser or live IRIS is claimed here.
const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./helpers/pension-harness.cjs');
const load = harness({ mockCompleteness: true }).load;
const { calculateTaxEstimate } = load('lib/tax/tax-calculation.ts');
const { buildExpectedIrisTotals } = load('lib/tax/business-iris-expectations.ts');
const { buildFourIncomePlan, isFourIncomeSourceSet } = load('lib/tax/four-income-plan.ts');
const driver = require('../electron-connect/iris-computations-driver.js');
const sources = ['salary','business','pension','services'];
const plain = x=>JSON.parse(JSON.stringify(x));
function fixture({ salary=7000000, business=5000000, treatment='final_above_10m', annual=12000000, service=1800000 }={}) {
  const pensionEstimate = calculateTaxEstimate({taxYear:2026,filerStatus:'ATL',totalIncome:annual,totalExpenses:0,isSalariedRoute:false,isBankProfitRoute:false,incomeSources:[{route:'pension',income:annual}],pensionerAgeBelow70:treatment!=='exempt_age70',pensionerAge70OrAbove:treatment==='exempt_age70',pensionTaxAsSalary:treatment==='salary'});
  assert.equal(pensionEstimate.status,'ESTIMATE');
  const pension = {treatment,annualPension:annual,baseTax:pensionEstimate.baseTax,surcharge:pensionEstimate.surcharge};
  const estimate = calculateTaxEstimate({taxYear:2026,filerStatus:'ATL',totalIncome:salary+business+annual+service,totalExpenses:0,isSalariedRoute:true,isBankProfitRoute:false,incomeSources:[{route:'salary',income:salary},{route:'business_profit',income:business},{route:'pension',income:annual},{route:'services',income:service,subcategory:'export-it-ites-pseb'}],pensionerAgeBelow70:treatment!=='exempt_age70',pensionerAge70OrAbove:treatment==='exempt_age70',pensionTaxAsSalary:treatment==='salary'});
  assert.equal(estimate.status,'ESTIMATE');
  const combined = estimate.breakdown.find(x=>x.route==='combined_slab');
  assert.ok(combined);
  const expectations = buildExpectedIrisTotals({fields:[{irisCode:'3009',ourAmount:business+1000000,section:'Manufacturing/ Trading Items',column:'Total Amount'},{irisCode:'3039',ourAmount:1000000,section:'Manufacturing/ Trading Items',column:'Total Amount'}],incomeSources:sources,assetCodes:[],liabilityCodes:[],companionNormalIncome:{normalTaxableIncome:salary+(treatment==='salary'?annual:0),salaryHeadIncome:salary+(treatment==='salary'?annual:0),finalPensionSurcharge:treatment==='final_above_10m'?pension.surcharge:0}});
  const servicesFields = ['Total Amount','Subject to Final Tax'].map(column=>({irisCode:'3101',ourAmount:service,section:'Other Revenues',portalArea:'Business',column,servicesMappingKind:'SERVICES_INCOME'}));
  return {taxYear:2026,filerType:'myself',incomeSources:sources,calculationRevision:'synthetic-current-revision',salaryGross:salary,pension,servicesFields,hasUnmappedPortalIncome:false,approvedNormalTax:{taxableIncome:combined.income,normalTax:combined.baseTax,surcharge:combined.surcharge},businessExpectedIrisTotals:expectations};
}
const requirePlan = input => { const result=buildFourIncomePlan(input); assert.equal(result.ok,true,result.reason); return result.plan; };
function permutations(items) { return items.length ? items.flatMap((item,index)=>permutations(items.filter((_,i)=>i!==index)).map(rest=>[item,...rest])) : [[]]; }
test('all 24 source orders produce the same staged four-source contract',()=>{
  for(const incomeSources of permutations(sources)) {
    assert.equal(isFourIncomeSourceSet(incomeSources),true);
    const plan=requirePlan({...fixture(),incomeSources});
    assert.equal(plan.expectedTaxableIncome,12000000);
    assert.equal(plan.expectedNormalTax,4490000);
    assert.equal(plan.normalSurcharge,404100);
    assert.equal(plan.pensionSurcharge,10000);
    assert.equal(plan.combinedSurcharge,414100);
    assert.equal(plan.surchargeOwner,'field_map');
    assert.equal(plan.computations.surcharge.fieldMapCombinedValue,414100);
    assert.deepEqual(driver.validatePlan(plan.computations),[]);
  }
});
test('exempt, age70, normal and final pension retain correct components',()=>{
  for(const [treatment,annual] of [['exempt',9000000],['exempt_age70',18000000],['salary',5000000],['final_above_10m',12000000]]) {
    const f=fixture({treatment,annual}), plan=requirePlan(f);
    assert.equal(plan.expectedTaxableIncome,12000000+(treatment==='salary'?annual:0));
    assert.equal(plan.pensionSurcharge,treatment==='final_above_10m'?10000:0);
    assert.equal(plan.services.normalIncome,0);
    assert.equal(plan.services.finalIncome,1800000);
  }
});
test('Services folds accounting totals once without entering normal slabs; input remains unchanged',()=>{
  const f=fixture(); const before=JSON.stringify(f);const plan=requirePlan(f);
  assert.equal(JSON.stringify(f),before);
  for(const code of ['3129','3200','3000']) {
    const old=f.businessExpectedIrisTotals.rows.find(r=>r.code===code&&r.column==='total');
    assert.equal(plan.expectedIrisTotals.rows.find(r=>r.code===code&&r.column==='total').expected,old.expected+1800000);
  }
  assert.equal(plan.expectedIrisTotals.rows.some(r=>r.code==='9200'),false,'no normal subtotal mislabelled as complete four-source liability');
  assert.equal(plan.expectedIrisTotals.rows.find(r=>r.code==='9100').expected,12000000);
});
test('below/equal/above 10m bases use the right normal surcharge while pension stays separate',()=>{
  for(const total of [9999999,10000000,10000001]) {
    const plan=requirePlan(fixture({salary:7000000,business:total-7000000}));
    assert.equal(plan.normalSurcharge,total>10000000?Math.round(plan.expectedNormalTax*0.09):0);
    assert.equal(plan.combinedSurcharge,plan.normalSurcharge+10000);
  }
});
test('zero normal tax is valid, not missing evidence',()=>{
  const plan=requirePlan(fixture({salary:200000,business:100000}));
  assert.equal(plan.expectedNormalTax,0);
  assert.equal(plan.normalSurcharge,0);
  assert.equal(plan.combinedSurcharge,10000);
  assert.equal(plan.computations.surcharge.action,'NONE');
});
test('normal/mixed Services, negative amounts, duplicate cells and unverified mappings fail closed',()=>{
  for(const mutate of [
    f=>{f.servicesFields.pop();},
    f=>{f.servicesFields[1].ourAmount=900000;},
    f=>{f.servicesFields[0].ourAmount=-1;},
    f=>{f.servicesFields.push({...f.servicesFields[0]});},
    f=>{f.servicesFields[0].irisCode='999999';},
    f=>{f.servicesFields[0].column='Subject to Exemption';},
    f=>{f.hasUnmappedPortalIncome=true;},
  ]) { const f=plain(fixture()); mutate(f);assert.equal(buildFourIncomePlan(f).ok,false); }
});
test('missing/null/NaN inputs and wrong route/year/filer never become zero evidence',()=>{
  for(const override of [{salaryGross:null},{salaryGross:NaN},{pension:null},{approvedNormalTax:null},{calculationRevision:null},{calculationRevision:''},{taxYear:2025},{filerType:'my_business'},{incomeSources:['salary','business','pension','services','services']},{incomeSources:['salary','business','pension',null]},{incomeSources:['salary','business','services']}]) assert.equal(buildFourIncomePlan({...fixture(),...override}).ok,false,JSON.stringify(override));
});
test('stale approved line, stale typed-base expectations, loss ambiguity and invalid pension figures are refused',()=>{
  for(const mutate of [
    f=>{f.approvedNormalTax.surcharge=449000;}, // old >75%-for-surcharge interpretation
    f=>{f.approvedNormalTax.normalTax+=100000;},
    f=>{f.businessExpectedIrisTotals.computations.expectedTaxableIncome+=1;},
    f=>{f.businessExpectedIrisTotals.computations.expectedBusinessIncome-=100;},
    f=>{f.businessExpectedIrisTotals.rows.find(r=>r.code==='9100').expected+=100;},
    f=>{f.pension.surcharge=99999;},
    f=>{f.pension.baseTax=null;},
    f=>{f.businessExpectedIrisTotals.rows.find(r=>r.code==='923184').expected+=100;},
    f=>{f.businessExpectedIrisTotals.computations.surcharge.alreadyHandledInFieldMap=false;},
  ]) {const f=plain(fixture());mutate(f);assert.equal(buildFourIncomePlan(f).ok,false);}
});
test('minimum-tax and possible super-tax cases are explicitly refused, not silently omitted',()=>{
  const f=fixture();f.businessExpectedIrisTotals.computations.minimumTaxRegime='normal';
  assert.equal(buildFourIncomePlan(f).reason,'minimum_tax_not_supported');
  const large=fixture({salary:140000000,business:5000000,annual:12000000,service:1800000});
  assert.equal(buildFourIncomePlan(large).reason,'super_tax_review_required');
});
test('actual computations driver verifies combined row and refuses pension-only/wrong base without a second writer',()=>{
  const plan=requirePlan(fixture());const cells=(a,b)=>[{value:String(a??''),editable:true},{},{},{value:String(b??''),editable:false}];
  const rows=[{code:'9100',cells:cells('',plan.expectedTaxableIncome)},{code:'920000',cells:cells('',plan.expectedNormalTax)},{code:'923184',cells:cells(plan.combinedSurcharge,0)}];
  const d=rr=>driver.decideComputations(plan.computations,rr).entries[0];
  assert.equal(d(rows).reason,'combined_verified_in_field_map');
  const wrong=plain(rows);wrong[2].cells[0].value='10000';assert.equal(d(wrong).reason,'field_map_missing_normal_half');
  const stale=plain(rows);stale[0].cells[3].value='15000000';assert.equal(d(stale).reason,'iris_base_differs');
});
test('four-income exposure is envelope-bound at the desktop entry point',()=>{
  const {isSingleFreelancerServicesFiling,isFourIncomeFiling}=load('lib/tax/business-bank-categories.ts');
  assert.equal(isSingleFreelancerServicesFiling({taxYear:2026,filerType:'myself',incomeSources:sources}),true);
  assert.equal(isFourIncomeFiling({taxYear:2026,filerType:'myself',incomeSources:sources}),true);
  assert.equal(isFourIncomeFiling({taxYear:2026,filerType:'myself',incomeSources:['salary','business','pension']}),false);
  // Execution still requires the versioned desktop envelope + Business
  // computations plan. Wiring is asserted by verify-four-income-production.cjs
  // and verify-four-income-route.cjs.
  const mainSource=require('fs').readFileSync(require('path').join(__dirname,'../electron-connect/main.js'),'utf8');
  assert.match(mainSource,/four-income-v1/);
  assert.match(mainSource,/salary_business_pension_services/);
});
