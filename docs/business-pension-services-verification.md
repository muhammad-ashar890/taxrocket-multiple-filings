# Business + Pension + Freelancer / Services — staged verification (Route 7)

## Scope and evidence boundary

This runbook is for the exact **TY2026 / Myself / Business + Pension + Services** route — three sources, **no Salary**. It does not authorize another source combination, Calculate, Submit, Prepare PSID or payment. Offline tests establish code and fixture behaviour only; they do not establish current live IRIS behaviour, and **this route has never been run against IRIS**.

Run stages in order. A failed gate stops the stage: do not bypass a missing/tampered Services payload, a missing `business-pension-services-v1` envelope, a Business/pension/surcharge mismatch, an incomplete readback, or a non-zero Wealth reconciliation.

## What this route reuses

| Piece | Source route it reuses |
| --- | --- |
| Business packet (Trading, Admin, Balance Sheet, Deductions, Tax Deduction, Depreciation) | Business alone / Salary + Business / Salary + Business + Pension |
| Services income (`3101` Total / Subject to Final Tax) and withholding (`64060290`, section evidence) | Services alone / Salary + Services / Business + Services |
| Services payload slot (`snapshot.services`) beside the Business packet | Salary + Business + Services / Business + Services |
| Pension `1008` split, `64020004` / `64020007` | Pension + Services (`electron-connect/pension-guard.js`) |
| Folded `computations-v1` (9100 / 920000 / 923184) | Business + Salary/Pension companion fold, wrapped by the new envelope |
| Wealth `7098` outflow rows | one row per statutory section, merged across the whole filing |

**New in this route:** `lib/tax/business-pension-services-plan.ts`. It is the only producer of `business-pension-services-v1`, and the desktop resolver stays inactive without it.

## Stage 0 — offline acceptance

```sh
node scripts/verify-business-pension-services-gate.cjs        # 9 / 0
node scripts/verify-business-pension-services-envelope.cjs    # 13 / 0
node scripts/verify-salary-pension-services-route.cjs         # 9 / 0
node scripts/verify-phase7-multifiling-remaining.cjs          # 5 / 0
node scripts/verify-services-business-gate-parity.cjs         # 5 / 0
node scripts/verify-salary-business-services-route.cjs        # 5 / 0
node scripts/verify-services-income-safeguards.cjs            # 10 / 0
node scripts/verify-services-phase6-electron.cjs              # 19 / 0
node scripts/verify-iris-row-filler.cjs                       # 35 / 0
node scripts/verify-portal-field-map.cjs                      # 31 / 0
npx tsc --noEmit
for f in electron-connect/*.js; do node --check "$f" || exit 1; done
```

Required invariants (all asserted by the two Route 7 suites):

- The exact set `{business, pension, services}` is accepted in any order and only for TY2026 / Myself; duplicates, the quadruple, Business + Pension without Services, TY2025 and `my_business` all stay refused.
- `exact` may be true while `active` stays **false**: activation requires `snapshot.businessPensionServices.version === "business-pension-services-v1"` **and** `computations.version === "computations-v1"`. Opening the gate types nothing by itself.
- `salaryIncluded` false, `pensionIncluded` **and** `businessIncluded` true; the section allowlist therefore opens Employment (`1008`, `tax_deductions`), the five Business tabs and `computations`.
- **9100** = Business income + pension taxed at the normal slabs. Exempt pension and section 154A Services revenue never join it.
- **923184** = pension final-tax surcharge + `section4ABRatePercent` of 920000. With no salary head the rate is **10%**, never 9%. A pension `final_above_10m` source makes the row `action: "USER"` (owner: operator) so the agent never types half of it; an exempt or salary-treated pension makes it `action: "TYPE"` (owner: envelope).
- The envelope **refuses** (no envelope → no activation, packet aborts with a plain message) on: a normal-tax Services rupee, an unmapped portal source, an unknown pension answer, `final_above_10m` without its 5% figure, a Business packet with no combined 9100/920000.
- Salary rows `1009` / `64020004` can never resolve on this route.

## Stage 1 — supervised dry run (no Save)

1. Build and approve the packet for the exact `{business, pension, services}` draft and confirm the snapshot carries `businessPensionServices`. Without it the agent reports `active: false` and types nothing — that is fail-closed, not a bug.
2. Run the agent with `TAXROCKET_REAL_AUTOFILL=dry`. Confirm the section allowlist above and that every target resolves with **filled 0**.
3. Record, read-only, IRIS's own values for: `1008` (Total / Final / Exemption), `3009`, `3039`, `3129`, `3101` (Total / Subject to Final Tax), `64060290`, `9100`, `920000`, `923184`, `9200`, `703000`, `703001`, `703002`, `7098`.
4. Nothing is typed and there is **no Calculate, no Submit, no PSID, no payment**. Auto Calculate may refresh on tab change — that is the only mechanism used to observe totals.

**Stop the stage** if any invariant above is violated, if a target does not resolve, or if a figure differs from the approved packet.

Reference figures for the synthetic fixture (`TY2026_Business_Pension_Services_SYNTHETIC/`, scenario P-A exempt pension): `9100 = 15,000,000`, `920000 = 5,840,000`, `923184 = 584,000` (10%, envelope-owned, no pension half), `9200 = 6,424,000`, `1008` Total 9,000,000 / Exemption 9,000,000, `3101` 1,800,000 / 1,800,000, `64060290 = 4,500`, `703002 = 8,780,220`, `703001 = 33,775,720`, `703000 = 0`, `7098` section 154A `4,500`.

## Stage 2 — live approved-entry run (separate authorization required)

Only after Stage 1 evidence is recorded and explicitly accepted:

- one draft **Save** at the end, only when every scoped figure read back the same after the tab switch and the Wealth reconciliation check reports a zero gap;
- Submit, Calculate, Prepare PSID and payment are never pressed;
- the taxpayer reviews and files the return in IRIS themselves.

If row `923184` is left to the taxpayer (see the parked decision), the run records the exact figure and the row for manual entry instead of failing the run.

## Fixture pack

`TY2026_Business_Pension_Services_SYNTHETIC/` — no salary document anywhere, one CNIC, one TY2025 return for `703002`, and `EXPECTED_DATA.json` whose `expectedIris` block is computed by the production builders (`buildExpectedIrisTotals` → `buildBusinessPensionServicesPlan`), so the pack and the packet cannot drift apart silently.

| Document | Figures |
| --- | --- |
| Business Books | sales 20,000,000 − cost 5,000,000 = profit 15,000,000, no withholding |
| Business Balance Sheet | HBL 25,276,054 total assets = owner capital 15,280,554 (opening cash 280,554 + profit 15,000,000) + 9,995,500 amount due to proprietor (exempt pension + services net − drawings) |
| Pension Statement | 9,000,000 exempt (≤ 10 M), no tax, 12 × 750,000 credits |
| Services Invoices (154A) | gross 1,800,000, 0.25% withheld 4,500, net 1,795,500 |
| HBL Statement | opening 280,554 → closing 25,276,054, 23 transactions |
| Previous return | supplied TY2025 return, net assets 8,780,220 |

## Phase 5 — the Route 7 computations plan reached the desktop (11-Nov-2026)

`lib/tax/business-pension-services-plan.ts` produced a `computations-v1` plan and
`app/actions/packet.ts` shipped it as `snapshot.businessPensionServices.computations`, but
`electron-connect/main.js` `resolveAutofillComputationsPlan()` had no branch that returned it. A
fully valid triple therefore ran with `computationsPlan === null`, and `runRealIrisAutofill` skipped
the Computations tab **without a message**: row `923184` was never typed and never compared with
IRIS's own base. Every suite stayed green because no suite asked that resolver about this route.

Fix: one read-only branch at the top of the resolver, returning the envelope's own plan.

Proof (new suite `scripts/verify-bps-computations-plan.cjs`, 4 checks):

- the resolver returns `snapshot.businessPensionServices.computations` for a real P-A envelope and
  the value it will type is `923184 = 584,000` (`action: "TYPE"`, 10% of `920000 = 5,840,000`);
- it still returns `null` when the envelope is absent, stale-versioned or without a `computations-v1`
  plan (fail closed);
- Route 5 (Salary + Business + Services), Route 4 (Business + Pension) and Business-only keep exactly
  the plan they had;
- Route 6 (Business + Services, no pension) still gets **no** plan — it has no envelope builder, so
  this fix does not widen it. That remains an open, documented limit.

Without the branch the same suite fails 2 of 4, so the gap cannot silently return.

### Law check for the figure this fix types (TY2026)

- Section 4AB was inserted by the Finance Act 2024 at **10%** of the income tax where taxable income
  exceeds PKR 10 million; the Finance Act 2025 added the proviso reducing it to **9%** for an
  individual deriving income under the head "salary". Non-salary income stays at **10%**.
- Tax year 2026 (1 Jul 2025 – 30 Jun 2026) is governed by the **Finance Act 2025**. The Finance Act
  2026 removes the surcharge for *salary* income from 1 Jul 2026 (TY2027 onward) and does not reach
  this return or any non-salary case.
- Route 7 has no salary head at all, so `923184 = 10% × 920000 = 584,000` is the correct TY2026
  figure and the envelope-owned (`action: "TYPE"`) path is the right one. Nothing in this fix changes
  a rate; it only delivers the plan that already computed it.
