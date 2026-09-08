# 12-Fare-Matrix: Stop-pair fare grid editor

## Scope and non-goals

Per-stop-pair pricing already exists, end to end and tested:
`fares.FareSegmentRule` (Phase 4 Slice 1), `GET`/`POST
/fare-segment-rules/`, `PATCH /fare-segment-rules/{id}/`, and the
from/to stop selects in `fare-form.html`. The gap is not the model — it
is that the feature is unreachable and, once reached, unusable at
scale.

**Two concrete defects this closes:**

1. **`Business.fare_pricing_mode` has no UI anywhere.** It is a
   writable field on `BusinessSerializer`, but `business-form` never
   renders a control for it, so it can only ever hold its model default
   of `flat`. `fare-form.html`'s `@if (isPerSegment())` branch —
   the from/to stop pickers — is therefore dead code that no user can
   reach. This is why per-stop-pair fares "don't reflect in the UI":
   they were built, then left with no switch to turn them on.

2. **Fares are entered one rule at a time.** `apps.fares` has, by
   explicit design, no fare composition or inference — every valid
   `(from_stop, to_stop)` pair a passenger can book needs its own row
   (`docs/specs/4-fares-seating-booking.md` §1 non-goals). A 10-stop
   route has 45 forward pairs. Forty-five separate create flows is not
   a workflow anyone will complete correctly.

**Non-goals:**

- **No change to the pricing model.** No composition, no inference, no
  deriving a segment price from per-stop values. That remains the
  documented non-goal it has been since Phase 4; this spec makes the
  existing explicit model tractable to enter, nothing more.
- **`fare_pricing_mode` stays per-Business, not per-Route.** A
  Business is flat *or* per-segment, not a mix. Moving it onto `Route`
  was considered and deliberately deferred in favour of fixing data
  entry first.
- No bulk import from CSV/spreadsheet. Plausible follow-up; not this.

## Data model changes

**None.** This is an API and UI slice over models that already exist.

The subtlety is that `FareSegmentRule` is **versioned**, and the grid
must not quietly break that. Editing a fare does not mutate `amount`
in place: `apps.fares.services` closes the current row's half-open
`[effective_from, effective_to)` window and inserts a successor
starting at the boundary instant, so a historical `SeatReservation`
still points at the rule that actually priced it. Non-overlap is
enforced by a Postgres GiST exclusion constraint written in raw SQL in
the migration, because Django cannot express `tstzrange(col_a, col_b)`
as a model-level `ExclusionConstraint` cleanly.

A grid that wrote `FareSegmentRule` rows directly, or updated `amount`,
would silently destroy the price-snapshot guarantee that booking
provenance depends on. It must go through the service layer.

## API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/routes/{id}/fare-matrix/` | `fares.view` | The route's ordered stops plus the currently-effective amount for every valid forward pair, `null` where unpriced |
| `PUT` | `/routes/{id}/fare-matrix/` | `fares.manage` | Bulk upsert of the whole matrix |

Both reuse existing permission codenames; no new ones.

### `GET` response shape

```jsonc
{
  "route": "uuid",
  "currency": "NGN",              // from route.business.currency
  "fare_pricing_mode": "per_segment",
  "stops": [ {"id": "uuid", "name": "Ikeja", "sequence": 1}, ... ],
  "cells": [
    {"from_stop": "uuid", "to_stop": "uuid", "amount": "1500.00",
     "fare_segment_rule": "uuid"},
    {"from_stop": "uuid", "to_stop": "uuid", "amount": null,
     "fare_segment_rule": null}
  ]
}
```

Only forward pairs (`to.sequence > from.sequence`) appear — the same
rule `BookingCreateSerializer.validate()` enforces as
`invalid_segment_order`, and the same rule `trip-search`'s stop picker
already applies client-side so the rejection is unreachable from the
UI. Emitting the full square would invite pricing a segment nobody can
book.

`fare_segment_rule` is returned per cell so the `PUT` can detect that
the tip it is superseding has moved since load.

### `PUT` semantics

- **One `transaction.atomic()` for the whole matrix.** A partly-priced
  route is worse than a rejected edit — it produces
  `FareNotConfigured` at booking time on exactly the segments the
  operator thought they had just priced.
- **Changed cell with an existing rule** → `supersede_fare_segment_rule`.
  **Changed cell with no rule** → `create_fare_segment_rule`. Both are
  existing service functions; the endpoint orchestrates, it does not
  write.
- **Unchanged cells are skipped entirely**, so saving a one-cell edit
  does not churn the version history of all 45 pairs and does not
  produce 45 audit-log rows.
- **One `effective_from` for the whole submission**, defaulting to now,
  so a matrix save is a single coherent price change rather than 45
  independent timelines drifting apart by milliseconds.

## Edge cases

- **Route stops reordered or removed between load and save.**
  `set_route_stops` hard-deletes and recreates `RouteStop` rows, so a
  concurrently-edited route can invalidate a submitted pair. Reject the
  whole `PUT` with the offending pairs named. Do not silently drop
  them: the operator would believe they had priced a segment that has
  no row.
- **A cell's open-ended rule was superseded elsewhere since load.** The
  service layer raises `FareRuleClosed` or `FareOverlap`. Surface it as
  a **409 naming the specific cell**, not a generic 400 — the operator
  needs to know which price to re-check, and the grid can highlight it.
- **A cell blanked that previously had a price.** This means "stop
  selling this segment". Close the current rule with no successor.
  Require a deliberate confirm in the UI, because the consequence is
  that bookings for that segment start failing with
  `FareNotConfigured` — a `ui-confirm-dialog`, matching the existing
  destructive-action precedent.
- **Business is in `flat` mode.** Respond 409 with a message pointing
  at the business setting. Segment rules written under `flat` would be
  stored and then never read, since `get_fare()` selects the rule type
  from `business.fare_pricing_mode` at lookup time — silently accepting
  them would be the worst outcome of the three.
- **Route with fewer than two stops** → empty `cells`, and the UI shows
  an empty state pointing at the route's stop editor.
- **Negative or zero amount** → 400 from the serializer. Zero is
  rejected deliberately: a genuinely free segment should be expressed
  as a policy decision, not a `0.00` fare that looks like a data-entry
  slip.

## Failure modes

- **Partial write on a mid-batch exception** — impossible by
  construction; the whole `PUT` is one transaction. Worth an explicit
  test that forces a failure on cell N and asserts cells 1..N-1 did not
  persist.
- **Two operators saving the same route's matrix concurrently** — the
  GiST exclusion constraint is the backstop. One transaction wins; the
  other gets an `IntegrityError` that the service layer already maps to
  `FareOverlap`, surfaced as the 409 above. No new locking needed:
  unlike `docs/adr/0008`'s count invariant, this one *is* expressible
  as a database constraint and already is one.
- **Very wide routes.** A 30-stop route is 435 cells. Both the payload
  and the rendered grid stay bounded but get uncomfortable; note the
  limit rather than paginate a matrix, which would be worse. Revisit if
  a real route approaches it.

## Frontend

**Business form** gains a **Fare pricing mode** select (`Flat` /
`Per segment`) — the fix for defect 1, and the smallest part of this
slice by code but the one that unblocks the rest.

**New screen** at `fares/fare-matrix/:routeId` in `client-admin-app`,
reachable from the fares list and from a route's own row:

- Upper-triangular grid: rows are boarding stops, columns are alighting
  stops, only forward pairs are editable cells.
- Currency label from the business — read from the matrix payload, not
  from `LedgerAccount` or any other row. (A previous slice shipped a
  bug reading a `currency` field off `LedgerAccount`, which has none;
  taking it from the endpoint that already knows avoids repeating it.)
- Dirty-cell highlighting and a single save, so the operator can see
  exactly what a save will change before committing.

**Accessibility is the real risk in this screen** and should be
budgeted for, not retrofitted. A grid of bare inputs is one of the
easier ways to fail the self-check's a11y pass: row and column headers
need `scope`, every cell input needs an accessible name that includes
both stops ("Ikeja to Lekki fare"), and keyboard navigation across the
grid must work without a mouse.

## Test plan

**Backend.** `GET` shape including `null` cells and forward-pairs-only;
`PUT` creating, superseding, and correctly skipping unchanged cells
(asserting no new rule rows *and* no audit rows for untouched pairs);
atomicity on a forced mid-batch failure; the stale-pair rejection; the
`flat`-mode 409; the concurrent-save 409 via the exclusion constraint;
the mandatory cross-client isolation test on both endpoints.

**Frontend.** Grid rendering from a matrix payload, dirty tracking, the
blank-cell confirm dialog, and the new business-form control. A
component test asserting per-cell accessible names, so the a11y
contract is locked in rather than reviewed once.

**E2E.** Price a 3-stop route through the grid, then book a segment
against it and assert the booked amount matches the cell — which is the
only test that proves the grid, `get_fare()`, and booking agree.

## Migration impact

**None.** No schema change. The only migration-adjacent risk is
behavioural: switching an existing Business from `flat` to
`per_segment` changes which rule type `get_fare()` reads, and any
existing `FareRule` rows stay in place but stop being consulted. That
is pre-existing, documented behaviour (`apps/fares/models.py`'s module
docstring: switching mode "does not delete those rows"), and the
business-form control should say so at the point of change rather than
letting an operator discover it as missing prices.

---

## Implementation note (Slice A — backend, done)

`GET`/`PUT /routes/{id}/fare-matrix/`, gated on the existing
`fares.view`/`fares.manage` codenames as planned. 22 tests in
`apps/fares/tests/test_fare_matrix.py`.

The orchestration lives in a **new module**, `apps/fares/matrix.py`,
not in `services.py`. The two layers are different kinds of thing:
`services.py` functions each own one rule's lifecycle, while these own
a whole route's grid and coordinate many of those calls inside one
transaction. `matrix.py` never writes a `FareSegmentRule` — every
mutation goes through a `services.py` function, which is what keeps the
half-open `[effective_from, effective_to)` timeline gapless and the
GiST exclusion constraint satisfied. One test asserts the point
directly: after a price change the original row's `amount` is
untouched, its window merely closed, and the successor starts at
exactly that instant.

It imports `services._effective_at_filter` — module-private — rather
than reimplementing the window rule. Deliberate: the grid must show
exactly what `get_fare()` would charge, and two copies of that
predicate would eventually disagree.

**One new service function was needed.** Blanking a cell means "stop
selling this segment", and only `supersede_fare_segment_rule` existed —
a close *with* a successor. `close_fare_segment_rule()` is the sibling:
it closes the open-ended rule with no successor. Deliberately not a
delete, because a historical `SeatReservation` must keep pointing at the
rule that priced it.

### Verified live, over real HTTP

Beyond the test suite, against the running backend — this is where the
churn-avoidance guarantee actually showed itself:

```
PUT while the business prices flat  → 409, naming the business setting
PUT 3 prices                        → {created: 3}
PUT the identical 3 prices          → {unchanged: 3}   (no new rows, no audit events)
PUT with one cell changed           → {superseded: 1, unchanged: 2}
```

### Three test bugs of mine, worth recording

1. Compared `amount` against a `Decimal`. DRF's `DecimalField` coerces
   to a **string** by default, so the API returns `"150.00"`.
2. Read `RouteStop.objects` outside a `tenant_context`, which the
   tenant-scoped manager silently answers with zero rows.
3. Used `ClientStaffUserFactory(role=None)` expecting an unprivileged
   user. That factory defaults to Owner-equivalent permissions and
   `role=None` is not "no role" — replaced with `PassengerUserFactory`.

## Implementation note (Slice B — frontend, done)

Both halves built, self-checked per `docs/self-check.md`, and verified
against the live stack. Review record:
`docs/ui-review/12-fare-matrix/iteration-1.md` and `iteration-2.md`.

### The business-form control (defect 1 closed)

`business-form` gained a **Fare pricing mode** select. This is what
makes `FareSegmentRule` reachable at all, and what un-deads
`fare-form.html`'s `@if (isPerSegment())` branch.

The spec asked for the consequence to be stated at the point of change.
Doing that properly needed a small `shared-ui` addition: `ui-select`
gained a **`hint`** input, rendered under the control and wired through
`aria-describedby`, so the explanation is announced as part of the
field rather than sitting beside it as text only sighted users get.
When the field is also invalid, `aria-describedby` carries **both** ids
— dropping the hint would remove the explanation exactly when it is
most needed.

`ui-alert` also gained a **`warning`** variant (amber). The flat-mode
notice on the grid is an actionable state, not a failure; colouring it
red would train people to ignore red.

### The grid (defect 2 closed)

`fares/fare-matrix/:routeId`, resolving the route through Part 1's
`ListStore.findByIdPaged` — which is why F3 was fixed first rather than
adding an eighth copy of the bounded-lookup bug here.

**The one design decision that departs from the spec's wording: only
dirty cells are submitted**, though the endpoint accepts and correctly
skips a full-grid submission. Sending every rendered cell has a real
failure mode — if another operator prices a segment while this grid is
open, submitting our stale `null` for that untouched cell would
**close** their rule, a destructive write from a cell the operator
never looked at. Sending only what was edited makes that impossible.
The endpoint's own unchanged-skip stays as a second guard, and the
`unchanged` count it reports is simply always 0 from this client.

Dirty comparison is numeric, not textual: typing `1500` over a stored
`1500.00` is not an edit, and treating it as one would send a supersede
that churns a version history for nothing.

### Entry points

A per-row **"Fares"** link on `route-list` (a grid belongs to one
route, so its row is the natural entry point), gated on `fares.view`
rather than `network.manage` — reading what a route charges is not a
network edit.

From `fare-list`, per-segment mode offers **"Price by stop pair"**
linking to the **route list**, not a route picker on the fares screen
itself. That screen only holds the first page of routes (it loads them
for its name column), so a picker there would silently hide every route
past that page — the exact failure Part 1 exists to end.

### Accessibility

Budgeted, not retrofitted, per the spec: `scope` on row and column
headers, a per-cell accessible name naming both stops ("Ikeja to Lekki
fare"), an `aria-live` change count, and ArrowUp/ArrowDown navigation
between rows of a column. Cells are `inputmode="decimal"` rather than
`type="number"` **specifically** so those keys are available — a number
input would spin the value instead; left/right stay with the text
caret and Tab walks the row. A component test asserts the per-cell
names, because a reviewer will not re-check 45 of them.

0 axe violations (WCAG 2.0/2.1 A + AA) across all six states measured.

### E2E, and its new fixture

`frontend/e2e/client-admin-app/fare-matrix.spec.ts` prices all three
forward pairs of a 3-stop route **through the real grid UI**, then
books a segment **via the API** and asserts `booking.total_amount`
equals the cell. The split matches `bookings.spec.ts`'s existing
precedent: the passenger flow already has its own end-to-end coverage
in the customer-app project, and driving a second app's UI from this
one would couple two Playwright projects that are deliberately run
separately.

It needed a new fixture, `seed_e2e_users._seed_per_segment_fare_fixture`
— **its own Business**, for the same reason the tap-and-go fixture has
one: `fare_pricing_mode` is per-Business and `get_fare()` reads it at
lookup time, so flipping the shared bookable Business would break every
spec relying on its flat fare. The fixture deliberately seeds **no
fare at all**; pricing the route is what the spec tests, and a
pre-priced route would let it pass with a broken grid.

The amount is chosen by reading the cell's current value and picking a
different one, rather than randomising blind — a random collision with
the previous run's price would surface as a dirty-tracking failure and
send the next reader hunting a bug that isn't there.

### Defects found by actually running it

Four in the first visual pass, one in the second — all recorded with
evidence in the `docs/ui-review/12-fare-matrix/` notes. The
representative one: a 3-stop route is a 2×2 grid and exercises none of
this screen's layout risk, so the review used a **6-stop** route (15
forward pairs) built for the purpose. The faint-cell and
missing-currency defects were only visible at that width.
