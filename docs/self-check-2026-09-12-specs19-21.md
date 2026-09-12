# Self-check — 2026-09-12 — specs 19–21 (catch-up pass)

Scope: everything shipped since the last report
(`docs/self-check-2026-09-07-specs12-18.md`) with no self-check of its
own — specs 19 (route lifecycle), 20 (live operations, four slices) and
21 (passenger experience, three slices), which together close the
entire Transit OS adoption roadmap.

**What this pass is, and is not.** Same shape as the specs 12–18
catch-up: automated verification (backend suite, lint/type-check,
convention greps, OpenAPI drift, migration and RLS audit) plus
empirical re-verification of every open finding from that report
against current code. It is **not** a fresh §10.3 Playwright run across
all four projects together, nor a fresh §10.6 visual loop — each of the
nine slices across these three specs already ran its own Playwright
suite and visual-iteration loop at close time (cited in their own
Implementation notes), and re-running all of that cold would re-derive
recorded work rather than check for regression since. What this pass
adds that those individual passes structurally could not: whether
findings any of them left open have since rotted, and whether anything
slipped between specs. It found one of each — see Finding 1 and
Finding 0.F9 below.

Working tree note: all nine slices are present but **uncommitted**
(`git status` shows 48 changed/new paths on top of `main` at `e221594`,
"Development up to spec 20" — spec 21's three slices were never
committed). This report checks the working tree as it stands, which is
the only copy of specs 20's slice 4 and all of spec 21 that exists.

## Status

| Area | Status | Evidence | Notes |
|---|---|---|---|
| §10.1 Angular conventions | **verified, one fixed** | Seven of eight greps: zero real hits. `@HostBinding`/`@HostListener`: 4 hits (`notification-bell.ts`, `nav-shell.ts`) — fixed, see Finding 1. `ngClass`/`ngStyle` and `: any` greps returned lines, both false positives on inspection (see Finding 2) | `standalone: true`, `.component.ts`, `@Input()`/`@Output()`, `.mutate(`, deep relative imports, `@ngrx`: all zero |
| §10.1 `ruff` | **verified** | `All checks passed!` | |
| §10.1 `mypy` | **verified** | `Success: no issues found in 343 source files` | |
| §10.2 Backend suite | **verified** | `1178 passed in 84.77s` (`--create-db`, fresh database) | Matches CLAUDE.md's stated count |
| §10.2 Required tests by name | **verified** | Route lifecycle guards (`test_route_lifecycle.py`: all four transition tests, duplicate semantics, cross-client 404s), telemetry idempotency (`test_duplicate_batch_is_ignored_not_double_written`), live-state advance guard (`test_live_state_does_not_move_backwards_on_an_out_of_order_batch`), the vehicle-reuse position leak (`test_live.py:412`), hold-countdown fields (7 named tests in `test_booking.py`), activity feed ordering/isolation (`test_activity.py`) — all present and passing | |
| §10.2 OpenAPI drift | **verified** | Regenerated to a scratch file and diffed against committed `openapi.yaml`: no diff | 9 enum-naming warnings today (5 hash-named `status`, 1 hash-named `source`, 3 "multiple names for one choice set"); the prior report's own cross-reference for this ("see Finding 0.9") points at a finding that does not exist in that report or its predecessor — a broken pointer, not a re-verifiable count. Not re-litigated; see Finding 2 |
| §10.2 N+1 coverage | **still failed** (carried) | No `assert_num_queries`-style test for `TripManifestView` or any `apps.incidents` list endpoint | F1, unchanged since 09-07 |
| §10.3 Playwright | **unverified** | Not run this pass | Reason above; each slice's own Implementation note carries its own run |
| §10.4 Accessibility | **unverified** | Not run this pass | Same reason |
| §10.5 Tenancy structural enforcement | **verified** | `apps.core.tests.test_row_level_security` passes; every `all_objects` use in `apps.network`/`apps.telemetry` is inline-documented as deliberate (device auth precedes any tenancy context; route duplication/deletion needs a real `Route.all_objects.create`) rather than a silent bypass | |
| §10.5 Audit trail on privileged actions | **verified** | `set_route_status`/`duplicate_route` (`apps/network/services.py`) and `issue_device`/`update_device` (`apps/telemetry/services.py`, covering revoke and reassign) all call `record_audit_event` | |
| §10.5 Migrations additive/reversible | **verified** | Every migration file in the repo scanned for `RemoveField`/`RemoveConstraint`/`DeleteModel`/`RemoveIndex`: only `network/0009_drop_route_is_active` (spec 19, deliberately unapplied — confirmed `showmigrations --plan` names it as the *only* unapplied migration anywhere) and the pre-existing, pre-dated `fares/0002` | Matches the roadmap's own "Destructive steps in this arc" table exactly: one entry, spec 19 |
| §10.6 Visual loop | **unverified** | Not run this pass | Each slice's own visual-iteration log already exists; see individual Implementation notes |
| §10.7 Report | **verified** | This document | |
| Frontend unit tests | **verified** | `1633 SUCCESS` across all 9 projects (`npm run test:all`): 273/728/90/63/354/22/51/49/3 | Matches CLAUDE.md's stated count exactly |
| Frontend lint | **verified** | `ng lint` clean on all 9 projects (looped individually, no combined target) | |
| Frontend/backend schema sync | **verified** | `npm run openapi:check` → `api-client schema.ts matches backend/openapi.yaml.` | |

## 0. Previous report's open findings, re-verified

- **F1 (no N+1 test for manifest/incidents list endpoints) — still
  open, unchanged.** Neither `apps/booking/tests/test_manifest.py` nor
  any file under `apps/incidents/tests/` contains
  `assert_num_queries`/`assert_max_num_queries`. Specs 19–21 added their
  *own* new list endpoints with this coverage from the start
  (`test_route_browse.py`, `test_booking_list_query_count_...`,
  `test_bookings_mine_query_count_...`) — the gap has not grown, but it
  has not shrunk either.
- **F2 (`standalone: true` on a test fixture) — still closed.** Fresh
  grep, zero hits.
- **F6c (four Playwright projects interfere run together) — still
  open, carried on inspection.** Not re-run this pass (no Playwright
  run — see above). The two spec-12–18 fixtures named as contending
  (`kyc-queue.spec.ts`/`kyc-status.spec.ts`) are untouched by specs
  19–21; the newly-modified e2e specs (`booking.spec.ts`,
  `open-seating.spec.ts`, `trip-tracking.spec.ts`, all `customer-app`)
  are a different app's fixtures. Reasonable but not conclusive basis
  for "still open, unchanged" — same caveat the 09-07 report gave.
- **F7 (KYB queue has no search) — still open, unchanged.**
  `super-admin-app/src/app/kyb-queue/kyb-queue.html` confirmed to still
  have no search or filter control. New functionality, not a defect.
- **F8 (`prune_e2e_test_data` cannot clear review queues) — still open,
  deliberately carried.** `KybDocument.business` confirmed still
  `on_delete=models.PROTECT`; structural, unchanged.
- **F9 (`NavShell` icon rail at 390px on every client-admin screen) —
  still open, and it had quietly fallen off tracking.** The 09-07
  report carried this as "deliberately carried... spec 21 owns the
  eventual bottom tab bar" — but spec 21's own three Implementation
  notes show it never touched `NavShell`: slice 1 rebuilt
  `customer-app`'s `AppShell` (a different component, in a different
  app) into a fixed bottom tab bar, and `NavShell` — the component F9
  actually names, shared by `client-admin-app`/`super-admin-app` — is
  absent from all three slices' file lists. Separately, `docs/traps.md`'s
  "Known gaps" section, rewritten during spec 21 slice 1 to record the
  *other* nav (`validator-app`'s, explicitly distinguished from
  `customer-app`'s newly-fixed one), no longer mentions `NavShell` or
  F9 at all — a real instance of the exact rot §10.7 exists to catch:
  nobody removed it on purpose, it simply stopped being copied forward.
  Confirmed still present in the code (`nav-shell.ts`'s icon rail is
  unchanged) and restored to `docs/traps.md` by this report, with the
  stale "spec 21 owns this" note corrected — the roadmap has no further
  spec, so as of this report it is unowned. Added to CLAUDE.md's Next
  line alongside the other three named gaps.

## 1. Findings

### Finding 1 (trivial, fixed) — `@HostListener` in two shared components

`grep -rn "@HostBinding\|@HostListener" projects/` returned zero hits
in the 09-07 report and four in this one:
`projects/layout/src/lib/notification-bell.ts` and
`projects/layout/src/lib/nav-shell.ts`, one `document:click` and one
`document:keydown.escape` listener each. Both files carry only the
single commit `e221594` ("Development up to spec 20") in their history,
so the exact slice that introduced them cannot be dated more precisely
than "somewhere in the specs 19–21 range" — but the convention
(`host` object, not the decorators) was clean as of the last report and
is not now.

Fixed in both files: the two `@HostListener`-decorated methods became
plain methods, and their bindings moved into the existing `host: {...}`
object each component already had (for its own `class`), e.g.
`'(document:click)': 'onDocumentClick($event)'`. No behavioural change
— `layout`'s own unit suite (49/49) re-run clean after the edit, and
the fresh grep now returns zero hits, matching every other project's
convention grep.

### Finding 2 (non-issue, recorded to close it out) — two grep hits that are not violations

- The `ngClass`/`ngStyle` grep matched
  `trip-list.html:377,379` — but the actual text is `[ngModel]` /
  `(ngModelChange)` bound to `pendingClass()`; the word "pending**ngC**lass"
  contains the literal substring "ngClass" by coincidence of English
  spelling, not a real `ngClass` directive. Confirmed with `grep -o`
  isolating the exact match. The `[ngModel]`/`ngModelOptions: {
  standalone: true }` pattern itself is a pre-existing, already-reviewed
  choice from spec 15 slice 2 (a dialog-scoped value picker with no
  surrounding `<form>`), not new to specs 19–21 and not what this grep
  is meant to catch.
- The `: any` grep matched a doc comment repeated across nine form
  components ("Every field, not just those with a validator: **any** of
  them can ..."), which contains the literal substring `: any` in
  ordinary English prose, not a TypeScript `any` type annotation. No
  real `: any`/`<any>`/`as any` usage exists in `projects/`.

Both are grep false positives rather than code issues; recorded so a
future report does not need to re-derive this.

## 2. Deviations from the brief

None found beyond what each spec's own Implementation note already
declares (spec 19's migration-4 deferral, spec 20's `DeviceTokenAuthentication`
fix and `SETTINGS_MODULE` env-var read, spec 21's four visual-pass
findings — all previously recorded in their own specs per CLAUDE.md
rule 6). This pass's scope is not positioned to catch a *new* design
deviation the way a fresh Playwright run or visual loop would.

## 3. The named 5%

- **No Playwright run this pass**, across any of the four apps, for any
  of specs 19–21's flows together. Each spec closed with its own run at
  slice time; nothing here re-confirms those still pass run together,
  and F6c already establishes that "green per project" and "green run
  together" are different claims.
- **No §10.6 visual iteration loop this pass.** A visual regression from
  an unrelated later change to a shared `ui-*` component would not be
  caught by anything in this report. `ui-map`'s marker-popup contrast
  gap and `ui-table`'s Senior Mode density gap (both already named in
  `docs/traps.md`) are exactly this class of thing and remain unverified
  here beyond the inspection each was already given at slice-close time.
- **F1's manifest/incidents N+1 gap is inspection, not proof** — carried
  unchanged a second report running.
- **F6c is carried on inspection a second time.** No project's e2e
  fixtures were run together this pass either.
- **The exact provenance of Finding 1's `@HostListener` regression is
  unknown** — three specs and nine slices share one squashed commit, so
  "introduced sometime in this range" is as precise as the evidence
  allows. If a future audit needs to know which slice, it is not
  recoverable from `git log` alone.
- **The enum-naming warning count (9 today) is reported, not
  reconciled against the prior report's "8"** — that report's own
  pointer to a supporting finding is broken (see the OpenAPI drift row
  above), so there is nothing to diff against. The schema itself has
  zero drift from what is committed, which is the claim that actually
  matters.

## 4. Confidence

| Module | Confidence | Where it is lowest |
|---|---|---|
| Backend correctness (specs 19–21, automated) | **High** | 1178/1178, ruff/mypy clean, no OpenAPI drift, migration sweep clean |
| Tenancy and audit on new privileged actions (route lifecycle, device management) | **High** | RLS registry test passes; every `all_objects` use and every privileged mutation inspected by name |
| Frontend unit correctness | **High** | 1633/1633, lint clean on all 9 projects |
| Frontend convention compliance | **High** *(was: one regression)* | Finding 1 fixed and re-verified; both other grep hits confirmed as false positives, not carried forward as uncertainty |
| Cross-app e2e interaction (specs 19–21) | **Low** | No Playwright run this pass; F6c's shared-fixture risk is unmeasured here, same as last report |
| Visual/accessibility state of specs 19–21 screens | **Medium** | No fresh §10.6 loop, but unlike the specs 12–18 range, spec 21 slice 3 ran a genuine dual-mode visual pass across 16 screens within the last few days — closer in time than "trust the Implementation note" usually is |
| Manifest/incidents query-count safety under load | **Medium** | Unchanged from last report: batched by inspection, unmeasured by test (F1) |
| Tracking hygiene (open findings staying visible across reports) | **Medium** *(was: the thing that caused F6's four-spec drift)* | F9 caught and restored this pass; the mechanism that let it drop (a "Known gaps" rewrite during slice work, not during a self-check) is still not report-gated the way spec closure now is |

Lowest confidence is again whatever this pass did not execute:
Playwright and the visual loop. Recommended next, unchanged from the
prior report's own recommendation: a Playwright run across all four
projects (`--project=`, per the standing trap) against current `main`
(or this uncommitted tree), which would close F6c's re-verification gap
in the same pass a genuine cross-spec regression check requires.
