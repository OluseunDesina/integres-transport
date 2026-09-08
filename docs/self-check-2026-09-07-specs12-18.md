# Self-check — 2026-09-07 — specs 12–18 (catch-up pass)

Scope: everything shipped since the last report
(`docs/self-check-2026-08-26-spec11.md`) with no self-check of its own —
specs 12 through 18 (analytics, incidents, manifest and staff booking,
plus the cross-cutting session/permission work along the way).

**What this pass is, and is not.** This is an automated verification and
open-findings-audit pass: backend suite, lint/type-check, convention
greps, OpenAPI drift, and empirical re-verification of every open
finding from the spec-11 report against current code. It is **not** a
fresh §10.3 Playwright run or a §10.6 visual iteration loop across seven
specs of screens — that is a multi-day undertaking each individual spec
already did its own pass of at slice-close time (spec 17's three slices
and spec 18's two both closed with their own Playwright + visual-loop
evidence, cited in their Implementation notes). Re-running all of that
cold, from this one sitting, would be re-deriving work already recorded
rather than checking for regressions since. What this pass adds that
those individual passes structurally could not: whether findings any of
them left open have since rotted, and whether anything slipped between
specs. Both showed real defects — see Finding 0.10.

## Status

| Area | Status | Evidence | Notes |
|---|---|---|---|
| §10.1 Angular conventions | **verified** | All eight greps run fresh; one hit (`standalone: true` in `drawer.spec.ts`, a redundant declaration on a test-only fixture component) — fixed | Every other grep: zero hits |
| §10.1 `ruff` | **verified** | `All checks passed!` | |
| §10.1 `mypy` | **verified** | `Success: no issues found in 318 source files` | |
| §10.2 Backend suite | **verified** | `1081 passed` (`--create-db`, fresh database) | Matches CLAUDE.md's stated count |
| §10.2 Required tests by name | **verified** | Cross-client isolation, concurrent seat booking (`test_exactly_one_concurrent_reservation_succeeds_for_an_overlapping_segment`), segment availability, ledger invariants (`test_ledger_invariants.py`), payment idempotency, webhook replay (`test_webhook_concurrency.py`), seat-hold expiry (`test_expire_seat_holds.py`) — all present | |
| §10.2 OpenAPI drift | **verified** | Regenerated to a scratch file and diffed against committed `openapi.yaml`: no diff | 8 pre-existing hash-named enum warnings, unchanged — see Finding 0.9 |
| §10.2 N+1 coverage | **failed** | No `django_assert_max_num_queries` test for the manifest endpoint (spec 18) or any `apps.incidents` list endpoint (spec 17) | Finding F1 |
| §10.3 Playwright | **unverified** | Not run this pass | Reason above; each spec's own Implementation note carries its own run |
| §10.4 Accessibility | **unverified** | Not run this pass | Same reason |
| §10.5 Tenancy structural enforcement | **verified** | `apps.core.tests.test_row_level_security` registry test passes; every new spec-12–18 `BaseModel` subclass is registered | |
| §10.5 Migrations additive/reversible | **verified** | Every migration since `businesses/0008` inspected; `fares/0002` and `fares/0004` are the only destructive steps (`RemoveField`/`RemoveConstraint`), both pre-dated this range and both explicitly documented as approved in their own docstrings | No new destructive migration in specs 12–18 |
| §10.6 Visual loop | **unverified** | Not run this pass | Each spec's own slices already ran it; see individual Implementation notes |
| §10.7 Report | **verified** | This document | |
| Frontend unit tests | **verified** | `1506 SUCCESS` across all 9 projects (`npm run test:all`), zero failures | |
| Frontend lint | **verified** | `ng lint` clean on all 9 projects | |

## 0. Previous report's open findings, re-verified

- **F6 (trip filter cannot reach recent trips) — closed.** `booking-list`'s
  trip dropdown is gone; spec 14 slice 3b replaced it with server-side
  search (`booking-list.spec.ts:166` documents the removal). CLAUDE.md's
  known-gaps section already reflected this; confirmed against current
  code rather than trusted from the note.
- **F6b (bounded-fetch e2e breakage) — closed**, as previously recorded.
- **F6c (the four e2e projects interfere run together) — still open.**
  Not re-run this pass (no Playwright run — see above); no code change
  in the affected specs (`kyc-queue.spec.ts`, `kyc-status.spec.ts`,
  booking specs) suggests the shared-fixture contention is unchanged.
  Carried on inspection, not fresh execution — flagged as such rather
  than claimed verified.
- **F7 (KYB queue has no search) — still open.** `kyb-queue.html`
  confirmed unchanged: no search or filter control, 25 near-identical
  rows per page. New functionality, not a defect; still out of scope for
  a self-check to build unprompted.
- **F8 (`prune_e2e_test_data` cannot clear review queues) — still open,
  deliberately carried.** `KybDocument.business` and `KycDocument`'s
  client link remain `on_delete=PROTECT`; structural, as recorded.
- **F9 (`NavShell` icon rail at 390px) — still open, deliberately
  carried.** Spec 21 owns the eventual bottom tab bar; unchanged this
  range, per CLAUDE.md's own known-gaps entry.
- **F10 (approved businesses show all-pending documents) — closed this
  pass.** See Finding 0.10 below — this was the one open finding from
  spec 11 that this pass could fix outright rather than only observe.

## 1. Findings

### 0.10 (Medium, fixed) — a decided business or client never advanced its own documents' status

`decide_business_kyb` and `decide_client_kyc` set `kyb_status` /
`kyc_status` on the parent record but never touched `KybDocument.status`
/ `KycDocument.status` — despite both document models carrying `status`,
`reviewed_by`, `reviewed_at` and `rejection_reason` fields that exist
for exactly this. The result, exactly as spec 11's F10 recorded it: an
approved business's document list in `business-kyb.html` rendered every
document `pending` forever, because nothing ever moved it off the
default.

This was recorded as an accepted backend-semantics gap in the spec-11
report specifically because §10.6.3 bars fixing backend semantics inside
a visual-iteration loop. Outside that loop, it is an ordinary bug: two
fields that exist on the model and are never written.

Fixed in both `decide_business_kyb` (`apps/businesses/services.py`) and
`decide_client_kyc` (`apps/clients/services.py`), inside the same
`select_for_update()` transaction each already opens: on a decision,
every currently-`pending` document for that business/client is bulk
`.update()`d to the decision's outcome, with `reviewed_by`/`reviewed_at`
set and `rejection_reason` carried for a rejection. Deliberately scoped
to `pending` documents only — a document from an earlier rejected round
keeps recording that rejection rather than being silently relabelled by
a later approval, which the resubmit-then-reapprove test now asserts
explicitly (both `test_full_create_reject_resubmit_reapprove_flow` and
its client-side twin).

Six new assertions across `test_kyb_queue.py` and `test_kyc_queue.py`,
all passing. Full suite still 1081/1081; `ruff`/`mypy` clean.

### F1 (Low) — no query-count regression test for the manifest or incidents list endpoints

`docs/self-check.md` §10.5 asks for a query-count assertion on every
list endpoint. `TripManifestView` (spec 18) already batches its lookups
(`select_related` sized to what each row reads, a single batched
`_reservations_by_booking` query rather than one per booking) and reads
as N+1-safe on inspection, but has no `django_assert_max_num_queries`
test proving it stays flat as ticket/booking counts grow — the same gap
exists for `apps.incidents`'s list endpoints (spec 17). Not a known
defect, since the implementation already looks correct; a coverage gap
that would only surface a regression, not a currently-wrong count.

### F2 (trivial, fixed) — a test-only component declared `standalone: true`

`shared-ui/drawer.spec.ts`'s `OpenerHost` fixture explicitly set
`standalone: true`, redundant since Angular 20 (the one hit across all
eight §10.1 convention greps). Removed; test suite unaffected.

## 2. Deviations from the brief

None found in specs 12–18 beyond what each spec's own Implementation
note already declares. This pass's scope (automated checks + prior
findings) is not positioned to catch a new design deviation the way
§10.6's visual loop or a fresh Playwright run would — see the named 5%.

## 3. The named 5%

- **No Playwright run this pass**, across any of the four apps, for any
  of specs 12–18's flows. Each spec closed with its own run at slice
  time; nothing here re-confirms those still pass together, and F6c
  already establishes that "green per project" and "green run together"
  are different claims.
- **No §10.6 visual iteration loop this pass.** A visual regression
  introduced by an unrelated later change (a shared `ui-*` component
  edit, a Tailwind token change) would not be caught by anything in this
  report.
- **F1's manifest/incidents N+1 gap is inspection, not proof.** Reading
  the query pattern is not the same as measuring it under a realistic
  row count; the KYB/KYC queues' own N+1 fixes were found by exactly the
  measurement this pass didn't run for these two.
- **F6c is carried on inspection.** No project's e2e fixtures were
  re-run together this pass; "unchanged code" is a reasonable but not
  conclusive basis for "still open."
- **The enum-naming debt (8 hash-named enums, unchanged) is accepted,
  not re-litigated.** `docs/status.md` already records this as a
  deliberate, tracked condition (`StatusD05Enum` and eleven siblings);
  this pass confirmed the count didn't grow, not that it should shrink.

## 4. Confidence

| Module | Confidence | Where it is lowest |
|---|---|---|
| Backend correctness (specs 12–18, automated) | **High** | 1081/1081, ruff/mypy clean, no drift |
| KYB/KYC document status on decision | **High** *(was: known gap)* | Newly tested both directions (approve, reject) and across a resubmit cycle |
| Frontend unit correctness | **High** | 1506/1506, lint clean on all 9 projects |
| Cross-app e2e interaction (specs 12–18) | **Low** | No Playwright run this pass; F6c's shared-fixture risk is unmeasured here |
| Visual/accessibility state of specs 12–18 screens | **Low** | No §10.6 loop this pass; relying entirely on each spec's own closing evidence |
| Manifest/incidents query-count safety under load | **Medium** | Batched by inspection, unmeasured by test (F1) |

Lowest confidence is the same place recurring self-checks in this repo
have always found it: whatever this pass did not actually execute.
Recommended next: a Playwright run across all four projects (with
`--project=`, per the standing trap) against current `main`, which would
close both the F6c re-verification gap and the Playwright-coverage gap
in one pass.
