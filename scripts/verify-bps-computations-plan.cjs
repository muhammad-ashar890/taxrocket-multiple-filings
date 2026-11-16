"use strict";

/**
 * Route 7 — Business + Pension + Services: does the DESKTOP pick up the plan?
 *
 * `verify-business-pension-services-envelope.cjs` pins what the server builds.
 * This suite pins the other half of the hand-off: the production
 * `resolveAutofillComputationsPlan()` in electron-connect/main.js must hand the
 * envelope's own `computations` plan to the Computations driver.
 *
 * Why it exists: until 11-Nov-2026 that resolver had no branch for
 * `snapshot.businessPensionServices`, so a fully valid triple ran with
 * `computationsPlan === null`. `runRealIrisAutofill` then skipped the
 * Computations tab with no message at all — row 923184 was neither typed nor
 * checked against IRIS's own base, while every suite stayed green, because no
 * suite asked this resolver about this route.
 *
 * Run: node scripts/verify-bps-computations-plan.cjs
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
const { buildBusinessPensionServicesPlan } = require("../lib/tax/business-pension-services-plan.ts");
const { buildExpectedIrisTotals } = require("../lib/tax/business-iris-expectations.ts");
Module._resolveFilename = originalResolveFilename;

/* ---------------------------------------------- the production resolver --- */

const mainSource = fs.readFileSync(path.join(root, "electron-connect/main.js"), "utf8");
const mainAst = ts.createSourceFile("main.js", mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = mainAst.statements.find(
  (node) =>
    ts.isFunctionDeclaration(node) &&
    node.name?.text === "resolveAutofillComputationsPlan",
);
assert.ok(declaration, "electron-connect/main.js still declares resolveAutofillComputationsPlan");
const context = vm.createContext({ console });
vm.runInContext(declaration.getText(mainAst), context);
const resolve = context.resolveAutofillComputationsPlan;

/* ------------------------------- the real envelope, from the real builder --- */

const businessField = (irisCode, ourAmount, section) => ({
  irisCode,
  ourAmount,
  section,
  column: "Total Amount",
});
const businessFields = [
  businessField("3009", 20_000_000, "Manufacturing/ Trading Items"),
  businessField("3039", 5_000_000, "Manufacturing/ Trading Items"),
];
const servicesFields = (total, final) => [
  {
    irisCode: "3101",
    column: "Total Amount",
    ourAmount: total,
    section: "Other Revenues",
    servicesMappingKind: "SERVICES_INCOME",
  },
  {
    irisCode: "3101",
    column: "Subject to Final Tax",
    ourAmount: final,
    section: "Other Revenues",
    servicesMappingKind: "SERVICES_INCOME",
  },
];
/** P-A of the TY2026 BP+S pack: exempt pension 9,000,000, 154A services 1,800,000. */
const realEnvelope = buildBusinessPensionServicesPlan({
  taxYear: 2026,
  filerType: "myself",
  incomeSources: ["business", "pension", "services"],
  businessExpectedIrisTotals: buildExpectedIrisTotals({
    fields: businessFields,
    incomeSources: ["business", "pension", "services"],
    assetCodes: [],
    liabilityCodes: [],
    companionNormalIncome: {
      normalTaxableIncome: 0,
      salaryHeadIncome: 0,
      finalPensionSurcharge: 0,
    },
  }),
  servicesFields: servicesFields(1_800_000, 1_800_000),
  hasUnmappedPortalIncome: false,
  pension: { treatment: "exempt", annualPension: 9_000_000, surcharge: null },
});
assert.ok(realEnvelope, "the P-A envelope must exist for this route");

/* ------------------------------------------------------- snapshot shapes --- */

const plan = (marker) => ({ version: "computations-v1", marker });
const businessPacket = (overrides = {}) => ({
  version: "business-entry-v9",
  fields: [{ irisCode: "3009", ourAmount: 20_000_000 }],
  expectedIrisTotals: { computations: plan("business-packet") },
  ...overrides,
});
const route7Snapshot = (overrides = {}) => ({
  businessPensionServices: realEnvelope,
  business: businessPacket(),
  services: { version: "services-tax-deduction-v1", fields: [{ irisCode: "3101" }] },
  ...overrides,
});

/* ------------------------------------------------------------- the tests --- */

test("Route 7 hands the envelope's own plan to the Computations driver", () => {
  const selected = resolve(route7Snapshot(), true);
  assert.ok(selected, "a valid Business + Pension + Services run must not run without a plan");
  assert.equal(
    selected,
    realEnvelope.computations,
    "the plan must be the envelope's own object, not a copy or another route's",
  );
  // The figure this fix exists for: row 923184 on the P-A pack.
  assert.equal(selected.surcharge.code, "923184");
  assert.equal(selected.surcharge.action, "TYPE");
  assert.equal(selected.surcharge.value, realEnvelope.surcharge.value);
  assert.equal(selected.surcharge.value, 584_000, "10% of Normal Tax 5,840,000, no salary head");
  assert.equal(selected.surcharge.ratePercent, 10);
  assert.equal(realEnvelope.surcharge.owner, "envelope");
});

test("Route 7 fails closed when the envelope or its plan is absent or stale", () => {
  assert.equal(resolve(route7Snapshot({ businessPensionServices: null }), true), null);
  assert.equal(resolve(route7Snapshot({ businessPensionServices: undefined }), true), null);
  assert.equal(
    resolve(
      route7Snapshot({
        businessPensionServices: { ...realEnvelope, version: "business-pension-services-v0" },
      }),
      true,
    ),
    null,
    "a stale envelope version must never activate the route's plan",
  );
  assert.equal(
    resolve(
      route7Snapshot({
        businessPensionServices: {
          ...realEnvelope,
          computations: { version: "computations-v0" },
        },
      }),
      true,
    ),
    null,
    "an envelope without its computations-v1 plan must stay closed",
  );
});

test("Route 7 never borrows another route's plan", () => {
  const selected = resolve(route7Snapshot(), true);
  assert.notEqual(selected.marker, "business-packet");
  assert.notEqual(selected.marker, "non-business");
  // Route 6 (Business + Services, no pension) has no envelope and still gets
  // nothing: this fix does not widen any other route.
  assert.equal(resolve({ business: businessPacket(), services: {} }, true), null);
});

test("the other routes keep exactly the plan they had", () => {
  // Route 5: Salary + Business + Services keeps its own envelope.
  const salBusSvc = plan("sal-biz-svc");
  assert.equal(
    resolve(
      {
        salaryBusinessServices: { version: "salary-business-services-v1", computations: salBusSvc },
        business: businessPacket(),
      },
      true,
    ),
    salBusSvc,
  );
  // Route 4: Business + Pension (no Services) keeps the Business packet's plan.
  assert.equal(
    resolve({ business: businessPacket() }, false).marker,
    "business-packet",
  );
  // Business only on an older packet keeps the generic non-business plan.
  assert.equal(
    resolve({ business: { version: "business-entry-v8" }, computations: plan("non-business") }, false)
      .marker,
    "non-business",
  );
  // A v9 Business packet on a Services route with no envelope still inherits nothing.
  assert.equal(resolve({ business: { version: "business-entry-v9" } }, true), null);
});
