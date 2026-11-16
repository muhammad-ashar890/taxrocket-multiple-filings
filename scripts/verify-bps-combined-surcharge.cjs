"use strict";

/**
 * Route 7 (Business + Pension + Services) — the COMBINED Section 4AB surcharge.
 *
 * IRIS has one cell for it: row 923184. When the pension carries its own
 * final-tax surcharge (`final_above_10m`) the row is the sum of two halves:
 *
 *   pension final-tax surcharge (5% of the pension above PKR 10m, x 10%)
 * + rate x Normal Tax (920000) for the normal-slab income (9% or 10%)
 *
 * Until 11-Nov-2026 the packet published only the pension half — the field map
 * adds `additionalSection4ABSurcharge`, and the server resolver that produces
 * that second half refused any source set containing `services`. The whole row
 * was therefore left to the operator.
 *
 * Now both the server resolver (`lib/tax/non-business-computations-plan.ts`)
 * and its desktop mirror (`electron-connect/pension-guard.js`) admit `services`
 * — but only after the code path that has already proved every Services rupee
 * is section 154A final tax (outside Division I, so it cannot move 920000 or
 * 923184). This suite pins that agreement from both ends and fails if the two
 * copies of the rule drift apart.
 *
 * Run: node scripts/verify-bps-combined-surcharge.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

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
const { resolveFinalPensionAdditionalNormalSurcharge } =
  require("../lib/tax/non-business-computations-plan.ts");
const { buildBusinessPensionServicesPlan } =
  require("../lib/tax/business-pension-services-plan.ts");
const { buildExpectedIrisTotals } = require("../lib/tax/business-iris-expectations.ts");
Module._resolveFilename = originalResolveFilename;

const pensionGuard = require("../electron-connect/pension-guard.js");

/* ------------------------------------------------------------ fixtures --- */

/** The Business packet's own computations plan for this pack (profit 15,000,000). */
const businessComputations = (() => {
  const totals = buildExpectedIrisTotals({
    fields: [
      { irisCode: "3009", ourAmount: 20_000_000, section: "Manufacturing/ Trading Items", column: "Total Amount" },
      { irisCode: "3039", ourAmount: 5_000_000, section: "Manufacturing/ Trading Items", column: "Total Amount" },
    ],
    incomeSources: ["business", "pension", "services"],
    assetCodes: [],
    liabilityCodes: [],
    // P-B: the pension is final tax above PKR 10m, so nothing joins the slabs.
    companionNormalIncome: { normalTaxableIncome: 0, salaryHeadIncome: 0, finalPensionSurcharge: 10_000 },
  });
  return totals.computations;
})();

const BUSINESS_SURCHARGE = businessComputations.surcharge.value; // 584,000 = 10% x 5,840,000
const PENSION_SURCHARGE = 10_000; // 12,000,000 pension -> 2,000,000 @5% = 100,000 base tax, x10%
const COMBINED = BUSINESS_SURCHARGE + PENSION_SURCHARGE;

const resolveAdditional = (overrides = {}) =>
  resolveFinalPensionAdditionalNormalSurcharge({
    incomeSources: ["business", "pension", "services"],
    pensionTreatment: "final_above_10m",
    calculationLines: [],
    mappedServicesIncomePkr: 1_800_000,
    mappedFinalTaxServicesIncomePkr: 1_800_000,
    hasServicesIncomeGaps: false,
    hasUnmappedPortalIncome: false,
    businessExpectedComputations: businessComputations,
    ...overrides,
  });

/* ------------------------------------------- 1. the server resolver --------- */

test("the normal-slab half now survives the final-tax Services leg", () => {
  assert.equal(
    BUSINESS_SURCHARGE,
    584_000,
    "fixture must match the packet: 10% of Normal Tax 5,840,000",
  );
  assert.equal(resolveAdditional(), BUSINESS_SURCHARGE);
});

test("a single normal-regime Services rupee still refuses the sum", () => {
  assert.equal(
    resolveAdditional({
      mappedServicesIncomePkr: 1_800_000,
      mappedFinalTaxServicesIncomePkr: 1_799_999,
    }),
    0,
  );
  assert.equal(resolveAdditional({ mappedFinalTaxServicesIncomePkr: 0 }), 0);
});

test("an income gap, unmapped portal income or an unproven packet still refuses it", () => {
  assert.equal(resolveAdditional({ hasServicesIncomeGaps: true }), 0);
  assert.equal(resolveAdditional({ hasUnmappedPortalIncome: true }), 0);
  assert.equal(
    resolveAdditional({ businessExpectedComputations: null }),
    0,
    "no Business computations plan, no normal-slab half",
  );
  assert.equal(
    resolveAdditional({
      businessExpectedComputations: {
        ...businessComputations,
        surcharge: { ...businessComputations.surcharge, action: "USER", value: 0 },
      },
    }),
    0,
    "a row the Business packet did not price is never invented here",
  );
});

test("other pension treatments and source sets are untouched", () => {
  assert.equal(resolveAdditional({ pensionTreatment: "exempt" }), 0);
  assert.equal(resolveAdditional({ pensionTreatment: "salary" }), 0);
  assert.equal(resolveAdditional({ pensionTreatment: null }), 0);
  // A source outside the seven supported sets is still refused.
  assert.equal(
    resolveAdditional({ incomeSources: ["business", "pension", "services", "foreign"] }),
    0,
  );
});

/* ------------------------------------ 2. the envelope publishes one row ---- */

const P_B_SNAPSHOT = (() => {
  const totals = buildExpectedIrisTotals({
    fields: [
      { irisCode: "3009", ourAmount: 20_000_000, section: "Manufacturing/ Trading Items", column: "Total Amount" },
      { irisCode: "3039", ourAmount: 5_000_000, section: "Manufacturing/ Trading Items", column: "Total Amount" },
    ],
    incomeSources: ["business", "pension", "services"],
    assetCodes: [],
    liabilityCodes: [],
    companionNormalIncome: { normalTaxableIncome: 0, salaryHeadIncome: 0, finalPensionSurcharge: PENSION_SURCHARGE },
  });
  return buildBusinessPensionServicesPlan({
    taxYear: 2026,
    filerType: "myself",
    incomeSources: ["business", "pension", "services"],
    businessExpectedIrisTotals: totals,
    servicesFields: [
      { irisCode: "3101", column: "Total Amount", ourAmount: 1_800_000, section: "Other Revenues", servicesMappingKind: "SERVICES_INCOME" },
      { irisCode: "3101", column: "Subject to Final Tax", ourAmount: 1_800_000, section: "Other Revenues", servicesMappingKind: "SERVICES_INCOME" },
    ],
    hasUnmappedPortalIncome: false,
    pension: { treatment: "final_above_10m", annualPension: 12_000_000, surcharge: PENSION_SURCHARGE },
  });
})();

test("P-B: one owner, one figure — the field map types both halves", () => {
  assert.ok(P_B_SNAPSHOT, "the P-B envelope must exist");
  assert.equal(P_B_SNAPSHOT.surcharge.owner, "field_map");
  assert.equal(P_B_SNAPSHOT.surcharge.pensionPart, PENSION_SURCHARGE);
  assert.equal(P_B_SNAPSHOT.surcharge.value, COMBINED);
  // The plan itself types nothing, so two drivers can never write one cell.
  const planSurcharge = P_B_SNAPSHOT.computations.surcharge;
  assert.equal(planSurcharge.action, "TYPE");
  assert.equal(planSurcharge.value, BUSINESS_SURCHARGE);
  assert.equal(planSurcharge.alreadyHandledInFieldMap, true);
  assert.equal(planSurcharge.fieldMapCombinedValue, COMBINED);
  assert.equal(planSurcharge.pensionSurchargePart, PENSION_SURCHARGE);
  assert.match(planSurcharge.message, /594,000|584,000/);
  assert.match(planSurcharge.basis, /field map/);
  const row = P_B_SNAPSHOT.expectedIrisTotals.rows.find((r) => r.code === "923184");
  assert.equal(row.expected, COMBINED, "read-back expects the whole row, not half of it");
  assert.equal(row.proven, false);
});

/* ------------------------------ 3. the desktop guard agrees, end to end ---- */

const FINGERPRINT = "a".repeat(64);

/** The packet cells a P-B route-7 return carries, as the guard reads them. */
const guardSnapshot = ({ hint = BUSINESS_SURCHARGE, row = COMBINED } = {}) => ({
  filing: { taxYear: 2026, filerType: "myself", incomeSources: ["business", "pension", "services"] },
  pension: {
    version: "pension-source-v1",
    fingerprint: FINGERPRINT,
    treatment: "final_above_10m",
    annualPension: 12_000_000,
    baseTax: 100_000,
    surcharge: PENSION_SURCHARGE,
    taxDeducted: 0,
    taxDue: 110_000,
  },
  business: { expectedIrisTotals: { computations: businessComputations } },
  portalFieldMap: {
    computationHints: {
      pensionSourceFingerprint: FINGERPRINT,
      pensionTreatment: "final_above_10m",
      ...(hint === undefined ? {} : { normalSlabSurcharge: hint }),
    },
    incomeFields: [
      { irisCode: "1008", column: "Total Amount", value: 12_000_000, ourAmount: 12_000_000 },
      { irisCode: "1008", column: "Subject to Final Tax", value: 2_000_000, ourAmount: 2_000_000 },
      { irisCode: "1008", column: "Subject to Exemption", value: 10_000_000, ourAmount: 10_000_000 },
    ],
    adjustableTaxFields: [
      { irisCode: "64020007", column: "Taxable Amount", value: 2_000_000, ourAmount: 2_000_000 },
      { irisCode: "64020007", column: "Tax Deducted", value: 0, ourAmount: 0 },
      { irisCode: "923184", column: "Total Income", value: row, ourAmount: row },
    ],
  },
});

test("the desktop guard accepts the combined row the packet now types", () => {
  const hold = pensionGuard.pensionEntryHold(guardSnapshot());
  assert.equal(hold, null, hold ? String(hold.pauseMessage ?? hold.message) : "");
});

test("the guard still holds a half-typed or invented 923184", () => {
  const half = pensionGuard.pensionEntryHold(guardSnapshot({ row: PENSION_SURCHARGE }));
  assert.ok(half, "a pension-only row must never pass once the normal half is proven");
  assert.match(String(half.pauseMessage ?? half.message ?? ""), /923184|contract/i);

  const wrongHint = pensionGuard.pensionEntryHold(
    guardSnapshot({ hint: BUSINESS_SURCHARGE + 1_000 }),
  );
  assert.ok(wrongHint, "a hint that does not match the Business plan must hold");
});

/* ------------------------------------ 4. the two copies of the rule ------- */

test("server resolver and desktop guard keep one identical source whitelist", () => {
  const server = fs.readFileSync(
    path.join(root, "lib/tax/non-business-computations-plan.ts"),
    "utf8",
  );
  const desktop = fs.readFileSync(
    path.join(root, "electron-connect/pension-guard.js"),
    "utf8",
  );
  for (const [name, source] of [
    ["server", server],
    ["desktop", desktop],
  ]) {
    for (const leg of ["business", "salary", "pension", "services"]) {
      assert.ok(
        new RegExp(`s === "${leg}"`).test(source),
        `${name} whitelist is missing the ${leg} leg`,
      );
    }
  }
});
