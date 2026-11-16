"use strict";
/**
 * Route 7 — Business + Pension + Services (no Salary): the PACKET ENVELOPE.
 *
 * `verify-business-pension-services-gate.cjs` pins that opening the source-set
 * gate types nothing. This suite pins the other half: the
 * `business-pension-services-v1` envelope that makes the desktop resolver
 * activate, what it folds, and — the important part — everything it refuses.
 *
 * The fixtures are built by the PRODUCTION Business expectations builder
 * (`buildExpectedIrisTotals`), so the envelope is tested against the same
 * `computations-v1` plan the packet ships, never a hand-written stand-in.
 *
 * Run: node scripts/verify-business-pension-services-envelope.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveWithAlias(request, ...rest) {
  if (request.startsWith("@/")) request = path.join(root, request.slice(2));
  return originalResolveFilename.call(this, request, ...rest);
};
Module._extensions[".ts"] = function loadTypeScript(module, filename) {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    fileName: filename,
  }).outputText;
  module._compile(output, filename);
};
const { buildBusinessPensionServicesPlan } =
  require("../lib/tax/business-pension-services-plan.ts");
const { buildExpectedIrisTotals } = require("../lib/tax/business-iris-expectations.ts");
const { isBusinessPensionServicesFiling, isSingleFreelancerServicesFiling } =
  require("../lib/tax/business-bank-categories.ts");
Module._resolveFilename = originalResolveFilename;

/* ------------------------------------------------------------ fixtures --- */

const TRADING = "Manufacturing/ Trading Items";
const ADMIN = "Admin, Selling & Financial Expenses";

const businessField = (irisCode, ourAmount, section) => ({
  irisCode,
  ourAmount,
  section,
  column: "Total Amount",
});

/** Business profit 15,000,000: revenue 20,000,000 - cost 5,000,000 - admin 0. */
const businessFields = [
  businessField("3009", 20_000_000, TRADING),
  businessField("3039", 5_000_000, TRADING),
];

const servicesFields = (total, final) => {
  const rows = [];
  if (total > 0) {
    rows.push({
      irisCode: "3101",
      column: "Total Amount",
      ourAmount: total,
      section: "Other Revenues",
      servicesMappingKind: "SERVICES_INCOME",
    });
  }
  if (final > 0) {
    rows.push({
      irisCode: "3101",
      column: "Subject to Final Tax",
      ourAmount: final,
      section: "Other Revenues",
      servicesMappingKind: "SERVICES_INCOME",
    });
  }
  return rows;
};

/** The pension fold exactly as packet.ts hands it over. */
const companion = ({ normalIncome = 0, finalPensionSurcharge = 0 } = {}) => ({
  normalTaxableIncome: normalIncome,
  salaryHeadIncome: normalIncome,
  finalPensionSurcharge,
});

const businessTotals = (companionNormalIncome) =>
  buildExpectedIrisTotals({
    fields: businessFields,
    incomeSources: ["business", "pension", "services"],
    assetCodes: [],
    liabilityCodes: [],
    companionNormalIncome,
  });

const plan = (overrides = {}) =>
  buildBusinessPensionServicesPlan({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business", "pension", "services"],
    businessExpectedIrisTotals: businessTotals(companion()),
    servicesFields: servicesFields(1_800_000, 1_800_000),
    hasUnmappedPortalIncome: false,
    pension: { treatment: "exempt", annualPension: 9_000_000, surcharge: null },
    ...overrides,
  });

const rowOf = (totals, code, column = "total") =>
  totals.rows.find((row) => row.code === code && row.column === column);

/* ------------------------------------------------------------ the fold --- */

test("P-A exempt pension: the envelope prices only the business slab", () => {
  const built = plan();
  assert.ok(built, "the envelope must exist for a provable exempt-pension return");
  assert.equal(built.version, "business-pension-services-v1");
  assert.equal(built.computations.version, "computations-v1");
  assert.equal(built.expectedTaxableIncome, 15_000_000);
  assert.equal(built.pension.exemptIncome, 9_000_000);
  assert.equal(built.pension.normalIncome, 0);
  assert.equal(built.pension.finalTaxableIncome, 0);
  assert.equal(built.surcharge.ratePercent, 10, "no salary head => 10%, never 9%");
  assert.equal(
    built.surcharge.normalTaxPart,
    Math.round((built.expectedNormalTax * 10) / 100),
  );
  assert.equal(built.surcharge.pensionPart, 0);
  assert.equal(built.surcharge.owner, "envelope");
  assert.equal(built.computations.surcharge.action, "TYPE");
  assert.equal(built.computations.surcharge.value, built.surcharge.value);
});

test("P-A folds the Services revenue into the Total Income column only", () => {
  const built = plan();
  const totals = built.expectedIrisTotals;
  assert.equal(rowOf(totals, "3129").expected, 1_800_000);
  assert.equal(
    rowOf(totals, "3200").expected,
    16_800_000,
    "Other Revenues 3129 joins the accounting profit 3200",
  );
  assert.equal(
    rowOf(totals, "3000").expected,
    16_800_000,
    "3000 tracks 3200; it may not disagree with the profit it folds",
  );
  assert.equal(
    rowOf(totals, "9100", "normal").expected,
    15_000_000,
    "154A final-tax Services revenue never joins Taxable Income",
  );
});

test("P-B final_above_10m: the field map owns the combined row (11-Nov-2026)", () => {
  const built = plan({
    businessExpectedIrisTotals: businessTotals(
      companion({ finalPensionSurcharge: 100_000 }),
    ),
    pension: { treatment: "final_above_10m", annualPension: 12_000_000, surcharge: 100_000 },
  });
  assert.ok(built);
  assert.equal(built.pension.exemptIncome, 10_000_000);
  assert.equal(built.pension.finalTaxableIncome, 2_000_000);
  assert.equal(built.pension.normalIncome, 0);
  assert.equal(built.surcharge.pensionPart, 100_000);
  assert.equal(
    built.surcharge.owner,
    "field_map",
    "both halves are typed as one figure by the packet's field map",
  );
  assert.equal(built.computations.surcharge.action, "TYPE");
  assert.equal(built.computations.surcharge.alreadyHandledInFieldMap, true);
  assert.equal(built.computations.surcharge.fieldMapCombinedValue, built.surcharge.value);
  assert.equal(
    built.surcharge.value,
    built.surcharge.normalTaxPart + 100_000,
    "row 923184 is the pension half plus the normal-slab half",
  );
  assert.match(built.computations.surcharge.basis, /100,000/);
  assert.ok(
    built.notes.some((note) => /923184/.test(note)),
    "the report must say what the combined row is",
  );
  assert.equal(
    built.computations.surcharge.value,
    built.surcharge.normalTaxPart,
    "normal component is retained for verification; the handled flag prevents typing",
  );
  assert.match(
    built.computations.surcharge.message,
    /584,000|field map|Normal Tax/i,
    "the operator is told what the packet typed and what to confirm",
  );
  const publishedRow = built.expectedIrisTotals.rows.find((row) => row.code === "923184");
  assert.equal(
    publishedRow.expected,
    built.surcharge.value,
    "the read-back expectation is the whole row, so a half-typed 923184 can never read as MATCH",
  );
  assert.equal(publishedRow.proven, false);
});

test("pension taxed at the normal slabs joins Taxable Income and gets the Salary-head 9% proviso", () => {
  const built = plan({
    businessExpectedIrisTotals: businessTotals(companion({ normalIncome: 5_000_000 })),
    pension: { treatment: "salary", annualPension: 5_000_000, surcharge: null },
  });
  assert.ok(built);
  assert.equal(built.pension.normalIncome, 5_000_000);
  assert.equal(built.expectedTaxableIncome, 20_000_000);
  assert.equal(built.surcharge.ratePercent, 9, "normal-tax pension is Salary-head income even below the 75% slab test");
  assert.equal(built.surcharge.owner, "envelope");
});

test("the envelope recognises the real snapshot shape the desktop reads", () => {
  const built = plan();
  const snapshot = {
    filing: { taxYear: 2026, filerType: "myself", incomeSources: ["pension", "services", "business"] },
    business: {
      version: "services-tax-deduction-v1",
      route: "services_tax_deduction",
      coverage: "services_tax_deduction_only",
      taxYear: 2026,
      fields: [{ irisCode: "3101" }],
    },
    businessPensionServices: built,
  };
  assert.equal(snapshot.businessPensionServices.version, "business-pension-services-v1");
  assert.equal(snapshot.businessPensionServices.computations.version, "computations-v1");
});

/* ----------------------------------------------------------- refusals --- */

test("normal-tax Services revenue refuses the route instead of guessing 9100", () => {
  assert.equal(
    plan({ servicesFields: servicesFields(1_800_000, 0) }),
    null,
    "a Services rupee left inside Division I would have to be re-priced",
  );
});

test("unmapped portal income refuses the route", () => {
  assert.equal(plan({ hasUnmappedPortalIncome: true }), null);
});

test("an unknown pension answer refuses the route", () => {
  for (const treatment of ["unknown_age", null, "", "something_else"]) {
    assert.equal(
      plan({ pension: { treatment, annualPension: 9_000_000, surcharge: null } }),
      null,
      String(treatment),
    );
  }
});

test("a final-tax pension without its 5% figure refuses the route", () => {
  assert.equal(
    plan({
      businessExpectedIrisTotals: businessTotals(companion()),
      pension: { treatment: "final_above_10m", annualPension: 12_000_000, surcharge: 0 },
    }),
    null,
  );
});

test("a business packet without a combined Normal Tax refuses the route", () => {
  // No companion income => the multi-source income chain is skipped, so the
  // Business computations carry no 9100 / 920000 to stand on.
  const totals = businessTotals(null);
  assert.equal(totals.computations.expectedTaxableIncome, null);
  assert.equal(plan({ businessExpectedIrisTotals: totals }), null);
  assert.equal(
    plan({ businessExpectedIrisTotals: { ...totals, computations: undefined } }),
    null,
    "an envelope must never exist without its computations plan",
  );
});

test("the wrong source set, tax year or filer type still returns nothing", () => {
  for (const overrides of [
    { incomeSources: ["salary", "business", "pension"] },
    { incomeSources: ["business", "pension"] },
    { incomeSources: ["business", "pension", "services", "salary"] },
    { incomeSources: ["business", "pension", "services", "services"] },
    { taxYear: 2025 },
    { filerType: "my_business" },
  ]) {
    assert.equal(plan(overrides), null, JSON.stringify(overrides));
  }
});

test("the desktop resolver activates on the envelope this builder produces", () => {
  const mainSource = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
  const mainAst = ts.createSourceFile("main.js", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = mainAst.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "getServicesPacketRoute",
  );
  assert.ok(declaration, "electron-connect/main.js still declares getServicesPacketRoute");
  const context = vm.createContext({ console, Date, Promise });
  vm.runInContext(declaration.getText(mainAst), context);

  const snapshotWith = (envelope, incomeSources = ["business", "pension", "services"]) => ({
    filing: { taxYear: 2026, filerType: "myself", incomeSources },
    business: {
      version: "services-tax-deduction-v1",
      route: "services_tax_deduction",
      coverage: "services_tax_deduction_only",
      taxYear: 2026,
      fields: [{ irisCode: "3101" }],
    },
    ...(envelope ? { businessPensionServices: envelope } : {}),
  });

  const asleep = context.getServicesPacketRoute(snapshotWith(null));
  assert.equal(asleep.exact, true);
  assert.equal(asleep.payloadValid, false, "the gate alone types nothing");
  assert.equal(asleep.active, false);

  const live = context.getServicesPacketRoute(snapshotWith(plan()));
  assert.equal(live.exact, true);
  assert.equal(live.payloadValid, true);
  assert.equal(live.active, true, "the real envelope is what switches the route on");
  assert.equal(live.salaryIncluded, false);
  assert.equal(live.pensionIncluded, true);
  assert.equal(live.businessIncluded, true);

  // A plan for another route, or a stale one, must not switch it on.
  assert.equal(
    context.getServicesPacketRoute(
      snapshotWith({ ...plan(), version: "business-pension-services-v0" }),
    ).active,
    false,
  );
});

test("the route predicate and the services gate agree on this set", () => {
  assert.equal(
    isBusinessPensionServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["services", "business", "pension"],
    }),
    true,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "myself",
      incomeSources: ["services", "business", "pension"],
    }),
    true,
  );
});
