import { isBusinessPensionServicesFiling } from "./business-bank-categories";
import {
  SURCHARGE_USER_MESSAGE,
  type ComputationsPlan,
  type ExpectedIrisTotals,
} from "./business-iris-expectations";
import type { PortalFieldMapEntry } from "./portal-field-map";
import { section4ABRatePercent } from "./tax-calculation";

/**
 * Route 7 envelope — Business + Pension + Services (no Salary), TY2026 Myself.
 *
 * The server gate and the desktop resolver accept this source set since
 * 11-Nov-2026, but the resolver stays `active: false` until a snapshot carries
 * `businessPensionServices.version === "business-pension-services-v1"` AND
 * `businessPensionServices.computations.version === "computations-v1"`. This
 * module is the only producer of that envelope, so it is the one place that
 * decides what the agent may type on this route.
 *
 * What it does NOT do:
 *  - it invents no tax treatment. Every figure is either inherited from the
 *    Business packet (`buildExpectedIrisTotals`, which already folds the
 *    reviewed pension normal-slab part and the pension final-tax surcharge via
 *    `companionNormalIncome`) or copied from the approved Services field map;
 *  - it does not re-price a slab. Normal-tax Services revenue (revenue left
 *    inside Division I) changes 9100/920000, so this builder fails closed
 *    instead of guessing — only final-tax (section 154A) Services revenue is
 *    folded here;
 *  - it never writes the combined surcharge a second time. The field map owns
 *    row 923184; the desktop verifies its combined value and both base figures.
 */

export const BUSINESS_PENSION_SERVICES_VERSION = "business-pension-services-v1";

export type BusinessPensionServicesPensionTreatment =
  | "exempt"
  | "exempt_age70"
  | "salary"
  | "final_above_10m";

export type BusinessPensionServicesPlan = {
  version: typeof BUSINESS_PENSION_SERVICES_VERSION;
  route: "business_pension_services";
  coverage: "business_pension_services_only";
  taxYear: 2026;
  /** The pension leg, exactly as the reviewed statement and packet see it. */
  pension: {
    treatment: BusinessPensionServicesPensionTreatment;
    annualPension: number;
    /** Joins Taxable Income (9100): pension taxed at the normal slabs. */
    normalIncome: number;
    /** Declared but not taxed (section 149(IA) / age-70 exemption). */
    exemptIncome: number;
    /** The part above PKR 10 million that carries the 5% final tax. */
    finalTaxableIncome: number;
    /** Section 4AB surcharge already computed on the pension's own tax. */
    surcharge: number;
  };
  /** The Services leg: section 154A export revenue is final tax. */
  services: {
    totalIncome: number;
    normalIncome: number;
    finalIncome: number;
  };
  /** The Business leg inherited from the Business packet. */
  business: {
    taxableIncome: number | null;
    normalTax: number | null;
  };
  /** IRIS 9100 / 920000 this return should show. */
  expectedTaxableIncome: number | null;
  expectedNormalTax: number | null;
  /**
   * Row 920000 x rate. `normalTaxPart` is the half this envelope can type,
   * `pensionPart` the half the field map owns.
   */
  surcharge: {
    ratePercent: 9 | 10;
    normalTaxPart: number;
    pensionPart: number;
    /** normalTaxPart + pensionPart: the whole of IRIS row 923184. */
    value: number;
    /**
     * Who types the row today.
     *  - `envelope`  the computations plan types it (P-A, single owner);
     *  - `field_map` the packet's own portal field map types the sum of both
     *                halves and the plan only confirms it (P-B since
     *                11-Nov-2026 — see `owner` note below);
     *  - `operator`  nobody types it; the taxpayer does (no longer produced,
     *                kept so an older packet still parses).
     */
    owner: "envelope" | "field_map" | "operator";
  };
  expectedIrisTotals: ExpectedIrisTotals & { computations: ComputationsPlan };
  computations: ComputationsPlan;
  /** Plain-language lines for the packet report; never a substitute for them. */
  notes: string[];
};

const money = (value: unknown) => Math.round(Number(value) || 0);

const KNOWN_TREATMENTS: ReadonlySet<string> = new Set([
  "exempt",
  "exempt_age70",
  "salary",
  "final_above_10m",
]);

const PENSION_FINAL_LIMIT = 10_000_000;
const SECTION_4AB_THRESHOLD = 10_000_000;

/**
 * Builds the `business-pension-services-v1` envelope, or returns `null` so the
 * packet aborts with a plain message. Returning `null` is the whole safety
 * story of this route: the desktop resolver needs this envelope to activate,
 * so a stale, ambiguous or unsupported return simply never activates.
 */
export function buildBusinessPensionServicesPlan(input: {
  taxYear: number;
  filerType: string | null;
  incomeSources: string[];
  /** `business.expectedIrisTotals` — already carries the pension fold. */
  businessExpectedIrisTotals: ExpectedIrisTotals;
  servicesFields: readonly PortalFieldMapEntry[];
  hasUnmappedPortalIncome: boolean;
  pension: {
    treatment: string | null;
    annualPension: number;
    surcharge: number | null;
  };
}): BusinessPensionServicesPlan | null {
  if (
    !isBusinessPensionServicesFiling({
      taxYear: input.taxYear,
      filerType: input.filerType,
      incomeSources: input.incomeSources,
    })
  ) {
    return null;
  }
  const original = input.businessExpectedIrisTotals;
  if (!original?.computations || original.computations.version !== "computations-v1") {
    return null;
  }
  const treatment = String(input.pension?.treatment ?? "");
  if (!KNOWN_TREATMENTS.has(treatment)) return null;

  /* ---------------------------------------------------------- pension leg --- */
  const annualPension = Math.max(0, money(input.pension?.annualPension));
  const pensionSurcharge = Math.max(0, money(input.pension?.surcharge));
  let normalIncome = 0;
  let exemptIncome = 0;
  let finalTaxableIncome = 0;
  if (treatment === "salary") {
    normalIncome = annualPension;
  } else if (treatment === "final_above_10m") {
    exemptIncome = Math.min(annualPension, PENSION_FINAL_LIMIT);
    finalTaxableIncome = Math.max(0, annualPension - PENSION_FINAL_LIMIT);
    // The statement's own 5% final tax above PKR 10 million must be a real
    // figure before this envelope can claim the pension leg is complete.
    if (finalTaxableIncome > 0 && pensionSurcharge <= 0) return null;
  } else {
    exemptIncome = annualPension;
  }

  /* --------------------------------------------------------- services leg --- */
  const servicesRows = input.servicesFields.filter(
    (field) => field.servicesMappingKind === "SERVICES_INCOME",
  );
  const totalIncome = servicesRows
    .filter((field) => field.column === "Total Amount")
    .reduce((sum, field) => sum + money(field.ourAmount), 0);
  const finalIncome = servicesRows
    .filter((field) => field.column === "Subject to Final Tax")
    .reduce((sum, field) => sum + money(field.ourAmount), 0);
  if (totalIncome < 0 || finalIncome < 0 || finalIncome > totalIncome) return null;
  const normalServicesIncome = totalIncome - finalIncome;
  // A rupee of normal-slab Services revenue would have to be re-priced through
  // Division I together with the Business income; that is not this builder's
  // job, so the route refuses instead of publishing a stale 9100/920000.
  if (normalServicesIncome > 0) return null;
  if (totalIncome > 0 && input.hasUnmappedPortalIncome) return null;

  /* --------------------------------------------------------- business leg --- */
  const computations = original.computations;
  const expectedTaxableIncome = computations.expectedTaxableIncome;
  const expectedNormalTax = computations.expectedNormalTax;
  if (
    !Number.isFinite(expectedTaxableIncome) ||
    !Number.isFinite(expectedNormalTax) ||
    Number(expectedTaxableIncome) <= 0 ||
    Number(expectedNormalTax) <= 0
  ) {
    return null;
  }
  const taxable = money(expectedTaxableIncome);
  const normalTax = money(expectedNormalTax);

  /* -------------------------------------------------------- surcharge fold --- */
  const ratePercent = section4ABRatePercent({
    // No salary source on this route. Pension taxed as salary is the only
    // income that can stand in the salary head, and the Business packet has
    // already priced 920000 with that same assumption.
    salaryHeadIncome: normalIncome,
    taxableIncome: taxable,
  });
  const normalTaxPart =
    taxable > SECTION_4AB_THRESHOLD
      ? Math.round((normalTax * ratePercent) / 100)
      : 0;
  const surchargeValue = normalTaxPart + pensionSurcharge;

  // The Business packet writes its own surcharge expectation when it priced
  // 920000. If it disagrees with this fold by more than rounding, the two
  // owners are looking at different returns: refuse rather than pick one.
  const packetSurcharge = computations.surcharge;
  if (
    packetSurcharge.action === "TYPE" &&
    Math.abs(money(packetSurcharge.value) - normalTaxPart) > 1
  ) {
    return null;
  }
  if (
    packetSurcharge.action === "TYPE" &&
    packetSurcharge.ratePercent !== null &&
    packetSurcharge.ratePercent !== ratePercent
  ) {
    return null;
  }

  const notes: string[] = [];
  const phone = (value: number) => value.toLocaleString("en-US");

  let surchargeEntry: ComputationsPlan["surcharge"];
  let owner: "envelope" | "field_map" | "operator";
  if (pensionSurcharge > 0) {
    // 11-Nov-2026: ONE owner for this row. The packet's portal field map already
    // publishes row 923184 as `pensionSurcharge + additionalSection4ABSurcharge`
    // (portal-field-map.ts, `PENSION_SURCHARGE`), and the server resolver that
    // feeds that second half now admits the final-tax Services leg. So the field
    // map types the whole row and this plan must NOT type a half of it: the
    // handled flag prevents a second write; the explicit components enable
    // read-only verification rather than an unverified manual handoff.
    owner = "field_map";
    surchargeEntry = {
      code: "923184",
      label: packetSurcharge.label || "Surcharge on high earning person u/s 4AB",
      action: normalTaxPart > 0 ? "TYPE" : "NONE",
      value: normalTaxPart,
      ratePercent,
      alreadyHandledInFieldMap: true,
      fieldMapCombinedValue: surchargeValue,
      pensionSurchargePart: pensionSurcharge,
      basis:
        `Row 923184 is the sum of the pension final-tax surcharge ${phone(pensionSurcharge)} ` +
        `and ${ratePercent}% of Normal Tax ${phone(normalTax)} (920000) = ${phone(normalTaxPart)}, ` +
        `i.e. ${phone(surchargeValue)} in total. Both halves are written by the packet's own ` +
        `field map as one figure, so this plan types nothing and only confirms it.`,
      message:
        `IRIS row 923184 is the pension Section 4AB surcharge ${phone(pensionSurcharge)} plus ` +
        `${ratePercent}% of Normal Tax (920000) = ${phone(normalTaxPart)}, i.e. ${phone(surchargeValue)} in total. ` +
        `The approved field map targets that combined figure; the computations driver verifies it ` +
        `against the actual IRIS row and normal-tax bases without typing it again.`,
    };
    notes.push(
      `Surcharge row 923184: pension ${phone(pensionSurcharge)} + ${ratePercent}% of Normal Tax ${phone(normalTax)} (${phone(normalTaxPart)}) = ${phone(surchargeValue)}. ` +
        `Owned by the packet's field map; the computations plan verifies it and types nothing.`,
    );
  } else {
    owner = "envelope";
    surchargeEntry =
      normalTaxPart > 0
        ? {
            code: "923184",
            label: "Surcharge on high earning person u/s 4AB",
            action: "TYPE",
            value: normalTaxPart,
            ratePercent,
            basis: `${ratePercent}% of Normal Tax ${phone(normalTax)} (920000), because Taxable Income ${phone(taxable)} (9100) is above PKR 10 million. No salary source and no final-tax pension surcharge on this return.`,
            message: "",
          }
        : {
            code: "923184",
            label: "Surcharge on high earning person u/s 4AB",
            action: "NONE",
            value: 0,
            ratePercent,
            basis: "Taxable Income (9100) is PKR 10 million or less: no surcharge",
            message: "",
          };
  }

  /* ------------------------------------------------------------ IRIS rows --- */
  const rows = original.rows.map((row) => ({ ...row }));
  const addToRow = (
    code: string,
    column: "normal" | "total",
    amount: number,
    label: string,
  ) => {
    if (amount === 0) return;
    const row = rows.find(
      (candidate) => candidate.code === code && candidate.column === column,
    );
    if (!row) return;
    row.expected = money(row.expected + amount);
    row.formula = `${row.formula} + ${label} (${phone(amount)})`;
    // Final-tax Services revenue has not been part of a live Business run.
    row.proven = false;
  };
  for (const code of ["3129", "3200", "3000"]) {
    addToRow(code, "total", totalIncome, "mapped Services income");
  }
  // The Business packet emits the row in its `normal` column; find it by code
  // so a column change in the packet can never silently drop the combined
  // figure this envelope publishes.
  const surchargeRow = rows.find((row) => row.code === "923184");
  if (surchargeRow) {
    surchargeRow.expected = surchargeValue;
    surchargeRow.formula =
      owner === "field_map"
        ? `pension final-tax surcharge ${phone(pensionSurcharge)} + ${ratePercent}% of 920000 (${phone(normalTaxPart)}) — one figure typed by the packet's field map, confirmed here`
        : surchargeRow.formula;
    surchargeRow.proven = false;
  }

  const skipped = original.skipped.map((item) => ({ ...item }));
  const envelopeComputations: ComputationsPlan = {
    ...computations,
    surcharge: surchargeEntry,
    superTax: { ...computations.superTax },
    ...(computations.turnover ? { turnover: { ...computations.turnover } } : {}),
  };

  notes.push(
    `Taxable Income (9100) ${phone(taxable)} = Business ${phone(computations.expectedBusinessIncome ?? 0)} + pension taxed at the normal slabs ${phone(normalIncome)}; Normal Tax (920000) ${phone(normalTax)} at the applicable Division I slab; normal-tax pension contributes to the Salary head.`,
  );
  if (finalTaxableIncome > 0) {
    notes.push(
      `Pension above the PKR 10 million limit: ${phone(finalTaxableIncome)} at 5% final tax (row 64020004), surcharge ${phone(pensionSurcharge)}; ${phone(exemptIncome)} sits in the exemption column so IRIS does not charge slabs on it.`,
    );
  } else if (exemptIncome > 0) {
    notes.push(
      `Exempt pension ${phone(exemptIncome)} is written to the exemption column of row 1008, so IRIS derives Normal = 0.`,
    );
  }
  if (totalIncome > 0) {
    notes.push(
      `Services ${phone(totalIncome)} is section 154A final-tax revenue: it joins Other Revenues (3129) and the Total Income column of 3000, and never 9100.`,
    );
  }

  return {
    version: BUSINESS_PENSION_SERVICES_VERSION,
    route: "business_pension_services",
    coverage: "business_pension_services_only",
    taxYear: 2026,
    pension: {
      treatment: treatment as BusinessPensionServicesPensionTreatment,
      annualPension,
      normalIncome,
      exemptIncome,
      finalTaxableIncome,
      surcharge: pensionSurcharge,
    },
    services: {
      totalIncome,
      normalIncome: normalServicesIncome,
      finalIncome,
    },
    business: {
      taxableIncome:
        Number.isFinite(Number(computations.expectedBusinessIncome))
          ? money(computations.expectedBusinessIncome)
          : null,
      normalTax,
    },
    expectedTaxableIncome: taxable,
    expectedNormalTax: normalTax,
    surcharge: {
      ratePercent,
      normalTaxPart,
      pensionPart: pensionSurcharge,
      value: surchargeValue,
      owner,
    },
    expectedIrisTotals: {
      ...original,
      rows,
      skipped,
      computations: envelopeComputations,
    },
    computations: envelopeComputations,
    notes,
  };
}
