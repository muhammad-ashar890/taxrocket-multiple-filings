# Four-income implementation — checkpoint 1

## Standing rule

**No guessing. Reproduce the root cause in actual code, establish relevant tax rules and portal evidence, then fix and test. Unknowns remain explicit blockers.**

Scope: one TY2026 / Myself return containing Salary + Business + Pension + Services. No unrelated income categories. Implementation was authorized after the phased plan; no push or live IRIS authorization was given.

## Branch / baseline

- Feature branch: `feat/four-income-support`.
- Base HEAD: `315eef0aaebf0105a0597df38d55aa11d76adcbe`.
- Current changes are uncommitted and not pushed; main's committed code is unchanged.
- Expanded initial baseline: **119 pass / 0 fail** across 13 selected suites.

## Work completed in this checkpoint

### Root cause reproduced

The Business + Pension + final-tax Services builder replaced the surcharge with
`USER / value 0` and discarded its field-map handled flag. The actual field map
still emitted the correct combined 594,000, but the actual desktop driver returned
`taxpayer_types_it` for a correct synthetic cell. This is a readback/reporting bug,
not evidence that live typing failed.

A new regression suite was written first. Its initial 11 checks produced **2 pass /
9 fail**. The implementation was then changed; the suite was expanded to 14 checks.

### Read-only surcharge verification restored independently

- Optional contract fields retain combined field-map value and pension component.
- The builder preserves the normal component/rate and field-map ownership.
- Driver verifies ownership, action, rate, finite integer components, component sum,
  single readable row, matching 9100 and 920000, normal-component arithmetic and
  actual combined cell.
- Below/at threshold still requires both approved bases to match.
- Invalid combined metadata does not fall back to the old blind handled branch.
- Correct read-only results retain their amount through `fillComputations` into
  the outcome report; no claimed computations typing or manual work.
- Dry-run planned typing excludes the field-map-owned row.
- If navigation fails, the message asks for combined-row review rather than typing
  the normal half again. A pension-only NONE entry still gets that warning.
- Existing legacy packets without the new optional metadata retain old decision
  semantics; they are not newly certified as combined-cell verified.

The older repository's commit could not be fetched (authentication requested).
No credentials were requested or used. This change was independently implemented
from inspected code, the retained reproduction and tests; it is not claimed to be
an exact cherry-pick of an inaccessible commit.

### Verification

- New suite: **14 pass / 0 fail**.
- Wider regression: **243 pass / 0 fail**, 20 test files.
- `npx tsc --noEmit`: exit 0.
- `node --check` all `electron-connect/*.js`: pass.
- `git diff --check`: pass at verification.
- Independent real-builder/map/resolver/driver reproduction now returns
  `leave / combined_verified_in_field_map` for 594,000.
- Database/browser/IRIS are not involved in these tests. `fillComputations` tests
  inject synthetic navigation/snapshot/fill functions. No live verification claimed.

The two existing envelope/combined tests were updated from the obsolete USER/zero
shape to the explicit normal-component + handled flag + combined-value contract.
They still require the same component and combined amounts. Separate new tests
assert that no second fill call occurs.

## Phase status

| Phase | State |
| --- | --- |
| 0: baseline / root-cause map | Initial baseline and failure reproduction established; coverage expands with implementation |
| 1: rules and four-source contract | In progress; supplied PDF re-read; legal/portal eligibility matrix not signed off |
| 2: missing surcharge verifier | Implemented and offline-regression-tested for the opt-in existing triple; live acceptance pending |
| 3: four-source final-tax Services | Pending; gates intentionally remain closed |
| 4–5: normal/mixed Services | Pending; no inferred taxable-profit input or deduction mapping |
| 6: comprehensive regression/security | Checkpoint regressions pass; full four-source acceptance pending |
| 7: supervised IRIS | Not attempted / not authorized |

## Rules inventory and unresolved issue (not a rate change)

`/home/user/uploads/2026-rules.pdf` is present and was parsed (14 pages). Page 2
confirms the salary 9% card entry and qualifying pension 5% excess/10% surcharge;
page 7 shows Section 154A rates. These documented rates were not changed.

A material existing interpretation needs resolution for mixed Salary + Business:
`section4ABRatePercent` uses the >75% salary-share test for surcharge, while the
retained official Ordinance text, section 4AB (printed page 33 / PDF page 52), uses
“individual deriving income chargeable under the head Salary”. The 75% test for
salary slab selection must not automatically be assumed to settle the differently
worded surcharge proviso. The source research file cited in the helper's comment is
not included in this repository.

This checkpoint changes no tax rates and does not decide that discrepancy from
intuition. Research/verify the applicable TY2026 mixed-income treatment before
activating an affected new four-source case; document the evidence or keep that
case blocked. No additional user document is needed yet.

## Next concrete work

1. Resolve/document the TY2026 combined-rule and eligibility matrix using the
   supplied PDF and official sources as needed, without reopening unrelated rates.
2. Specify the four-source versioned contract, stale-packet behavior and cell owners.
3. Add failing supported-case tests, then wire the authoritative calculation,
   companion fold, packet/action paths and desktop together before opening gates.
4. Keep normal-tax Services blocked until real evidence/UI/mapping/credit handling
   is implemented. Do not enable it merely by selecting four income sources.

No Calculate, Submit, Save, PSID, payment, real taxpayer database access or push.

---

## Checkpoint 2 — rule separation and staged four-source contract

This section supersedes the unresolved-rule note in checkpoint 1 above.

### Completed

- Re-read the official Section 4AB proviso and the schedule's distinct >75% clause;
  fetched FBR Circular 01/2025-26 section 2 again. Evidence and quotations:
  `docs/ty2026-four-income-rules.md`.
- Corrected surcharge eligibility independently of slab selection. Positive normal
  Salary-head income now uses 9% above 10m even when clause (1) slabs apply.
  Special final-pension surcharge remains the separate user-confirmed 10%.
- Fixed a dependent bug: Business expectations had used `surchargeRate === 9` to
  label the slab table. It now independently checks salary share, so changing
  surcharge eligibility cannot accidentally change/label the normal slab.
- Added `lib/tax/four-income-plan.ts`, a staged four-source contract requiring
  authoritative combined-slab figures, current revision and matching typed-base
  expectations. It checks each Services row, pension components and surcharge
  owner, and refuses unsupported normal/mixed Services, minimum tax, ambiguous
  loss set-off and possible super-tax cases.
- Its normal-tax subtotal is not presented as complete four-source 9200 liability.
- Tests cover all 24 source permutations, four pension treatments, normal-tax zero,
  threshold boundaries, input immutability, old/wrong figures and duplicate rows.

### Verification

- New salary-rule regression initially failed **3 of 5** checks against old code;
  the same 5 checks pass after correction.
- New staged-contract suite: **11 pass / 0 fail**.
- Combined checkpoint regression: **260 pass / 0 fail**, 23 test files. The legacy
  TY2026 calculation script is one node-test file containing its own assertions;
  its internal assertions are not counted as separate node subtests in this total.
- TypeScript exit 0, all Electron JS syntax pass, diff check pass.

### Still pending — not hidden by this checkpoint

- No source-set gate or wizard route has been opened yet.
- The new builder has NOT been wired into top-level packet actions, context guards
  or desktop route selection. Pure-builder success is not packet-action success.
- Current-revision full normal/final liability and credits must be reconciled at
  integration; the approved combined line must actually be queried on Business
  packets (the existing packet action currently queries those computations only
  when there is no Business payload).
- Persisted affected mixed-income calculations/packets need freshness-policy
  enforcement before execution. Recalculate/regenerate/reapprove, never reuse
  an old approved estimate with the changed surcharge interpretation.
- Normal/mixed Services production evidence/UI/mapping remains future work.
- No commit/push, database writes, browser test or live IRIS actions.

Next implementation: top-level four-source calculation/packet integration and
freshness/desktop guards, with real-action regression fixtures before activation.


## Checkpoint 3 (16-Nov-2026): server + desktop integration, envelope-bound execution

Milestone A wiring is now in the production paths. The quadruple does NOT type anything by assumption: execution is envelope-bound end to end.

- Calculator persists a versioned policy marker on every four-income calculation line (**ty2026-salary-head-proviso-v1**). Packet generation reconciles the CURRENT revision's lines against the staged plan (normal base/tax/surcharge, services all final-tax, pension component, combined 923184 arithmetic, and the withholding/payable/refund relationship); anything stale is refused before a packet is approved.
- A new **four-income-v1** envelope is written into the snapshot (route `salary_business_pension_services`, revision, pension fingerprint, expected figures, liability). Generation writes it in the same transaction that revalidates the draft revision.
- New freshness guard `lib/tax/four-income-packet-validation.ts` runs beside the pension guard at all read surfaces: packet fetch / reuse, packet PDF, FBR dispatch, and the desktop job-context API (409 `FOUR_INCOME_REVIEW_REQUIRED`). A four-income draft never receives a packet without the contract; a stale revision, tampered contract, inconsistent liability, or excess-withholding ambiguity is refused (no repair, no guessing).
- Desktop (`electron-connect/main.js`) recognises the quadruple only behind the same contract: `getServicesPacketRoute` accepts Salary + Business + Pension + Services (TY2026 Myself) and activates the route only with `four-income-v1` whose `calculationRevision` equals the filing's revision, a present liability, AND a fully typed Business computations plan (9100>10M, integer 923184 TYPE value, no turnover row, no super-tax TYPE). Computations-tab allowlist, plan resolution, IRIS-totals readback, estimate suppression, coverage label `four_income` and Services shared-cell reporting all treat this route like the salary-business-services twin.
- Services must now pass the explicit **154A confirmation** on the export cards (`export-it-ites-pseb`, `export-services-other`); without it the Services line is priced as assessable and four-income approval is refused. Wizard copy updated.
- Regression evidence: all 147 verify-*.cjs suites were run head-to-head against a pristine 315eef0 worktree. **0 regressions**; 6 stale suites updated to the enacted TY2026 Section 4AB law (9% for any positive Salary-head, regardless of the 75% slab-table test); 31 suites still fail identically at base (Playwright browser missing, node-version drift in unrelated business/phase suites, and the ASCII wizard assertion). New suites: verify-four-income-route.cjs (7 tests), freshness refusals in verify-four-income-production.cjs (total 2 tests).
- STILL CLOSED at the live level: no supervised live IRIS run, no production database, nothing committed/pushed. Super tax / Section 113 minimum-tax / normal-or-mixed-regime Services remain explicitly refused. 9200 readback reconciliation remains pending. Every path remains fail-closed without the complete envelope.


## Checkpoint 3.1 (16-Nov-2026): synthetic test pack compatibility review

User supplied `synthetic-4head-test-pack` (TY2026 Myself, Salary+Business+Pension+Services). Analysis (see adjusted pack at /home/user/four-income-work/test-pack-adjusted/): the pack as sent targeted Milestone B (normal-tax local services, expenses deducted against Services) and carried the superseded 10% surcharge expectation. It would be REFUSED by the four-income route at Calculate/approval by design. An adjusted synthetic pack was produced (Milestone A: 154A PSEB final-tax services): services converted to export receipts (gross unchanged 3,000,000), salary/pension/business values unchanged, advance-tax debits re-set to keep chargeable == paid (6,373,100), closing chain/assets/7049/7099 recomputed, machine-readable extraction blocks added, originals untouched. Engine-verified: clause (1) 15,000,000 base, tax 5,840,000, 9% Salary-head-proviso surcharge 525,600, services final tax 7,500, pension exempt, payable 0, refund 0, reconciliation zero. 9%-vs-10% switch documented with full dependent chain. Not committed.
