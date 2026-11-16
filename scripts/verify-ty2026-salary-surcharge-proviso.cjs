"use strict";
// TY2026: the Section 4AB salary-head proviso and slab-table test are distinct.
// Sources and scope are recorded in docs/ty2026-four-income-rules.md.
const assert = require('node:assert/strict');
const test = require('node:test');
const { harness } = require('./helpers/pension-harness.cjs');
const load = harness({ mockCompleteness: true }).load;
const { section4ABRatePercent, divisionITaxForIncome, divisionIClause1Tax, calculateTaxEstimate } = load('lib/tax/tax-calculation.ts');
const { buildExpectedIrisTotals } = load('lib/tax/business-iris-expectations.ts');
for (const salary of [0, 1, 9000000, 9000001]) test(`salary-head ${salary}: separate surcharge eligibility from 75% slab selection`, () => {
  const taxable = 12000000;
  assert.equal(section4ABRatePercent({salaryHeadIncome:salary,taxableIncome:taxable}), salary > 0 ? 9 : 10);
  if (salary <= 9000000) assert.equal(divisionITaxForIncome({salaryHeadIncome:salary,taxableIncome:taxable}), divisionIClause1Tax(taxable));
});
test('combined calculator and portal expectations agree for minority salary income', () => {
  const estimate = calculateTaxEstimate({taxYear:2026,filerStatus:'ATL',totalIncome:12000000,totalExpenses:0,taxWithheld:0,isSalariedRoute:true,isBankProfitRoute:false,incomeSources:[{route:'salary',income:7000000},{route:'business_profit',income:5000000}]});
  assert.equal(estimate.status, 'ESTIMATE');
  const combined = estimate.breakdown.find(x=>x.route==='combined_slab');
  assert.equal(combined.baseTax,4490000);
  assert.equal(combined.surcharge,404100);
  const expected = buildExpectedIrisTotals({incomeSources:['salary','business'],fields:[{irisCode:'3009',column:'Total Amount',section:'Manufacturing/ Trading Items',ourAmount:5000000}],assetCodes:[],liabilityCodes:[],companionNormalIncome:{normalTaxableIncome:7000000,salaryHeadIncome:7000000}});
  assert.equal(expected.computations.expectedNormalTax,combined.baseTax);
  assert.equal(expected.computations.surcharge.value,combined.surcharge);
  assert.match(expected.rows.find(r=>r.code==='920000').formula,/clause \(1\)/i,'9% surcharge must not switch the slab to clause (2)');
});
