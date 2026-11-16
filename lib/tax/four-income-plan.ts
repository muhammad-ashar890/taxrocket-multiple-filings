import type { ComputationsPlan, ExpectedIrisTotals } from "./business-iris-expectations";
import type { PortalFieldMapEntry } from "./portal-field-map";
import { divisionITaxForIncome, section4ABRatePercent } from "./tax-calculation";

/** Staged contract only: creating this object does NOT authorize desktop activation. */
export const FOUR_INCOME_PLAN_VERSION = "four-income-v1";
export const FOUR_INCOME_RULES_VERSION = "ty2026-salary-head-proviso-v1";
import { isFourIncomeSourceSet } from "./four-income-source-set";
export { isFourIncomeSourceSet } from "./four-income-source-set";

type Pension = {
  treatment: "exempt" | "exempt_age70" | "salary" | "final_above_10m";
  annualPension: number;
  baseTax: number | null;
  surcharge: number | null;
};
export type FourIncomePlan = {
  version: typeof FOUR_INCOME_PLAN_VERSION;
  rulesVersion: typeof FOUR_INCOME_RULES_VERSION;
  route: "salary_business_pension_services";
  taxYear: 2026;
  incomeSources: string[];
  calculationRevision: string;
  salaryGross: number;
  pension: Pension;
  services: { totalIncome: number; finalIncome: number; normalIncome: 0 };
  expectedTaxableIncome: number;
  expectedNormalTax: number;
  normalSurcharge: number;
  pensionSurcharge: number;
  combinedSurcharge: number;
  surchargeOwner: "field_map" | "computations";
  computations: ComputationsPlan;
  expectedIrisTotals: ExpectedIrisTotals;
};
export type FourIncomePlanResult = { ok: true; plan: FourIncomePlan } | { ok: false; reason: string };
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const same = (a: number, b: number) => Math.abs(a - b) <= 1;

/**
 * A new four-source contract, NOT a triple envelope renamed or a second tax
 * calculator. Cross-checks approved calculation + typed-field expectations.
 * Strict final-tax Services scope; never coerces missing evidence into zero.
 */
export function buildFourIncomePlan(input: {
  taxYear: number;
  filerType: string | null;
  incomeSources: unknown;
  calculationRevision: string | null;
  salaryGross: number | null;
  pension: Pension | null;
  servicesFields: readonly PortalFieldMapEntry[];
  hasUnmappedPortalIncome: boolean;
  /** Current revision's authoritative combined_slab line, not draft grand totals. */
  approvedNormalTax: { taxableIncome: number; normalTax: number; surcharge: number } | null;
  businessExpectedIrisTotals: ExpectedIrisTotals;
}): FourIncomePlanResult {
  const refuse = (reason: string): FourIncomePlanResult => ({ ok: false, reason });
  if (input.taxYear !== 2026 || input.filerType !== "myself" || !isFourIncomeSourceSet(input.incomeSources)) return refuse("unsupported_source_set");
  if (typeof input.calculationRevision !== "string" || !input.calculationRevision.trim()) return refuse("calculation_revision_missing");
  if (!amount(input.salaryGross) || input.salaryGross <= 0) return refuse("salary_evidence_missing");
  const pension = input.pension;
  if (!pension || !["exempt", "exempt_age70", "salary", "final_above_10m"].includes(pension.treatment) || !amount(pension.annualPension) || pension.annualPension <= 0) return refuse("pension_evidence_missing");
  let pensionSurcharge = 0;
  if (pension.treatment === "final_above_10m") {
    const base = Math.round(Math.max(0, pension.annualPension - 10000000) * 0.05);
    if (pension.annualPension <= 10000000 || !amount(pension.baseTax) || !amount(pension.surcharge) || !same(base, pension.baseTax) || !same(Math.round(base * 0.1), pension.surcharge)) return refuse("pension_components_inconsistent");
    pensionSurcharge = pension.surcharge;
  } else if (pension.treatment === "exempt" && pension.annualPension > 10000000) return refuse("pension_components_inconsistent");
  else if (pension.treatment !== "salary" && ((pension.baseTax ?? 0) !== 0 || (pension.surcharge ?? 0) !== 0)) return refuse("pension_components_inconsistent");
  if (input.hasUnmappedPortalIncome) return refuse("unmapped_portal_income");
  const serviceRows = input.servicesFields.filter(field => field.servicesMappingKind === "SERVICES_INCOME");
  if (serviceRows.some(field => !amount(field.ourAmount))) return refuse("services_amount_invalid");
  if (serviceRows.some(field => !["3101", "3128"].includes(field.irisCode) || field.section !== "Other Revenues" || field.portalArea !== "Business" || !["Total Amount", "Subject to Final Tax"].includes(field.column))) return refuse("services_mapping_unverified");
  const totals = serviceRows.filter(field => field.column === "Total Amount");
  const finals = serviceRows.filter(field => field.column === "Subject to Final Tax");
  if (!totals.length) return refuse("services_evidence_missing");
  const key = (field: PortalFieldMapEntry) => `${field.portalArea ?? ""}:${field.section}:${field.irisCode}`;
  const byCell = new Map<string, number>();
  for (const field of totals) {
    if (byCell.has(key(field))) return refuse("services_row_ambiguous");
    byCell.set(key(field), field.ourAmount);
  }
  const finalSeen = new Set<string>();
  for (const field of finals) {
    if (finalSeen.has(key(field)) || !byCell.has(key(field))) return refuse("services_row_ambiguous");
    finalSeen.add(key(field));
    if (field.ourAmount !== byCell.get(key(field))) return refuse("normal_or_mixed_services_not_supported");
  }
  if (finalSeen.size !== byCell.size) return refuse("normal_or_mixed_services_not_supported");
  const totalIncome = Math.round(totals.reduce((sum, field) => sum + field.ourAmount, 0));
  if (totalIncome <= 0) return refuse("services_evidence_missing");
  const approved = input.approvedNormalTax;
  const original = input.businessExpectedIrisTotals;
  const computations = original?.computations;
  if (!approved || !amount(approved.taxableIncome) || !amount(approved.normalTax) || !amount(approved.surcharge) || !computations || computations.version !== "computations-v1" || !amount(computations.expectedTaxableIncome) || !amount(computations.expectedNormalTax) || !amount(computations.expectedBusinessIncome)) return refuse("combined_calculation_missing");
  if (computations.turnover || computations.minimumTaxRegime !== undefined) return refuse("minimum_tax_not_supported");
  // Conservative upper-bound check: do not certify a mixed-source 4C base here.
  const upperBound = approved.taxableIncome + totalIncome + (pension.treatment === "salary" ? 0 : pension.annualPension);
  if (upperBound > 150000000 || computations.superTax.action !== "NONE") return refuse("super_tax_review_required");
  const salaryHead = input.salaryGross + (pension.treatment === "salary" ? pension.annualPension : 0);
  if (approved.taxableIncome < salaryHead) return refuse("combined_components_inconsistent");
  // Loss set-off needs its own verified component contract. Do not derive a
  // missing business figure as whatever remains after the salary component.
  if (!same(computations.expectedBusinessIncome + salaryHead, approved.taxableIncome)) return refuse("loss_or_component_review_required");
  for (const [code, expected] of [["9100", approved.taxableIncome], ["920000", approved.normalTax]] as const) {
    const matching = original.rows.filter(row => row.code === code && row.column === "normal");
    if (matching.length !== 1 || !same(matching[0].expected, expected)) return refuse("stale_or_inconsistent_calculation");
  }
  const calculated = divisionITaxForIncome({ taxableIncome: approved.taxableIncome, salaryHeadIncome: salaryHead });
  const rate = section4ABRatePercent({ taxableIncome: approved.taxableIncome, salaryHeadIncome: salaryHead });
  const surcharge = approved.taxableIncome > 10000000 ? Math.round(approved.normalTax * rate / 100) : 0;
  if (calculated === null || !same(Math.round(calculated), approved.normalTax) || !same(surcharge, approved.surcharge) || computations.expectedTaxableIncome !== approved.taxableIncome || !same(computations.expectedNormalTax, approved.normalTax) || !same(computations.surcharge.value, surcharge) || computations.surcharge.action !== (surcharge > 0 ? "TYPE" : "NONE") || computations.surcharge.ratePercent !== rate) return refuse("stale_or_inconsistent_calculation");
  const combined = surcharge + pensionSurcharge;
  if (pensionSurcharge > 0) {
    const surchargeRows = original.rows.filter(row => row.code === "923184" && row.column === "total");
    if (surchargeRows.length !== 1 || !same(surchargeRows[0].expected, combined) || computations.surcharge.alreadyHandledInFieldMap !== true) return refuse("surcharge_owner_inconsistent");
  }
  const surchargeEntry = { ...computations.surcharge,
    ...(pensionSurcharge > 0 ? { alreadyHandledInFieldMap: true, fieldMapCombinedValue: combined, pensionSurchargePart: pensionSurcharge } : {}),
  };
  if (!pensionSurcharge && surchargeEntry.alreadyHandledInFieldMap) return refuse("surcharge_owner_inconsistent");
  const planComputations = { ...computations, expectedBusinessIncome: computations.expectedBusinessIncome + totalIncome, surcharge: surchargeEntry, superTax: { ...computations.superTax } };
  const rows = original.rows.filter(row => row.code !== "9200").map(row => ({ ...row }));
  for (const code of ["3129", "3200", "3000"]) {
    const target = rows.filter(row => row.code === code && row.column === "total");
    if (target.length !== 1) return refuse("business_row_missing_or_ambiguous");
    target[0].expected += totalIncome;
    target[0].formula += ` + mapped final-tax Services (${totalIncome})`;
    target[0].proven = false;
  }
  // No fabricated complete-return 9200 formula: final liabilities and credits
  // require separate authoritative reconciliation and portal acceptance.
  const expectedIrisTotals = { ...original, rows, computations: planComputations,
    skipped: [...original.skipped.filter(row => row.code !== "9200"), { code: "9200", reason: "Four-source full liability (normal + final taxes and credits) requires separate reconciliation; not certified by a normal-tax subtotal." }],
  };
  return { ok: true, plan: { version: FOUR_INCOME_PLAN_VERSION, rulesVersion: FOUR_INCOME_RULES_VERSION,
    route: "salary_business_pension_services", taxYear: 2026, incomeSources: [...input.incomeSources].sort(),
    calculationRevision: input.calculationRevision, salaryGross: input.salaryGross, pension: { ...pension },
    services: { totalIncome, finalIncome: totalIncome, normalIncome: 0 },
    expectedTaxableIncome: approved.taxableIncome, expectedNormalTax: approved.normalTax,
    normalSurcharge: surcharge, pensionSurcharge, combinedSurcharge: combined,
    surchargeOwner: pensionSurcharge > 0 ? "field_map" : "computations",
    computations: planComputations, expectedIrisTotals,
  } };
}
