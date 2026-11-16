# TY2026 four-income rules: evidence and implementation decisions

## Rule #1

No guessed rates, taxable bases, portal row codes or completion claims. Preserve
unknowns as explicit eligibility blocks. This document describes code decisions
and their evidence; offline code tests do not establish live IRIS behavior.

## Sources actually inspected

1. User-supplied `2026-rules.pdf`, present at `/home/user/uploads/2026-rules.pdf`:
   14-page FBR WHT card updated 30 June 2025 for Finance Act 2025. Pages 2 and 7
   inspected through text extraction. The card itself states that statute prevails.
2. Official Income Tax Ordinance amended 20 February 2026, retained PDF/text from
   the earlier official-source review:
   https://download1.fbr.gov.pk/Docs/2026226162211364IncomeTaxOrdinance2001-Amended-20.02.2026.pdf
   - Section 4AB: printed page 33 / PDF page 52.
   - Division I clause (2): printed page 491 / PDF page 510.
3. Official FBR Circular 01/2025-26 dated 2 August 2025, section 2, fetched again:
   https://download1.fbr.gov.pk/Docs/2025841183918948CircularNo01of2025-26IncomeTax.pdf

Secondary search results were useful to locate material but were NOT used as the
controlling implementation source. TY2027 surcharge changes are out of scope.

## Distinct tests that must not be conflated

### Division I slab selection

The schedule says: where an individual's income chargeable under Salary
**exceeds seventy-five per cent of taxable income**, the clause (2) table applies.
Otherwise the applicable clause (1) table remains. The strict >75% boundary stays
unchanged in `divisionITaxForIncome` and `computeCombinedSlabRoute`.

### Section 4AB surcharge eligibility

Section 4AB sets 10% of Division I tax above taxable income of Rs 10 million, with
this proviso:

> Provided that in case of an individual deriving income chargeable under the
> head “Salary”, a surcharge shall be payable at the rate of nine percent of the
> income tax imposed under Division I of Part I of the First Schedule where the
> taxable income exceeds rupees ten million in a tax year.

That proviso does not contain the schedule's >75% condition. The code previously
imported the slab-table condition into surcharge eligibility. This is the root
cause corrected in this checkpoint, not a new percentage invented for four sources.

The implementation now keeps the two tests separate:

- Applicable normal tax uses the appropriate slab table, still with >75% selection.
- Positive Salary-head income uses 9% surcharge on that normal tax above 10m.
- No normal Salary-head income uses 10% above 10m.
- At/below 10m there is no normal surcharge.

The FBR circular explicitly states that a continuing-employment pension is subject
to normal slab rates and the employer collects applicable 9% surcharge. This
supports treating that pension's normal component as Salary-head income. It is
not treated like the special former-employee final-tax pension component below.

### Special pension and Services treatment retained

- Qualifying former-employer final pension: 5% on the excess over 10m, with the
  existing user-confirmed 10% surcharge on that pension tax. It does not join the
  normal slab base. Its component is computed separately and added once to the
  combined surcharge target. This checkpoint does not redesign that special regime.
- Exempt / qualifying age-exempt pension: no normal-tax contribution.
- Normal-tax pension: joins Salary and Business in the one progressive base.
- Eligible Section 154A final-tax Services: stays outside the normal slab base;
  rate/eligibility evidence remains the existing Services module's responsibility.
- Normal/mixed Services: NOT enabled by this checkpoint. Reviewed expenses,
  taxable-profit evidence, portal representation and applicable credits/minimum
  tax must be implemented before those cases are approved.

## Numeric root-cause regression

Salary 7m + Business profit 5m = normal taxable base 12m.

- Salary share 58.33%: clause (1), not the salary table.
- Normal tax: 4,490,000 (unchanged).
- Normal surcharge: 9% = 404,100 (previous code incorrectly used 449,000).
- Normal liability subtotal: 4,894,100.

Adding qualifying final pension 12m and final Services receipts 1.8m does not change
that normal base/tax. Pension tax is 100,000, pension surcharge 10,000; combined row
923184 target is 414,100. Services tax is a separate line under its verified regime.
These are synthetic calculation fixtures, not live IRIS observations.

## New staged four-source contract

`lib/tax/four-income-plan.ts` defines `four-income-v1` and rules marker
`ty2026-salary-head-proviso-v1`. It is not yet connected to production packet
creation or desktop activation. The four-source gate deliberately remains closed.

The builder requires:

- exact four-source set, any order; TY2026 / Myself;
- current calculation revision, positive evidenced salary and pension;
- validated pension treatment and special final-tax components;
- positive final-tax Services receipts with matching per-row reclassification;
- verified existing Other Revenues mapping, no duplicates or negative amounts;
- approved combined-slab figures agreeing with typed Business expectations and
  the independently selected slab / surcharge arithmetic;
- consistent combined surcharge ownership and target.

Explicitly blocked in this initial contract:

- normal/mixed Services, missing evidence, unsupported mappings;
- minimum-tax combinations;
- loss/component set-off ambiguity;
- possible Section 4C cases, using a conservative upper bound that may over-block
  a high-gross-income case rather than assume an unverified exemption;
- stale or inconsistent calculation/row/component amounts.

Full-return 9200 liability is deliberately not certified from a normal-tax subtotal.
The staged contract removes that inherited partial expectation and names the
remaining full-liability reconciliation requirement. Do not call that missing
check completed and do not activate the route until its top-level acceptance
conditions are explicit.

## Freshness / compatibility boundary

New four-source packets cannot be created by current production gates. Integration
must use the new contract/rules marker and the current approved combined-slab
revision, and reject old/missing contracts before execution. The builder already
rejects mismatching old surcharge arithmetic.

Existing mixed Salary/Business or normal-pension calculations affected by this rule
correction must be recalculated and their packets regenerated/reapproved before
using the updated code. Comprehensive persisted-packet policy/version enforcement
is part of the integration work still pending; no existing approved packet has
been migrated, executed or certified by this checkpoint.

## Tests / scope boundary

- `verify-ty2026-salary-surcharge-proviso.cjs`: separate slab and surcharge tests,
  including positive minority salary and the exact 75% boundary.
- `verify-four-income-plan.cjs`: actual calculator + actual Business expectations
  + new contract + actual pure driver on synthetic rows. All 24 source orders,
  four pension treatments, threshold boundaries, zero normal tax and refusals.
- These are NOT top-level packet-action/database/browser integration tests.
- Existing tests with old 10%-despite-Salary expectations were updated to the
  documented statutory distinction while retaining their unchanged slab amounts.
- Existing non-salary Business and special final-pension 10% tests remain intact.

No live IRIS, production DB, Calculate, Save, Submit, PSID or payment actions.
