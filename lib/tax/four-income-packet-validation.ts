import { prisma } from "@/lib/prisma";
import { isFourIncomeSourceSet } from "./four-income-source-set";
import { FOUR_INCOME_PLAN_VERSION, FOUR_INCOME_RULES_VERSION, type FourIncomePlan } from "./four-income-plan";
import { reconcileFourIncomeLiability } from "./four-income-liability";

/**
 * Read-only four-income contract check, run beside `pensionPacketValidationError`
 * before any surface will show, render, dispatch or hand a packet to the desktop.
 * It never repairs a pinned packet or guesses a figure: a missing, versioned,
 * stale or inconsistent envelope means "regenerate and approve a fresh packet".
 */
export async function fourIncomePacketValidationError(
  snapshot: any,
  filingDraftId: string,
  userId: string,
): Promise<string | null> {
  const four = snapshot?.fourIncome;
  const [draft] = await Promise.all([
    prisma.filingDraft.findFirst({
      where: { id: filingDraftId, userId },
      select: {
        taxYear: true,
        filerType: true,
        incomeSources: true,
        taxCalculationRevision: true,
        taxWithheld: true,
        taxPayable: true,
        refundDue: true,
      },
    }),
  ]);
  if (!draft) return "Filing draft not found for this packet. Start a new filing before desktop entry.";
  let liveSources: unknown;
  try { liveSources = JSON.parse(draft.incomeSources); } catch { return "Invalid current income selections. Regenerate the packet."; }
  const liveIsFourIncome =
    draft.taxYear === 2026 && draft.filerType === "myself" && isFourIncomeSourceSet(liveSources);

  if (!four) {
    // A four-income filing must never be served from a packet that predates
    // the versioned contract (e.g. a legacy snapshot or a packet built while
    // Services were still unsupported for the set).
    if (liveIsFourIncome)
      return "This packet predates the four-income contract (four-income-v1). Recalculate and approve a fresh packet before continuing; the pinned packet cannot be reused.";
    return null;
  }

  if (!liveIsFourIncome)
    return "This four-income packet no longer matches the current income selections (Salary + Business + Pension + Services). Regenerate the packet before continuing.";

  if (four.version !== FOUR_INCOME_PLAN_VERSION)
    return "This four-income packet uses an unrecognised contract version. Regenerate and approve a fresh packet.";
  if (four.rulesVersion !== FOUR_INCOME_RULES_VERSION)
    return "This four-income packet was priced under a different TY2026 rule set. Recalculate and approve a fresh packet.";
  if (four.route !== "salary_business_pension_services")
    return "This four-income packet names a different route. Regenerate and approve a fresh packet.";
  if (!draft.taxCalculationRevision || four.calculationRevision !== draft.taxCalculationRevision)
    return "The four-income calculation revision changed. Recalculate and approve a fresh packet before desktop entry.";
  if (snapshot?.filing?.taxCalculationRevision !== draft.taxCalculationRevision)
    return "The packet's calculation revision is stale. Regenerate and approve a fresh packet.";

  const lines = typeof prisma.filingTaxCalculationLine?.findMany === "function"
    ? await prisma.filingTaxCalculationLine.findMany({
        where: { filingDraftId, userId, calculationRevision: draft.taxCalculationRevision },
        select: { source: true, taxBase: true, baseTax: true, surcharge: true, calculatedTax: true, detailsJson: true },
      })
    : [];
  const reconciliation = reconcileFourIncomeLiability(
    four as FourIncomePlan,
    lines,
    { taxWithheld: draft.taxWithheld, taxPayable: draft.taxPayable, refundDue: draft.refundDue },
  );
  if (!("liability" in reconciliation))
    return `Four-income packet contract check failed (${reconciliation.reason}). Recalculate and regenerate a reviewed packet; no part of it may be used.`;
  return null;
}
