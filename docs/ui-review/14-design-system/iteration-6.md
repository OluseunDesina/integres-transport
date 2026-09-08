# Spec 14 Slice 3b — visual review

Captured 2026-08-31 via `e2e/ui-review-capture.ts`
(`UI_REVIEW_DIR=… npx playwright test --project=client-admin-app --grep @ui-review`),
at 390 / 768 / 1200.

- **`iteration-6/`** — the transactional lists as first built.
- **`iteration-7/`** — after the fixes below.

The capture list gained `fares`, `tap-go`, `ledger`, `wallet` and
`businesses`; it already carried `trips`, `bookings` and `staff`.

## Findings

### F1 — Fixed: pay-as-you-go rendered a search box that did nothing

`iteration-6/client-admin-app/tap-go-1200.png`. The screen showed a
labelled **"Search journeys"** input with a magnifying glass, and typing
into it changed nothing: `GET /fare-journeys/` has no free-text filter,
and the template bound no `searchChange` handler. My own comment in that
template read "No search box" directly above the markup that rendered
one.

This is precisely the failure this slice exists to prevent — a control
that looks like it worked. It is the same shape as the bounded search
that made `?search=` a backend prerequisite in the first place, arrived
at from the opposite direction.

Fixed with a `showSearch` input on `ui-filter-bar` (default `true`), set
`false` on pay-as-you-go and on the ledger. The bar still renders its
filters and chips; it just stops promising a search that does not exist.

### F2 — Fixed: status pills wrapped to two lines

`iteration-6/client-admin-app/bookings-1200.png`. "Pending payment" in
the narrow bookings status column wrapped, and a `rounded-full` pill
that wraps reads as a broken shape rather than a status. `ui-status-pill`
now keeps its label on one line.

### F3 — Fixed, carried over from 3a: filter-bar label alignment

3a recorded (F2 there) that the search input's label was `sr-only` while
the selects beside it rendered visible labels, leaving the two at
different heights. 3b puts up to four controls in these bars — on
`trip-list`, route, schedule, service date and status — which is where
it stopped being cosmetic. The search label is visible now and the row
aligns on one baseline.

### F4 — Recorded, not fixed: the trips filter row wraps below its search

`iteration-7/client-admin-app/trips-1200.png`. With four filters plus a
capped search box the flex row wraps, leaving whitespace to the right of
the search. It reads correctly and every control is reachable; tightening
it means either uncapping the search (which 3a fixed for a reason) or a
grid, and that is a layout decision worth making with the mobile slice
rather than twice.

### F5 — Recorded, not fixed: tables still overflow at 390px

Unchanged from 3a's F3 and iteration-2's F5, and **identical in the
baseline**. Its own slice, after this one, per decision.

## Confirmed working

- **Bookings is scoped to the active Business** — 219 rows for the
  fixture Business rather than every Business under the Client.
- **Staff renders role and status read-only**, with both changes behind
  the row menu and a confirmation.
- **Trips renders vehicle and driver read-only**, with assignment in a
  drawer that saves both fields in one request.
- **The ledger keeps its `ui-stat` balance card** above the entries
  table, now with density and a sticky header.
- **`wallet-lookup`** was the last client-admin screen with a
  hand-written heading; every screen in the app now uses
  `ui-page-header`.

## Verification alongside the visual pass

- 745 backend tests (up from 717 before 3b), ruff and mypy clean, OpenAPI
  in sync.
- 418 `client-admin-app` unit tests (up from 400), 222 `shared-ui`, 1001
  across the workspace. Four clean builds, lint clean on all nine
  projects.
- Axe clean on every capture and inside the e2e suites.
- **`client-admin-app` e2e is 80/80** — fully green for the first time in
  this arc. `bookings.spec.ts`, a known-red since
  `docs/self-check-2026-08-26-spec11.md`, is fixed rather than
  reworded. `super-admin-app` 16/16 and `validator-app` 7/7 after
  re-seeding; both fail only on fixtures a prior run consumed.

**Two cautions worth repeating from 3a**, both hit again here: restart
the dev server *and* Django's `runserver` before trusting a live check,
and run `seed_e2e_users` between projects — several "failures" in this
slice were exhausted fixtures, not code.
