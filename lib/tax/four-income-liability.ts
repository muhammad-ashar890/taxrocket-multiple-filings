import { FOUR_INCOME_RULES_VERSION, type FourIncomePlan } from "./four-income-plan";

export type FourIncomeLiability = {
  normalTax: number; normalSurcharge: number; pensionTax: number;
  pensionSurcharge: number; servicesFinalTax: number; totalTax: number;
  taxWithheld: number; taxPayable: number; refundDue: number;
};
type Line = { source: string; taxBase?: unknown; baseTax?: unknown; surcharge?: unknown; calculatedTax?: unknown; detailsJson?: string | null };
/** Reconcile CURRENT persisted lines, not a fresh estimate around an old approval. */
export function reconcileFourIncomeLiability(plan: FourIncomePlan, lines: readonly Line[], totals: { taxWithheld: unknown; taxPayable: unknown; refundDue: unknown }): { ok: true; liability: FourIncomeLiability } | { ok: false; reason: string } {
  const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  const money = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const n = typeof value === "number" ? value : Number(String(value));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const parsed = [];
  for (const line of lines) {
    let details: any; try { details = JSON.parse(line.detailsJson ?? ""); } catch { return refuse("calculation_details_missing"); }
    if (details?.calculationPolicy !== FOUR_INCOME_RULES_VERSION) return refuse("old_calculation_policy_recalculate");
    if (!["combined_slab", "pension", "services"].includes(line.source)) return refuse("unsupported_extra_tax_line");
    const values = [line.taxBase, line.baseTax, line.surcharge, line.calculatedTax].map(money);
    if (values.some(n => n === null)) return refuse("calculation_amount_missing");
    const [income, base, surcharge, due] = values as number[];
    if (Math.abs(base + surcharge - due) > 1) return refuse("calculation_line_inconsistent");
    parsed.push({ source: line.source, income, base, surcharge, due, details });
  }
  const normal = parsed.filter(line => line.source === "combined_slab");
  const services = parsed.filter(line => line.source === "services");
  const pension = parsed.filter(line => line.source === "pension");
  if (normal.length !== 1 || !services.length || pension.length !== (plan.pension.treatment === "salary" ? 0 : 1)) return refuse("calculation_lines_missing_or_duplicate");
  const n = normal[0];
  if (n.income !== plan.expectedTaxableIncome || n.base !== plan.expectedNormalTax || n.surcharge !== plan.normalSurcharge || n.details.isFinalTax !== false) return refuse("normal_calculation_differs");
  const routes = n.details.combinedRoutes;
  const expectedRoutes = ["salary", "business_profit", ...(plan.pension.treatment === "salary" ? ["pension"] : [])].sort();
  if (!Array.isArray(routes) || routes.length !== expectedRoutes.length || routes.map((r: any) => r.route).sort().some((route: string, i: number) => route !== expectedRoutes[i]) || routes.some((r: any) => money(r.income) === null) || routes.reduce((sum: number, r: any) => sum + r.income, 0) !== n.income || routes.find((r: any) => r.route === "salary")?.income !== plan.salaryGross || (plan.pension.treatment === "salary" && routes.find((r: any) => r.route === "pension")?.income !== plan.pension.annualPension)) return refuse("normal_components_differs");
  if (services.some(line => line.details.isFinalTax !== true || line.surcharge !== 0) || services.reduce((sum, line) => sum + line.income, 0) !== plan.services.totalIncome) return refuse("services_calculation_differs");
  const pensionTax = plan.pension.treatment === "final_above_10m" ? plan.pension.baseTax! : 0;
  if (pension.length && (pension[0].income !== plan.pension.annualPension || pension[0].base !== pensionTax || pension[0].surcharge !== plan.pensionSurcharge)) return refuse("pension_calculation_differs");
  const servicesFinalTax = services.reduce((sum, line) => sum + line.due, 0);
  const totalTax = n.due + pensionTax + plan.pensionSurcharge + servicesFinalTax;
  const [taxWithheld, taxPayable, refundDue] = [totals.taxWithheld, totals.taxPayable, totals.refundDue].map(money);
  if (taxWithheld === null || taxPayable === null || refundDue === null) return refuse("liability_totals_missing");
  // Existing estimator has no per-regime excess-credit allocation; do not
  // authorize a guessed mixed final/adjustable refund through this route.
  if (taxWithheld > totalTax || refundDue > 0) return refuse("mixed_withholding_excess_review_required");
  if (Math.abs(Math.max(0, totalTax - taxWithheld) - taxPayable) > 1) return refuse("liability_totals_differs");
  return { ok: true, liability: { normalTax: n.base, normalSurcharge: n.surcharge, pensionTax, pensionSurcharge: plan.pensionSurcharge, servicesFinalTax, totalTax, taxWithheld, taxPayable, refundDue } };
}
