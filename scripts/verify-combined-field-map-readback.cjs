"use strict";
// Offline regression: actual TS builders, portal map, main.js resolver and driver.
// No database or browser is involved; IRIS rows below are synthetic snapshots.
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...rest) {
  return originalResolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
};
Module._extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, resolveJsonModule: true },
}).outputText, filename);
const { buildExpectedIrisTotals } = require("../lib/tax/business-iris-expectations.ts");
const { buildBusinessPensionServicesPlan } = require("../lib/tax/business-pension-services-plan.ts");
const { resolveFinalPensionAdditionalNormalSurcharge } = require("../lib/tax/non-business-computations-plan.ts");
const { buildPortalFieldMap } = require("../lib/tax/portal-field-map.ts");
const gates = require("../lib/tax/business-bank-categories.ts");
const driver = require("../electron-connect/iris-computations-driver.js");
const ast = ts.createSourceFile("main.js", fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const context = vm.createContext({});
for (const name of ["resolveAutofillComputationsPlan", "getServicesPacketRoute"]) {
  const fn = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(fn, name);
  vm.runInContext(fn.getText(ast), context);
}
const sources = ["business", "pension", "services"];
const fields = [
  { irisCode: "3101", column: "Total Amount", ourAmount: 1800000, section: "Other Revenues", servicesMappingKind: "SERVICES_INCOME" },
  { irisCode: "3101", column: "Subject to Final Tax", ourAmount: 1800000, section: "Other Revenues", servicesMappingKind: "SERVICES_INCOME" },
];
function fixture(profit = 15000000) {
  const totals = buildExpectedIrisTotals({ fields: [
    { irisCode: "3009", ourAmount: profit + 5000000, section: "Manufacturing/ Trading Items", column: "Total Amount" },
    { irisCode: "3039", ourAmount: 5000000, section: "Manufacturing/ Trading Items", column: "Total Amount" },
  ], incomeSources: sources, assetCodes: [], liabilityCodes: [], companionNormalIncome: { normalTaxableIncome: 0, salaryHeadIncome: 0, finalPensionSurcharge: 10000 } });
  const pension = { treatment: "final_above_10m", annualPension: 12000000, surcharge: 10000 };
  const envelope = buildBusinessPensionServicesPlan({ taxYear: 2026, filerType: "myself", incomeSources: sources, businessExpectedIrisTotals: totals, servicesFields: fields, hasUnmappedPortalIncome: false, pension });
  assert.ok(envelope);
  const snapshot = { filing: { taxYear: 2026, filerType: "myself", incomeSources: sources }, business: { version: "business-entry-v9", expectedIrisTotals: totals }, businessPensionServices: envelope };
  const plan = context.resolveAutofillComputationsPlan(snapshot, true);
  assert.equal(plan, envelope.computations);
  return { totals, envelope, snapshot, plan };
}
const high = fixture();
const cells = (total, normal) => [{ value: String(total ?? ""), editable: true }, {}, {}, { value: String(normal ?? ""), editable: false }];
function rows(plan = high.plan) {
  return [
    { code: "9100", cells: cells("", plan.expectedTaxableIncome) },
    { code: "920000", cells: cells("", plan.expectedNormalTax) },
    { code: "923184", cells: cells(plan.surcharge.fieldMapCombinedValue ?? 594000, 0) },
    { code: "9231822", cells: cells(0, 0) },
  ];
}
const decision = (rr = rows(), plan = high.plan) => driver.decideComputations(plan, rr).entries.find(x => x.code === "923184");
function changed(code, index, value, plan = high.plan) {
  const rr = rows(plan); rr.find(r => r.code === code).cells[index].value = value; return rr;
}
test("real field map publishes one combined cell and driver verifies it without typing", () => {
  const additional = resolveFinalPensionAdditionalNormalSurcharge({ incomeSources: sources, pensionTreatment: "final_above_10m", calculationLines: [], mappedServicesIncomePkr: 1800000, mappedFinalTaxServicesIncomePkr: 1800000, hasServicesIncomeGaps: false, hasUnmappedPortalIncome: false, businessExpectedComputations: high.totals.computations });
  const map = buildPortalFieldMap({ taxYear: 2026, filerType: "myself", taxpayerListStatus: "ATL", ledgerEntries: [], taxCredits: [], taxableIncome: 15000000, taxWithheld: 0, pensionSource: { version: "pension-source-v1", treatment: "final_above_10m", annualPension: 12000000, baseTax: 100000, surcharge: 10000, taxDeducted: 0, taxDue: 110000 }, additionalSection4ABSurcharge: additional, reconciliation: { netWorthStart: 0, netWorthEnd: 0, totalInflows: 0, totalOutflows: 0, unreconciledGap: 0, accountBalances: [], personalExpenses: 0 } });
  const mapped = map.adjustableTaxFields.filter(x => x.irisCode === "923184");
  assert.equal(mapped.length, 1); assert.equal(mapped[0].ourAmount, 594000);
  assert.equal(high.plan.surcharge.fieldMapCombinedValue, mapped[0].ourAmount);
  assert.equal(decision().decision, "leave");
  assert.equal(decision().reason, "combined_verified_in_field_map");
  const report = driver.describeComputationsOutcome({ results: [], messages: [], decisions: [decision()], iris: {}, reason: "ok" });
  assert.match(report, /verified/); assert.match(report, /594,000/);
});
for (const [label, value, reason] of [
  ["pension-only", "10000", "field_map_missing_normal_half"],
  ["wrong combined", "600000", "row_holds_other_figure"],
  ["blank", "", "field_map_cell_blank"],
  ["non numeric", "abc", "cell_not_an_amount"],
]) test(`combined readback refuses ${label}`, () => {
  const d = decision(changed("923184", 0, value));
  assert.equal(d.decision, "tell_user"); assert.equal(d.reason, reason);
});
test("missing, duplicate or missing-cell surcharge is held", () => {
  for (const [rr, reason] of [
    [rows().filter(r => r.code !== "923184"), "row_not_seen"],
    [[...rows(), rows().find(r => r.code === "923184")], "row_not_unique"],
    [rows().map(r => r.code === "923184" ? { ...r, cells: [] } : r), "cell_not_seen"],
  ]) { const d = decision(rr); assert.equal(d.decision, "tell_user"); assert.equal(d.reason, reason); }
});
test("each normal-tax base must be readable and match the approved plan", () => {
  for (const code of ["9100", "920000"]) for (const value of ["", "abc", "9999999"]) {
    assert.equal(decision(changed(code, 3, value)).decision, "tell_user", `${code}: ${value}`);
  }
});
test("below/at threshold still verifies BOTH bases, not just surcharge cell", () => {
  for (const taxable of [4000000, 10000000]) {
    const { plan } = fixture(taxable);
    assert.equal(plan.surcharge.action, "NONE");
    assert.equal(decision(rows(plan), plan).reason, "combined_verified_in_field_map");
    for (const code of ["9100", "920000"]) for (const value of ["", "abc", "123"]) {
      assert.equal(decision(changed(code, 3, value, plan), plan).decision, "tell_user", `${taxable} ${code} ${value}`);
    }
  }
});
test("inconsistent components and invalid rate fail closed", () => {
  for (const override of [{ pensionSurchargePart: 99999 }, { fieldMapCombinedValue: -1 }, { fieldMapCombinedValue: NaN }, { pensionSurchargePart: undefined }, { ratePercent: 8 }, { action: "USER" }, { alreadyHandledInFieldMap: false }]) {
    const plan = { ...high.plan, surcharge: { ...high.plan.surcharge, ...override } };
    assert.equal(decision(rows(), plan).decision, "tell_user", JSON.stringify(override));
  }
});
test("read-only verifier can confirm a matching non-editable cell", () => {
  const rr = rows(); rr.find(r => r.code === "923184").cells[0].editable = false;
  assert.equal(decision(rr).reason, "combined_verified_in_field_map");
});
test("four-income route stays envelope-gated: exact set alone never activates execution", () => {
  const incomeSources = ["salary", "business", "pension", "services"];
  assert.equal(gates.isSingleFreelancerServicesFiling({ taxYear: 2026, filerType: "myself", incomeSources }), true);
  const route = context.getServicesPacketRoute({ ...high.snapshot, filing: { ...high.snapshot.filing, incomeSources }, services: { version: "services-tax-deduction-v1", route: "services_tax_deduction", coverage: "services_tax_deduction_only", taxYear: 2026, fields } });
  assert.equal(route.exact, true);
  assert.equal(route.active, false, "a complete four-income-v1 + Business computations envelope is required; nothing activates on the source set alone");
});

test("fillComputations performs read-only verification and preserves the verified amount in its report", async () => {
  let fillCalls = 0;
  const options = { mode: "live", taxYear: 2026, sleep: async () => {},
    navigate: async () => ({ ok: true }), snapshot: async () => rows(),
    fill: async () => { fillCalls++; throw new Error("second write forbidden"); } };
  const outcome = await driver.fillComputations(null, high.plan, options);
  assert.equal(outcome.ok, true);
  assert.equal(fillCalls, 0);
  assert.equal(outcome.reason, "verified_read_only");
  assert.equal(outcome.results.length, 0);
  assert.equal(outcome.messages.length, 0);
  assert.match(driver.describeComputationsOutcome(outcome), /594,000/);
  const dry = await driver.fillComputations(null, high.plan, { mode: "dry" });
  assert.equal(dry.planned, 0, "field-map work must not count as planned computations typing");
});
test("navigation failure requests combined review, never typing the normal half", async () => {
  for (const f of [high, fixture(4000000)]) {
    const outcome = await driver.fillComputations(null, f.plan, { mode: "live", navigate: async () => ({ ok: false, status: "not_seen" }) });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.messages.length, 1);
    assert.match(outcome.messages[0], /could not be verified/);
    assert.doesNotMatch(outcome.messages[0], /please type .*yourself/);
  }
});
test("fillComputations never writes missing/wrong combined cells and holds a changed readback", async () => {
  for (const value of ["10000", "600000", "", "abc"]) {
    let fillCalls = 0, reads = 0;
    const outcome = await driver.fillComputations(null, high.plan, {
      mode: "live", sleep: async () => {}, navigate: async () => ({ ok: true }),
      snapshot: async () => ++reads === 1 ? rows() : changed("923184", 0, value),
      fill: async () => { fillCalls++; throw new Error("second write forbidden"); },
    });
    assert.equal(fillCalls, 0);
    assert.equal(outcome.ok, false, value);
    assert.equal(outcome.messages.length, 1);
    assert.doesNotMatch(driver.describeComputationsOutcome(outcome), /verified against/);
  }
});
