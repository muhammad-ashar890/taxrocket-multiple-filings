"use strict";
/**
 * Four-income route — Salary + Business + Pension + Services (TY2026, Myself):
 * the desktop SOURCE-SET gate.
 *
 * Opening this gate types nothing by itself. `exact` may be true, but `active`
 * stays false until the packet carries the `four-income-v1` envelope matching
 * the filing's own calculation revision AND the Business computations plan in
 * `business.expectedIrisTotals.computations` (fully typed, no turnover row,
 * no super-tax TYPE). Mirrors verify-business-pension-services-gate.cjs.
 *
 * Run: node scripts/verify-four-income-route.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
const mainAst = ts.createSourceFile("main.js", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function functionSource(name) {
  const found = mainAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(found, `main.js function ${name} exists`);
  return found.getText(mainAst);
}
function loadMain(names) {
  const context = vm.createContext({ console, Date, Promise });
  for (const name of names) vm.runInContext(functionSource(name), context);
  return context;
}
const main = loadMain(["getServicesPacketRoute"]);

const servicesPayload = {
  version: "services-tax-deduction-v1",
  route: "services_tax_deduction",
  coverage: "services_tax_deduction_only",
  taxYear: 2026,
  fields: [
    { irisCode: "3101", column: "Total Amount", ourAmount: 1_800_000, section: "Other Revenues" },
    { irisCode: "3101", column: "Subject to Final Tax", ourAmount: 1_800_000, section: "Other Revenues" },
  ],
};
const computations = {
  version: "computations-v1",
  expectedTaxableIncome: 15_500_000,
  expectedNormalTax: 4_606_000,
  expectedBusinessIncome: 2_500_000,
  surcharge: { code: "923184", action: "TYPE", value: 424_540, ratePercent: 9 },
  superTax: { code: "9231822", action: "NONE", value: 0, ratePercent: 0 },
};
const businessPayload = {
  version: "business-entry-v9",
  fields: [{ irisCode: "3009", section: "Manufacturing/ Trading Items", column: "Total Amount", ourAmount: 2_000_000 }],
  expectedIrisTotals: { version: "iris-expect-v1", computations },
};
const revision = "rev-four-income-gate-1";
const fourIncome = {
  version: "four-income-v1",
  route: "salary_business_pension_services",
  rulesVersion: "ty2026-salary-head-proviso-v1",
  taxYear: 2026,
  incomeSources: ["business", "pension", "salary", "services"],
  calculationRevision: revision,
  liability: { totalTax: 5_150_540 },
};
const snapshot = (incomeSources, { filing = {}, ...overrides } = {}) => ({
  filing: { taxYear: 2026, filerType: "myself", incomeSources, taxCalculationRevision: revision, ...filing },
  business: businessPayload,
  services: servicesPayload,
  ...overrides,
});
const withFourIncome = (extra = {}) => ({ fourIncome: { ...fourIncome, ...extra } });

/* -------------------------------------------------------------- server --- */

const {
  isFourIncomeSourceSet,
  isFourIncomeFiling,
  isFreelancerIncomeSelected,
  isSingleFreelancerServicesFiling,
} = (() => {
  const tsrequire = require("typescript");
  const Module = require("node:module");
  const rootDir = path.join(__dirname, "..");
  const previous = Module._extensions[".ts"];
  Module._extensions[".ts"] = function loadTs(module, filename) {
    const output = tsrequire.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: tsrequire.ModuleKind.CommonJS, target: tsrequire.ScriptTarget.ES2020, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
  const categories = require(path.join(rootDir, "lib/tax/business-bank-categories.ts"));
  const sourceSet = require(path.join(rootDir, "lib/tax/four-income-source-set.ts"));
  Module._extensions[".ts"] = previous;
  return { ...categories, isFourIncomeSourceSet: sourceSet.isFourIncomeSourceSet };
})();

test("server: the quadruple is exact for TY2026 Myself in any order", () => {
  for (const sources of [
    ["business", "pension", "salary", "services"],
    ["salary", "business", "pension", "services"],
    ["services", "salary", "business", "pension"],
  ]) {
    assert.equal(isFourIncomeSourceSet(sources), true, sources.join("+"));
    assert.equal(isFourIncomeFiling({ taxYear: 2026, filerType: "myself", incomeSources: sources }), true);
    assert.equal(isFreelancerIncomeSelected({ incomeSources: sources }), true);
    assert.equal(isSingleFreelancerServicesFiling({ taxYear: 2026, filerType: "myself", incomeSources: sources }), true);
  }
  for (const bad of [
    { taxYear: 2025, filerType: "myself" },
    { taxYear: 2026, filerType: "my_business" },
  ]) {
    assert.equal(isFourIncomeFiling({ ...bad, incomeSources: fourIncome.incomeSources }), false);
  }
  assert.equal(isFourIncomeSourceSet(["business", "pension", "salary", "services", "dividend"]), false);
  assert.equal(isFourIncomeSourceSet(["salary", "services"]), false);
});

/* ------------------------------------------------------------ electron --- */

test("Electron: exact, but INACTIVE without the envelope", () => {
  const route = main.getServicesPacketRoute(snapshot(["business", "pension", "salary", "services"]));
  assert.equal(route.selected, true);
  assert.equal(route.exact, true);
  assert.equal(route.payloadValid, false, "no four-income-v1 envelope, so the payload cannot be approved");
  assert.equal(route.active, false);
  assert.equal(route.salaryIncluded, true);
  assert.equal(route.pensionIncluded, true);
  assert.equal(route.businessIncluded, true);
});

test("Electron: activates only with envelope + fully typed Business plan", () => {
  const route = main.getServicesPacketRoute(
    snapshot(["business", "pension", "salary", "services"], withFourIncome()),
  );
  assert.equal(route.exact, true);
  assert.equal(route.payloadValid, true);
  assert.equal(route.active, true);
  assert.equal(route.salaryIncluded, true);
  assert.equal(route.pensionIncluded, true);
  assert.equal(route.businessIncluded, true);
});

test("Electron: every stale or tampered part of the contract keeps the route asleep", () => {
  const cases = [
    withFourIncome({ version: "four-income-v0" }),
    withFourIncome({ route: "salary_pension_business_services" }),
    withFourIncome({ calculationRevision: "rev-stale" }),
    withFourIncome({ liability: undefined }),
    {
      ...withFourIncome(),
      business: {
        ...businessPayload,
        expectedIrisTotals: { version: "iris-expect-v1", computations: undefined },
      },
    },
    {
      ...withFourIncome(),
      business: {
        ...businessPayload,
        expectedIrisTotals: {
          version: "iris-expect-v1",
          computations: { ...computations, turnover: 200_000_000 },
        },
      },
    },
    {
      ...withFourIncome(),
      business: {
        ...businessPayload,
        expectedIrisTotals: {
          version: "iris-expect-v1",
          computations: { ...computations, superTax: { code: "9231822", action: "TYPE", value: 1, ratePercent: 1 } },
        },
      },
    },
    { services: null },
    { services: { ...servicesPayload, fields: [] } },
    { filing: { taxYear: 2025 } },
    { filing: { filerType: "my_business" } },
    { filing: { taxCalculationRevision: undefined } },
  ];
  for (const overrides of cases) {
    const route = main.getServicesPacketRoute(
      snapshot(["business", "pension", "salary", "services"], overrides),
    );
    assert.equal(route.active, false, JSON.stringify(overrides));
  }
});

test("Electron: other source sets are unaffected", () => {
  const triple = main.getServicesPacketRoute(
    snapshot(["business", "pension", "services"]),
  );
  assert.equal(triple.exact, true, "Route 7 keeps its own gate");
  assert.equal(triple.active, false, "no envelope, still asleep");
  const mixed = main.getServicesPacketRoute(
    snapshot(["business", "pension", "salary"]),
  );
  assert.equal(mixed.exact, false);
  assert.equal(mixed.active, false);
});

test("the four-income gate and the wizard/gate strings are in lockstep", () => {
  assert.match(mainSource, /four-income-v1/);
  assert.match(mainSource, /"salary_business_pension_services"/);
  assert.match(mainSource, /fourIncomeBusinessComputations/);
  assert.match(mainSource, /four_income/);
});
