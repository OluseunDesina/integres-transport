# Self-check — Phase 4 frontend addendum (booking flow) — 2026-08-14

Scope: everything found in the working tree when this session began
verifying `docs/specs/4-fares-seating-booking-frontend.md` — the backend
gap-fill (`GET /routes/browse/`, `GET /trips/search/`,
`BookingSerializer.trip` nesting) and all 4 frontend slices
(customer-app shell/trip-search/seat-picker/booking-confirm/my-bookings,
client-admin-app bookings-list) — plus a substantial **unspec'd**
fare-versioning/price-snapshot feature discovered mid-check and
retroactively documented this session at
`docs/specs/4-fares-seating-booking-versioning.md`. Unlike every prior
self-check in this repo, this one did not follow "verify what was just
built in this session" — the code already existed, built without the
spec's own stop-and-review checkpoints; this report's job was to find
out what's actually true about it before anything gets called "done."

## 10.7 Report table

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Angular v20 convention greps (§10.1) | verified | All 11 greps clean except the same 2 pre-existing documented `@HostListener`s in `nav-shell.ts` and the generated `@example` URLs in `schema.ts` — both already named by Phase 2/3's own reports | |
| `OnPush` on every new component | verified | All 6 new components (`AppShell`, `TripSearch`, `SeatPicker`, `BookingConfirm`, `MyBookings`, `BookingList`) confirmed via direct grep | |
| `ngModel` audited | verified | 2 new files use it (`trip-search.html`, `booking-list.html`) — both the documented CVA-has-no-native-output exception this codebase already established | |
| Money/`Decimal`/UTC conventions | verified | `SeatReservation.amount`, `Booking.currency` both new and correctly `Decimal`/`CharField`+adjacent-currency; no float touches money anywhere in the new code | |
| Backend `ruff check apps config` / `mypy apps config` | verified | `All checks passed!` / `Success: no issues found in 169 source files` | |
| Backend `pytest` suite | verified | **346 passed**, 98% coverage (`--cov=apps`) — up from 303 at the end of the last recorded Phase 4 backend slice; growth is the gap-fill + the previously-unspec'd fare-versioning work | Required a real, reproducible fix along the way — see Finding 1 |
| Cross-client isolation, per new endpoint | verified | `test_route_browse.py`/`test_trip_search.py` each have a dedicated cross-client-404 test; fare-versioning's endpoints inherit the existing `fares`/`seating` isolation tests | |
| Concurrent seat booking | verified, pre-existing | `apps/seating/tests/test_seat_concurrency.py` — unchanged, still passing, ADR-0004 still Accepted | |
| Segment-aware availability | verified, pre-existing | Unchanged from Phase 4 backend | |
| Ledger invariant | not applicable at this phase | No ledger exists yet (Phase 5+). Closest analogue — `test_editing_a_fare_after_a_booking_leaves_the_snapshot_untouched`, the fare-versioning suite's own money-immutability regression test — is present and passing | |
| Payment idempotency | not applicable at this phase | No payments yet. `Idempotency-Key` on `POST /bookings/` (pre-existing) still tested and passing | |
| Webhook replay | not applicable at this phase | No webhooks exist yet | |
| Seat-hold expiry | verified, pre-existing | `test_expire_seat_holds.py` unchanged, still passing | |
| OpenAPI spec regenerates with no diff | verified | `check_openapi_drift.sh` → clean; `npm run openapi:check` → clean, 0 drift | Same 4 pre-existing enum-naming warnings, no new ones |
| Query counts on new list endpoints | verified, 1 gap named | `GET /routes/browse/` (`assert_max_num_queries(8)`), `GET /bookings/mine/`+`GET /bookings/` (`assert_max_num_queries(12)` each) all have dedicated tests. **`GET /trips/search/` has no dedicated query-count test** — named in §3 | |
| Migrations additive and reversible | verified, 1 real deviation named | Gap-fill: fully additive, no new migrations at all (view-layer only). **Fare-versioning is not additive-only** — `RemoveField(FareRule, "is_active")` and `RemoveConstraint(...)` are destructive, already applied to the dev DB. Documented explicitly, not silently — `docs/specs/4-fares-seating-booking-versioning.md` §7 | |
| Playwright e2e, new specs (§10.3) | verified | `customer-app/booking.spec.ts` (5 tests) and `client-admin-app/bookings.spec.ts` (2 tests) written this session, stable across 3+ consecutive runs after fixing 4 real bugs in the tests themselves (Findings 3–5, 8) | |
| Playwright e2e, full suite | verified, with a sandbox caveat | Full suite at max parallelism showed 27 failures — diagnosed as sandbox resource contention (isolated re-runs of the same specs passed cleanly), not real regressions. A `--workers=2` run is the trustworthy signal: **87 passed**, 1 real regression found and fixed (Finding 6), 3 failures confirmed as the pre-existing, already-documented Business-accumulation gap (Finding 7, unrelated to this work) | Named in the 5% below |
| Accessibility — axe on every new page/state (§10.4) | verified | Every screen the new e2e specs reach is axe-checked: trip-search (filled/results/empty-results), seat-picker (populated/one-selected), booking-confirm, my-bookings (populated/cancel-dialog), client-admin booking-list. Zero violations after Finding 5 | |
| Keyboard-only completion | verified | Dedicated test drives the full search → seats → confirm flow via `focus()`+`Enter` only | |
| Focus restoration | verified | Escape-dismiss-restores-focus test for the cancel dialog, reusing `kyc-queue.spec.ts`'s established pattern | |
| Tenancy enforced structurally, `all_objects` audited (§10.5) | verified, 1 pre-existing finding unchanged | `grep -rn "\.all_objects\."` across `network`/`scheduling`/`booking`/`fares`/`seating` (excl. tests) → every hit is an established, precedented pattern (`select_for_update()` row-locks, Celery-task `platform_staff_bypass()` reads) plus the same pre-existing `apps/scheduling/services.py:123` inconsistency Phase 3's self-check already reported and deliberately left unfixed | |
| No secrets committed | verified, same caveat as every prior report | `.env` correctly `.gitignore`d; repo still has zero commits, so this confirms `.gitignore` correctness only | |
| Rate limiting | verified, unchanged | No new auth-adjacent endpoints; local settings' widened throttle unchanged | |
| Audit records | verified | Gap-fill endpoints are reads (no audit expected, confirmed). Fare-versioning's `create_fare_rule`/`supersede_fare_rule`/segment equivalents all call `record_audit_event` — 6 call sites confirmed | |
| Visual iteration loop (§10.6) | verified, full rigor, 2 iterations | 36 screenshots × 2 iterations across 12 states at 390/768/1440px, all opened and reviewed. 1 real defect found and fixed (`ui-select` missing `w-full`, causing overflow on the mobile-authoritative viewport once accumulated test data produced long option text) — a shared-component-level fix benefiting every consumer, same class as Phase 3's `ui-table` fix. 2 more candidate defects investigated and disproved as false positives via live measurement rather than accepted from a screenshot/test failure alone. Full detail: `docs/ui-review/4-fares-seating-booking-frontend/iteration-2.md` | |

## Findings, ordered by severity

1. **[Reported, not "fixed" — a process finding, the most consequential item in this report] The entire scope of work — the spec'd backend gap-fill, all 4 spec'd frontend slices, *and* a substantial, wholly unspec'd fare-versioning/price-snapshot feature including destructive migrations already applied to the dev database — was built in one pass by an external tool (Cursor) with no stop-and-review checkpoint, contrary to both the spec's own §9 and this repo's working agreement.** The fare-versioning work is good, tested, working code — that's not in question — but it shipped without a spec, without an ADR discussion, and with destructive schema changes, discovered only because this self-check went looking. Handled this session: retroactively spec'd at `docs/specs/4-fares-seating-booking-versioning.md`, folded into this report's scope per explicit user direction. Nothing here should be read as "therefore fine" — it's reported so the gap in process (not code) is on the record.
2. **[Fixed, real bug, found running `seed_e2e_users` for verification, not guessed at] `apps/network/services.py::set_route_stops` used `RouteStop.objects` (tenant-scoped) instead of `RouteStop.all_objects` for its delete-then-recreate, breaking under `apps.core.rls.platform_staff_bypass()`** (a management-command caller) — the bypass only changes Postgres GUCs, not the Python contextvar `TenantScopedManager` reads, so the delete silently matched zero rows and the recreate collided with the still-present old rows on `unique_route_stop_sequence`. This made `seed_e2e_users` non-idempotent on a second run against an already-seeded database, contradicting its own docstring's promise. Fixed: switched to `RouteStop.all_objects`, safe because `route` is already a legitimately-held instance, not a re-derived tenancy filter. 346/346 backend tests still pass; `seed_e2e_users` now genuinely idempotent, confirmed by running it twice.
3. **[Fixed, real UI bug, found via live measurement not screenshot judgment] `shared-ui`'s `ui-select` had no `w-full` on its native `<select>`, so it sized to its longest `<option>`'s content rather than its container.** Surfaced at the 390px authoritative viewport once this session's own extensive e2e runs had accumulated several long-named Routes under the shared test Client — `trip-search`'s Route picker rendered at 790px inside a 358px container. Fixed at the shared-component root (one class added); re-verified via `scrollWidth`/`clientWidth` equality, the shared-ui Karma suite (39/39), and every affected e2e spec. Benefits every `ui-select` consumer app-wide, not just this module.
4. **[Fixed, stale test, not a product regression] `customer-app/login.spec.ts` asserted on placeholder text ("You have customer-app access.") that the legitimate, in-scope home-screen redesign (§4.1 of the frontend spec — a real "Welcome, {email}" + "Search trips" CTA) removed.** The redesign is correct and intentional; the test was stale. Updated the assertion to check for the new "Search trips" button instead.
5. **[Fixed, 2 test bugs, both in code this session wrote] The new `customer-app/booking.spec.ts` had: (a) an axe check that ran immediately after the CDK dialog's `toBeVisible()` resolved, catching the danger button mid-entrance-transition and reporting a false-positive contrast violation** (live-measured: settles to solid white-on-red, well above 4.5:1, within ~100ms) — fixed by adding a 200ms wait before the axe assertion, with the false-positive reasoning recorded inline; **and (b) a `pickFirstAvailableSeat()` helper that picked the positionally-first seat button without checking it was enabled**, which broke once several tests in the file started sharing the seeded fixture's 6 seats — fixed by filtering to `button:not([disabled])`, and the whole `describe` block was set to `serial` mode (matching `kyc-queue.spec.ts`'s own precedent) since several tests share one seeded Trip's limited seat pool.
6. **[Fixed, test-design flaw, same session] `client-admin-app/bookings.spec.ts`'s trip-filter test matched the Trip `<select>`'s option by label text and used a far-future random date** — both fragile: label text collides once two trips share a route+date (increasingly likely as test data accumulates), and `booking-list.ts`'s `loadTripOptions()` is deliberately unpaginated (`limit=100`, earliest-by-date), so a far-future date can sort past position 100 and simply never appear. Fixed: match by the trip's unique `value` (its id) instead of label, and use a near-term date (2–7 days out) that reliably sorts within the first 100.
7. **[Reported, not fixed — pre-existing, unrelated to this module, confirmed still present and worse] The `SelectedBusinessStore`/KYB-queue Business-accumulation gap Phase 3's self-check first documented (Finding #5) is confirmed still present, and the same root cause now also affects the client-admin Trip-filter picker.** Business count for the e2e Client is now 140 (up from 114 when Phase 3's report was written); Trip count is 117. Both `SelectedBusinessStore` and `booking-list.ts`'s `loadTripOptions()` fetch an unpaginated `limit=100` — either can silently omit a real row from a picker once enough test data accumulates. Not fixed here either, for the same reason Phase 3's report gave: fixing it means either an arbitrary limit bump or a destructive test-data reset, neither authorized without being asked. Worth surfacing as a real, recurring pattern now hitting a second picker, not a one-off.
8. **[Investigated, disproved as a false positive, not fixed — recorded so a future reader doesn't re-chase it] `document.documentElement.scrollWidth` reported 556px on `my-bookings` at the 390px viewport, and a `fullPage: true` screenshot reflected it.** Full ancestor-chain live measurement (`getBoundingClientRect()` from the `<table>` up to `<html>`, `document.body.scrollWidth`, and a plain non-full-page screenshot) all confirmed the real, visible layout is exactly 390px with no horizontal scrollbar — a Chromium quirk where `documentElement.scrollWidth` (but not `body.scrollWidth`) includes a nested `overflow-x-auto` table's un-scrolled content even though nothing is actually visible outside the viewport. Full detail in `docs/ui-review/4-fares-seating-booking-frontend/iteration-2.md`.

## 1a. Visual iteration log

Full detail: `docs/ui-review/4-fares-seating-booking-frontend/iteration-2.md`.
Summary: 2 iterations, 36 screenshots each (12 states × 390/768/1440px),
all opened and reviewed. Iteration 1 found the `ui-select` overflow
(Finding 3) and 2 candidate defects that live measurement disproved
(Findings 8, and the axe-timing issue folded into Finding 5). Iteration 2,
post-fix, is clean and promoted to `baseline/`. Closed on criteria met,
not the 5-iteration cap.

## 2. Deviations from the brief

- **The fare-versioning/price-snapshot feature itself is the primary
  deviation** — see Finding 1. Retroactively specified this session at
  `docs/specs/4-fares-seating-booking-versioning.md`, which also documents
  its own smaller deviations (PATCH-as-supersede rather than in-place
  edit, no new permission codename despite the semantic change) inline.
- **Component file layout**: the frontend spec's prose implied a
  directory-per-component layout (`trip-search/seat-picker`); what's
  built is flat files under `trip-search/`/`booking/` (`trip-search.ts`,
  `seat-picker.ts`, etc.) — consistent with how other flat components in
  this codebase are laid out (e.g. `app-shell.ts` itself). A naming/layout
  reading difference, not a functional one.
- Otherwise, the backend gap-fill and all 4 frontend slices match
  `docs/specs/4-fares-seating-booking-frontend.md` closely — the two
  independent audits that preceded this report found zero code-level
  deviations on those parts.

## 3. The named 5%

- **`GET /trips/search/` has no dedicated query-count regression test** —
  unlike its sibling `GET /routes/browse/` and the two `GET /bookings/...`
  endpoints. Low risk (it's a single-model list, no deep nesting beyond
  what `TripSerializer` already covers elsewhere), but not proven the
  way the others are.
- **Fare-versioning's backfill migration heuristic
  (`seating/migrations/0004`) has never run against real historical
  data** — this repo has zero git commits and no production history, so
  the "divide total evenly across seats, synthesize a covering
  `FareRule` if no match" logic is untested against a real messy dataset.
  Flagged in its own spec (§1), repeated here since it's still true.
- **The full e2e suite is only trustworthy at reduced parallelism in this
  sandbox.** A `--workers=2` run is the evidence in this report; a full
  max-parallelism run shows transient, environment-caused failures that
  are not real regressions (verified via isolated re-runs) but would be
  confusing noise for anyone running the suite the same way without this
  context. If CI is ever actually turned on (it still has never run — see
  below), its own concurrency needs the same consideration.
- **The CI workflow has still never actually run** — same gap every
  prior phase's report has named, still true.
- **The repo still has zero git commits** — unchanged since Phase 0, and
  now carrying more weight: a substantial amount of real, working,
  previously-unreviewed code (this entire module plus the fare-versioning
  feature) exists nowhere but this working tree.
- **`my-bookings`/`booking-list`'s stress-test content (61/60 rows) was
  incidental** (this session's own accumulated test runs), not a
  deliberately engineered stress case (extremely long route/stop names,
  a maximum-precision fare amount). It rendered fine, but a future round
  should stress it on purpose rather than by accident.

## 4. Honest confidence per module

- **Backend gap-fill (`GET /routes/browse/`, `GET /trips/search/`,
  `BookingSerializer.trip` nesting)**: high confidence. Matches spec
  exactly, thorough tests, clean static analysis, real pytest run (not
  just read) at 346/346.
- **Fare-versioning/price-snapshotting**: high confidence *functionally*
  — the test suite includes the exact regression test that justifies the
  feature's existence (`test_editing_a_fare_after_a_booking_leaves_the_snapshot_untouched`),
  and every code-level claim checked out. Medium confidence *procedurally*
  — it shipped without review, and this report is the first time anyone
  has looked at it against a spec.
- **customer-app booking flow**: high confidence after this session. One
  real, shared-component-level UI bug found and fixed; full e2e,
  accessibility, and keyboard coverage now exists where none did before
  this report started.
- **client-admin-app bookings screen**: high confidence. List-only
  behavior verified structurally (a real assertion that zero buttons
  render in any row, not just "not tested"), filtering verified against
  a real seeded booking.
- **Overall**: the module itself meets the ~95% bar this repo holds
  every phase to. The residual risk this report surfaces is not really
  about whether the code works — it does — it's that a meaningful amount
  of it (the entire frontend addendum, plus an entire additional
  unplanned feature) reached this state without the review checkpoints
  the working agreement exists to provide, and it's sitting in a
  never-committed working tree. Those are the two things worth acting on
  next, not further technical polish.
