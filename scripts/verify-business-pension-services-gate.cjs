"use strict";
/**
 * Route 7 — Business + Pension + Services (no Salary): the SOURCE-SET gate.
 *
 * Before 11-Nov-2026 this set was blocked on both sides. This suite pins the
 * opened gate and, just as importantly, pins that opening the gate types
 * nothing: `exact` may be true, but `active` must stay false until the
 * `business-pension-services-v1` computations envelope exists.
 *
 * It loads the *production* server gate and the *production* Electron resolver,
 * exactly like verify-salary-pension-services-route.cjs does.
 *
 * Run: node scripts/verify-business-pension-services-gate.cjs
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
const {
  isSingleFreelancerServicesFiling,
  isFreelancerIncomeSelected,
  isBusinessPensionServicesSourceSet,
} = require("../lib/tax/business-bank-categories.ts");
Module._resolveFilename = originalResolveFilename;

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
  ],
};
const snapshot = (incomeSources, { filing = {}, ...overrides } = {}) => ({
  filing: { taxYear: 2026, filerType: "myself", incomeSources, ...filing },
  business: servicesPayload,
  services: null,
  ...overrides,
});
const withEnvelope = (extra = {}) => ({
  businessPensionServices: {
    version: "business-pension-services-v1",
    computations: { version: "computations-v1" },
    ...extra,
  },
});

/* ---------------------------------------------------------------- server --- */

test("server gate accepts exactly Business + Pension + Services in any order", () => {
  for (const sources of [
    ["business", "pension", "services"],
    ["services", "business", "pension"],
    ["pension", "services", "business"],
  ]) {
    assert.equal(isBusinessPensionServicesSourceSet(sources), true, sources.join(" + "));
    assert.equal(isFreelancerIncomeSelected({ incomeSources: sources }), true, sources.join(" + "));
    assert.equal(
      isSingleFreelancerServicesFiling({ taxYear: 2026, filerType: "myself", incomeSources: sources }),
      true,
    );
  }
});

test("the six sets that already worked keep working", () => {
  for (const sources of [
    ["services"],
    ["salary", "services"],
    ["business", "services"],
    ["pension", "services"],
    ["salary", "business", "services"],
    ["salary", "pension", "services"],
  ]) {
    assert.equal(isFreelancerIncomeSelected({ incomeSources: sources }), true, sources.join(" + "));
  }
});

test("everything else still fails closed", () => {
  // The four-income set (Salary + Business + Pension + Services) is TY2026
  // Myself-only and opened 16-Nov-2026; see verify-four-income-route.cjs.
  assert.equal(
    isFreelancerIncomeSelected({ incomeSources: ["salary", "business", "pension", "services"] }),
    true,
  );
  for (const sources of [
    ["business", "pension"],
    ["salary", "business", "pension"],
    ["business", "pension", "services", "services"],
    ["services", "services"],
    [],
  ]) {
    assert.equal(
      isFreelancerIncomeSelected({ incomeSources: sources }),
      false,
      sources.join(" + ") || "empty",
    );
  }
  assert.equal(
    isBusinessPensionServicesSourceSet(["business", "pension", "services", "services"]),
    false,
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2025,
      filerType: "myself",
      incomeSources: ["business", "pension", "services"],
    }),
    false,
    "TY2026 only",
  );
  assert.equal(
    isSingleFreelancerServicesFiling({
      taxYear: 2026,
      filerType: "my_business",
      incomeSources: ["business", "pension", "services"],
    }),
    false,
    "Myself only",
  );
});

/* -------------------------------------------------------------- electron --- */

test("Electron: the route is exact, but NOT active without its envelope", () => {
  const route = main.getServicesPacketRoute(snapshot(["business", "pension", "services"]));
  assert.equal(route.selected, true);
  assert.equal(route.exact, true);
  assert.equal(route.payloadValid, false, "no envelope yet, so the payload cannot be approved");
  assert.equal(route.active, false);
  assert.equal(route.salaryIncluded, false);
  assert.equal(route.pensionIncluded, true);
  assert.equal(route.businessIncluded, true);
});

test("Electron: activates once the versioned computations envelope is present", () => {
  const route = main.getServicesPacketRoute(
    snapshot(["business", "pension", "services"], withEnvelope()),
  );
  assert.equal(route.exact, true);
  assert.equal(route.payloadValid, true);
  assert.equal(route.active, true);
  assert.equal(route.pensionIncluded, true);
  assert.equal(route.businessIncluded, true);
  assert.equal(route.salaryIncluded, false);
});

test("Electron: a stale or incomplete envelope keeps the route asleep", () => {
  for (const broken of [
    withEnvelope({ version: "business-pension-services-v0" }),
    withEnvelope({ computations: undefined }),
    withEnvelope({ computations: { version: "computations-v0" } }),
  ]) {
    const route = main.getServicesPacketRoute(
      snapshot(["business", "pension", "services"], broken),
    );
    assert.equal(route.active, false, JSON.stringify(broken));
  }
});

test("Electron: TY2025, my_business, a missing Services payload and the quadruple stay inactive", () => {
  for (const bad of [
    snapshot(["business", "pension", "services"], { ...withEnvelope(), filing: { taxYear: 2025 } }),
    snapshot(["business", "pension", "services"], { ...withEnvelope(), filing: { filerType: "my_business" } }),
    snapshot(["salary", "business", "pension", "services"], withEnvelope()),
    { ...snapshot(["business", "pension", "services"], withEnvelope()), business: null },
  ]) {
    assert.equal(main.getServicesPacketRoute(bad).active, false);
  }
});

test("the gate text, the wizard text and the Computations allowlist all know the new set", () => {
  assert.match(
    fs.readFileSync(path.join(root, "lib/tax/business-bank-categories.ts"), "utf8"),
    /exactly Business \+ Pension \+ Services/,
  );
  assert.match(
    fs.readFileSync(path.join(root, "components/tax/filing/filing-wizard.tsx"), "utf8"),
    /Business \+ Pension \+ Services/,
  );
  assert.match(mainSource, /snapshot\.businessPensionServices\?\.computations\?\.version/);
});

test("P2 section allowlist: Employment, Business tabs and Computations all open for this set", () => {
  // servicesHasCompanionSource must count pension as a companion (there is no
  // salary in this route), and the Employment grid must come from
  // pensionIncluded rather than salaryIncluded.
  assert.match(
    mainSource,
    /const servicesHasCompanionSource =\s*\n?\s*servicesRoute\.salaryIncluded \|\| servicesRoute\.pensionIncluded;/,
    "the companion-source test must stay salaryIncluded || pensionIncluded",
  );
  assert.match(
    mainSource,
    /^[ \t]*\["salary", "tax_deductions",/m,
    "the Employment tab (1008 pension rows) must be allowed whenever a companion source exists",
  );
  assert.match(
    mainSource,
    /servicesRoute\.businessIncluded\s*\n?\s*\? \[/,
    "Business tabs must be allowed whenever business is a companion source",
  );
  assert.match(
    mainSource,
    /servicesRoute\.pensionIncluded \|\| snapshot\.salaryBusinessServices\?\.computations\?\.version === "computations-v1" \|\| snapshot\.businessPensionServices\?\.computations\?\.version === "computations-v1"/,
    "the Computations tab must open for this route's own envelope",
  );
});
