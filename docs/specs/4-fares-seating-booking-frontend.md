# Phase 4 (addendum): Fares, Seating, Booking — Frontend

## 1. Scope and non-goals

**In scope**: the customer-app booking flow the backend spec
(`docs/specs/4-fares-seating-booking.md`, hereafter "the backend spec")
deliberately deferred — trip search → seat picker → confirm → my
bookings → cancel — plus a `client-admin-app` bookings-list screen
(`booking.view`). Because the backend spec's own §3 never gave a
passenger any way to *discover* a Trip to book (see §3 below), this
addendum also specs a small backend gap-fill: two new passenger-facing
read endpoints and one serializer change. Everything else the booking
flow needs — `POST /bookings/`, `POST /bookings/{id}/cancel/`,
`GET /bookings/mine/`, `GET /bookings/` (staff),
`GET /trips/{id}/availability/`, `GET /trips/{id}/fare/` — already
shipped in the backend spec's three slices and is reused here as-is,
unchanged.

This is the addendum the backend spec's §7/§9 pointed at: *"A frontend
slice is real future work but belongs to its own spec addendum once
slices 1–3 exist to build against."* All three exist; 303/303 backend
tests pass.

**Explicitly deferred / non-goals:**

- **Payment capture.** A `Booking` created through this flow reaches
  `pending_payment` and stops there, exactly as the backend spec
  defines — Phase 5 owns anything past that. No "pay now" affordance
  anywhere in this addendum.
- **A `confirmed` booking state in the UI.** Doesn't exist in the data
  model yet (backend spec §2) — nothing here implies otherwise.
- **A client-admin seat-map visual editor.** `PUT /vehicle-types/{id}/seats/`
  already exists (backend spec §3) but configuring a `VehicleType`'s
  seat layout is not screened here — nothing today suggests client-admin
  staff need a seat-map *view*, only passengers do (§4).
- **`tap_and_go` fare collection UI.** Same non-goal the backend spec
  carries — this flow only ever searches/books
  `booking_mode == reservation` Trips (§3 filters them server-side).
- **The Flutter validator app.** Out of scope platform-wide per
  `CLAUDE.md`.
- **Cross-Business route aggregation, geo/nearest-stop search, or any
  ranking beyond a flat list.** Same posture as the backend spec's own
  Phase 3 PostGIS non-goal — `Stop.latitude`/`.longitude` remain plain
  optional fields, not queried against.

## 2. Data model changes

None — no new models, no new migrations. One additive, non-breaking
serializer change, covered in §3.

## 3. API surface

### 3.1 The gap this closes

The backend spec gave passengers exactly two Trip-scoped read endpoints
(`GET /trips/{id}/availability/`, `GET /trips/{id}/fare/`) and both
require already knowing a Trip's UUID. Every endpoint that could
*produce* that UUID — `GET /trips/` (Phase 3) and `GET /routes/`
(Phase 3) — is gated on `scheduling.view`/`network.view`, and
passengers hold no `Role`/`Permission` at all (`docs/adr/0003`), so they
403 on both. There is today no way for a passenger to go from "I want
to travel from A to B" to a bookable Trip id. Separately,
`BookingSerializer.trip` (backend spec §3, `apps/booking/serializers.py`)
serializes `trip` as a bare FK id — a "my bookings" screen reading that
alone can't show a route name or departure time.

Both gaps are closed here, not deferred further — a spec that scopes a
booking UI without a way to find a Trip isn't a real booking flow.

### 3.2 `GET /routes/browse/?business=`

New view, **not** `RouteListCreateView` with widened permissions — a
distinct read-only view class, `IsAuthenticated` + ordinary tenancy
scoping only, no `Role`/`Permission` check. Same posture the backend
spec already established for `TripFareView`/`TripAvailabilityView`, and
the same reason those are separate classes from the staff CRUD views
rather than a permission-widened `RouteListCreateView`: passenger-visible
filtering is different from staff's (only `is_active=True` Routes, and
no create/edit affordance ever reaches this view).

**`DECISION` — multi-Business passengers.** A Client can run several
Businesses (`docs/specs/1-identity-client-business.md` §2's own example:
two shuttle operations in two cities). A passenger's `User.client` FK
scopes them to one Client, not one Business — so by default this
endpoint returns active Routes across **every** Business under the
passenger's Client, each row embedding which Business it belongs to.
`?business=<uuid>` narrows to one, for a future customer-app that wants
a business-switcher; the default (unfiltered) view is what this
addendum's screens actually use — nothing in customer-app today tracks
a "selected Business" the way `client-admin-app`'s `SelectedBusinessStore`
does, and building that chrome isn't warranted for a first slice.

Response shape reuses `GET /routes/`'s existing embed-stops convention
(backend spec §3's Phase 3 precedent — list responses embed everything
needed, no separate detail fetch), with one addition:

```json
[
  {
    "id": "...", "name": "Ikeja → CMS", "code": "IKJ-CMS",
    "business": { "id": "...", "name": "Lagos Shuttle Co" },
    "stops": [
      { "id": "...", "name": "Ikeja", "sequence": 1 },
      { "id": "...", "name": "Yaba", "sequence": 2 },
      { "id": "...", "name": "CMS", "sequence": 3 }
    ]
  }
]
```

Only `is_active=True` Routes with at least 2 embedded stops (a Route
with 0–1 stops has no valid segment to book) — filtered server-side, not
left for the frontend to discover as an empty seat-picker later.

### 3.3 `GET /trips/search/?route=&service_date=`

New view, same `IsAuthenticated`-only posture. Both query params
required (400 if either is missing/malformed, same convention
`TripFareView`/`TripAvailabilityView` already use for their own
required params). Server-side filters — not client-supplied, so a
passenger can't discover non-bookable Trips by guessing query values —
to `route=<route>`, `service_date=<date>`, `status=scheduled`,
`booking_mode=reservation`. Response reuses the existing
`TripSerializer` (`apps/scheduling/serializers.py`) unchanged — same
nested `route`/`vehicle`/`driver`/`compliance_warnings` shape staff
already see; `compliance_warnings` (e.g. an expired insurance date) is
useful, not sensitive, information for a passenger choosing a Trip, so
reusing the serializer as-is is simpler than forking a passenger-only
subset.

### 3.4 `BookingSerializer.trip` nesting

Additive, non-breaking change to the existing serializer
(`apps/booking/serializers.py`): `trip` changes from a bare FK id to a
`SerializerMethodField`, mirroring `TripSerializer.get_route`'s own
`{id, name}` shape exactly:

```json
{
  "id": "...", "route": { "id": "...", "name": "Ikeja → CMS" },
  "scheduled_departure_at": "2026-08-20T06:00:00Z", "service_date": "2026-08-20"
}
```

`GET /bookings/mine/` and `GET /bookings/` (staff) both consume this for
free — no view-layer change needed, since both already
`select_related("trip", ...)` (`apps/booking/views.py`); the new nested
field just reads further into an already-joined row.

### 3.5 Everything else — unchanged, reused as-is

`GET /trips/{id}/availability/`, `GET /trips/{id}/fare/`,
`POST /bookings/`, `POST /bookings/{id}/cancel/`, `GET /bookings/mine/`,
`GET /bookings/?trip=&status=` (`booking.view`, staff) — all shipped in
the backend spec's three slices, all consumed by this addendum's screens
unmodified. No new permission codenames: the two new endpoints are
`IsAuthenticated`-only (not `Role`/`Permission`-gated, matching every
other passenger-facing endpoint), and the client-admin bookings-list
screen (§4) reuses the already-existing `booking.view` codename.

No new rate limits — same throttle posture the backend spec already
established for every endpoint in this domain.

## 4. Frontend

### 4.1 New customer-app shell

customer-app has no authenticated shell today — just `login/` and
`home/`, no nav chrome (confirmed: no `AppShell`/`NavShell` reference
anywhere in `projects/customer-app/`). **`DECISION`**: build a small
customer-app-specific shell rather than reuse `client-admin-app`'s
`NavShell` as-is — `NavShell`'s collapsible sidebar and business-switcher
are staff back-office chrome, not what a consumer-facing app should look
like. New `AppShell` component (`customer-app/src/app/app-shell.ts`): a
simple top bar (app name, "Search trips" / "My bookings" links,
sign-out), wired into `app.routes.ts` the same nested-`children`-under-
shell shape `client-admin-app`'s `app.routes.ts` already uses, gated by
the existing `customer:access` permission guard `home` already sits
behind. `home` becomes a child route under this shell rather than a
sibling of `login`.

### 4.2 New `ListStore` subclasses

Two, following `TripStore`'s established `ListStore<T, TQuery>`
extension pattern (`fetchPage()` calling `API_CLIENT`, manual
`Authorization` header, `toErrorMessage()` on `!data`) exactly:

- `customer-app/src/app/shared/data/store/booking.store.ts` —
  `BookingStore extends ListStore<Booking>`, `fetchPage()` calls
  `GET /bookings/mine/`. No query params — a passenger's own booking
  history has nothing to filter by yet.
- `client-admin-app/src/app/shared/data/store/booking.store.ts` —
  `BookingStore extends ListStore<Booking, {trip?: string; status?: string}>`,
  `fetchPage()` calls `GET /bookings/?trip=&status=`, mirroring
  `TripStore`'s `TQuery` shape.

### 4.3 Screens

**customer-app** (net-new feature area, `src/app/booking/`):

- `trip-search/trip-search` — Route picker (`ui-select`, options from
  `GET /routes/browse/`, grouped/labeled by embedded `business.name`
  when a Client has more than one), then from-stop/to-stop pickers
  populated from the selected Route's embedded `stops` (to-stop options
  filtered to `sequence > from_stop.sequence`, enforced client-side
  before the request that would otherwise 400 on `invalid_segment_order`
  — see `BookingCreateSerializer.validate()`'s existing check, backend
  spec's Slice 3 implementation note), and a `service_date` picker
  (`TextField type="date"`, the same Phase 3 widening). Submits to
  `GET /trips/search/?route=&service_date=`, rendering results as a list
  of departure-time options (`ui-empty-state` when zero Trips — §5).
- `trip-search/seat-picker` — **net-new component; no seat-map primitive
  exists anywhere in `shared-ui` or any app today** (confirmed by
  research: grepping the codebase for a seat-grid/seat-map component
  found nothing). Takes the selected Trip + from_stop + to_stop (passed
  via router state, not re-fetched), calls
  `GET /trips/{id}/availability/?from_stop=&to_stop=` to render a seat
  grid (available seats selectable, unavailable ones disabled/dimmed —
  `Seat.row`/`.column` used for layout when present, falls back to a
  plain wrapped list of `seat_number` labels when absent — both are
  valid states per the backend spec's own §1 non-goal on seat-map
  geometry) and `GET /trips/{id}/fare/?from_stop=&to_stop=` to show a
  per-seat price; supports multi-seat selection, running total shown
  live.
- `booking/booking-confirm` — summary of selected Trip/seats/fare total,
  a client-generated `Idempotency-Key` (`crypto.randomUUID()`) attached
  as a header on submit, `POST /bookings/` with the body shape
  `BookingCreateSerializer` already defines
  (`{trip, seats: [{seat, from_stop, to_stop}, ...]}`); on `201`,
  navigates to `my-bookings`; on `409` (seat conflict or a genuinely
  different idempotency-key replay), returns the passenger to
  `seat-picker` with an `ui-alert` explaining the seat is no longer
  available — never a silent retry, since a stale seat selection needs a
  fresh availability check, not a blind resubmit.
- `booking/my-bookings` — `BookingStore`-backed list (`ui-table` +
  `ui-status-pill` for `status`, `ui-paginator`), each row rendering the
  new nested `trip.route.name`/`trip.scheduled_departure_at` (§3.4) —
  this is the reason that nesting had to exist, not a nice-to-have.
  Cancel action via `ui-confirm-dialog` (the same dialog component
  `trip-list`'s status-change action already uses), optional reason
  field, calling `POST /bookings/{id}/cancel/`; only rendered when
  `status == pending_payment`, matching the backend's own only-legal-
  transition rule (`BookingCancelSerializer.validate()`) rather than
  showing a cancel button that would just 400.

**client-admin-app** (net-new feature area, `src/app/bookings/`):

- `bookings/booking-list` — mirrors `trips/trip-list`'s
  table+`ui-status-pill`+`ui-paginator` shape exactly (`trip`/`status`
  filter dropdowns above the table, same as `TripStore`'s filters), read
  the new nested `trip.route.name`/`.scheduled_departure_at` fields for
  its own display too. Gated `booking.view`. **No edit/cancel affordance**
  — the backend spec is explicit that there is no `booking.manage`
  codename this phase (staff have ops visibility only), so this screen
  is list-only, same restriction already enforced server-side.
- Nav entry: `{ label: 'Bookings', path: '/bookings', icon:
  'document-check', permissions: ['booking.view'] }` added to
  `app-shell.ts`'s `navItems`. `document-check` is available and unused
  within `client-admin-app` (it's used by `super-admin-app`'s KYB Queue,
  a different app's icon set — no collision) and reads reasonably as
  "a reservation record," closer than any other available `IconName`
  (`clock` is already Trips'; `clipboard-document-check` is already
  KYC's, elsewhere).

### 4.4 `shared-ui` change

None. The seat-picker grid stays customer-app-local — nothing today
suggests `client-admin-app` needs a seat-map view (its own seat
management is the bulk-replace `PUT /vehicle-types/{id}/seats/` form,
out of scope here per §1), so promoting it to `shared-ui` for a single
consumer would repeat the exact "used once, local" reasoning the backend
spec's own Phase 3 precedent already established for the route-stop
reorder widget. `ui-table`/`ui-paginator`/`ui-status-pill`/`ui-select`/
`ui-empty-state`/`ui-confirm-dialog`/`TextField` all get reused as-is.

### 4.5 Mechanical prerequisite

`frontend/projects/api-client/src/lib/schema.ts` has zero generated
types for `booking`/`fare`/seat-availability endpoints today — confirmed
by grep, since `npm run openapi:generate` hasn't run since the backend
added them. It must run (after §3's backend gap-fill lands and
`openapi.yaml` is regenerated to include the two new endpoints) before
any frontend slice in §9 starts, and `npm run openapi:check` must be
clean — the same drift gate every prior phase's frontend work has
depended on.

## 5. Edge cases

- **Zero Trips returned by `GET /trips/search/`** (no service that
  day, or every Trip on that route/date is `tap_and_go`/non-`scheduled`) —
  `trip-search` shows `ui-empty-state`, not an error; a real, expected
  outcome, not a failure.
- **A Route with fewer than 2 active Stops** — excluded server-side from
  `GET /routes/browse/` (§3.2), never reaches the picker as an
  unbookable option.
- **A Trip with no `vehicle` assigned yet** — `GET /trips/{id}/availability/`
  already returns an empty list for this (backend spec §1/§4,
  `apps/seating/services.py`), not an error; `seat-picker` shows
  `ui-empty-state` ("seating not yet configured for this trip").
- **No fare configured for the selected segment** — `GET /trips/{id}/fare/`
  already 404s (backend spec §5); `seat-picker` surfaces this as a
  blocking `ui-alert` before any seat selection is even offered, rather
  than letting the passenger pick seats for a trip they can't actually
  price.
- **A seat held during picking expires before confirm is submitted** —
  not a distinct frontend state to detect proactively (no client-side
  countdown reconciliation against `held_until` is built this slice);
  `POST /bookings/` still attempts the reservation and the backend's
  exclusion constraint is the source of truth, surfacing as the same
  `409` path §4.3's `booking-confirm` already handles.
- **A Client running multiple Businesses** — `GET /routes/browse/`
  returns routes across all of them by default (§3.2's `DECISION`);
  `trip-search`'s Route picker labels each option with its Business name
  so the passenger isn't confused about which operator's route they're
  choosing.
- **Cancelling a Booking that has already expired or was already
  cancelled** — `my-bookings` doesn't render the cancel action at all
  once `status != pending_payment` (§4.3), consistent with the backend's
  own only-legal-from-`pending_payment` rule; no dead-end 400 click path.

## 6. Failure modes

- **`GET /trips/search/` or `/routes/browse/` network/5xx failure** —
  `ui-alert` with a retry affordance on `trip-search`, same pattern
  every existing `ListStore`-backed screen already uses for its own
  `error` signal.
- **`POST /bookings/` succeeds server-side but the response is lost
  client-side** (timeout after the request was actually processed) —
  not newly solved by this addendum; the existing `Idempotency-Key`
  mechanism (backend spec §2/§6) means a client-side retry with the same
  key is always safe and returns the original `Booking`, so
  `booking-confirm`'s submit button can safely retry-on-timeout using the
  same generated key rather than needing new client-side dedup logic.
- **`schema.ts` stale against a mid-development backend change** (the
  gap-fill slice's endpoints shift shape after frontend work has
  started) — caught by `npm run openapi:check` in CI, same drift gate
  as every prior phase; not a new failure mode, just newly relevant
  because §9 sequences backend before frontend specifically to avoid it.

## 7. Test plan

**Backend** (the gap-fill slice only — everything else is already
tested by the backend spec's own three slices): `GET /routes/browse/`
— returns only `is_active` Routes with ≥2 stops, spans multiple
Businesses under one Client, `?business=` narrows correctly, cross-client
isolation (existing `TenantScopedManager` pattern). `GET /trips/search/`
— filters correctly on `route`+`service_date`+server-forced
`status=scheduled`+`booking_mode=reservation`, 400 on missing/malformed
params, cross-client isolation. `BookingSerializer.trip` nesting —
one test asserting the new shape on both `GET /bookings/mine/` and
`GET /bookings/` (staff), plus a `django_assert_max_num_queries` check
confirming the nesting didn't reintroduce an N+1 (it shouldn't — both
views already `select_related("trip")`).

**Frontend (Karma)**: `BookingStore` (both apps) — mapping + error path,
mirroring every prior `ListStore` subclass's spec shape. `trip-search` —
Route/stop-picker population, to-stop options correctly filtered to
`sequence > from_stop.sequence`, empty-results state. `seat-picker` —
renders available/unavailable seats distinctly, multi-select running
total, empty-state when no seats configured, blocking alert on 404 fare.
`booking-confirm` — submit generates and sends an `Idempotency-Key`
header, 409 routes back to `seat-picker` with the right message.
`my-bookings` — cancel action only rendered for `pending_payment` rows,
confirm-dialog cancel flow. `booking-list` (client-admin) — filters,
table rendering, no edit/cancel affordance present anywhere in the DOM
(a real assertion, not just "not tested," given `booking.view`-only
staff should never see an action they can't legally take).

**E2E (Playwright + axe)**, full state matrix at 390/768/1440px per
screen: the complete customer-app flow (search → pick seats → confirm →
appears in my-bookings → cancel it), a 409-conflict path (two
Playwright contexts racing the same seat, asserting one succeeds and the
other sees the conflict message — reusing the same "two concurrent
actors" e2e shape, not the backend's own `TransactionTestCase` spike,
which stays backend-only), and client-admin's `booking-list` filter
flow. Keyboard/focus-restoration coverage for `booking-confirm`'s and
`my-bookings`' `ui-confirm-dialog` usage, reusing `kyc-queue.spec.ts`'s
established pattern for that dialog's now-several-consumers.

## 8. Migration impact

All additive, no destructive step: two new Django views/URLs in
`apps/network`/`apps/scheduling` (or a shared location — finalized at
implementation time; no new app, no new model, so no new
`INSTALLED_APPS` entry either), one serializer field change
(`BookingSerializer.trip`, `SerializerMethodField` replacing a bare FK —
additive to the response shape, not a request-body change, so no
existing client breaks), `openapi.yaml` regeneration, `schema.ts`
regeneration. No new permission codenames, no new migration files in
`apps/identity`.

## 9. Suggested implementation slicing

Dependency order: every frontend slice below needs the backend gap-fill
(§3) to exist and `schema.ts` regenerated against it first (§4.5) — that
determines slice 1's position. Slices 2 and 3 split the customer-app
write path from its own list/cancel screen the same way the backend
spec's own Slice 2/Slice 3 split "the hard mechanism" from "the flow on
top of it." Slice 4 is independent of 2/3 (it only reads the
already-shipped staff `GET /bookings/` endpoint) but is sequenced last
here for review cadence, not because it depends on anything earlier —
same caveat Phase 3's own §10 used for its own parallelizable slice.

1. **Backend gap-fill** (`GET /routes/browse/`, `GET /trips/search/`,
   `BookingSerializer.trip` nesting, `openapi.yaml`/`schema.ts`
   regeneration). Sequenced first because every later slice needs it to
   build against — same reasoning both prior specs' own slice 1 used.
2. **customer-app shell + trip search + seat picker + confirm.** The
   passenger-facing write path — the biggest slice, proving the net-new
   seat-picker component and the full search→book flow in one pass,
   matching the "prove the hard cross-cutting mechanism in one pass"
   justification both prior specs' §9/§10 gave their own largest slice.
3. **customer-app my-bookings + cancel.** Smaller, depends on slice 2's
   `BookingStore` and shell already existing; a separable review
   checkpoint the same way Phase 3 split list-screens from form-screens.
4. **client-admin-app bookings-list.** Fully independent of 2/3 (reads
   the already-shipped staff `GET /bookings/` endpoint, no gap-fill
   dependency at all) — could in principle run in parallel with any of
   the above, sequenced last purely for review cadence.

Each slice gets its own stop-and-review, per the working agreement —
this is a proposed order, not a request to build all four in one pass.

**Implementation note (all 4 slices, done — built out of process, verified
after the fact).** All four slices above were built — matching this spec
closely, with zero code-level deviations found beyond a component
file-layout naming difference (flat files under `trip-search/`/`booking/`
rather than a directory per component). **They were built in one pass,
without the stop-and-review checkpoint between slices this section
itself calls for** — discovered, not requested; recorded here because
the working agreement this repo runs on treats that checkpoint as load-
bearing, not optional. A full verification pass ran afterward instead of
before-each-slice review: 346/346 backend tests (up from 303),
`ruff`/`mypy`/OpenAPI-drift all clean, the previously-nonexistent E2E
coverage was written and now passes (customer-app booking flow,
client-admin bookings filter, keyboard-only and focus-restoration
coverage), and a full visual iteration loop ran (2 rounds — one real
shared-component bug found and fixed, `ui-select` missing `w-full`,
causing overflow at the mobile-authoritative viewport once accumulated
test data produced long option text). One real backend bug, unrelated to
this spec's own code but discovered while verifying it, was found and
fixed: `apps/network/services.py::set_route_stops` used the wrong
manager under `platform_staff_bypass()`, breaking `seed_e2e_users`'
idempotency. Full detail, every finding, and honest confidence levels:
`docs/self-check-2026-08-14-phase4-frontend.md`.

**A second, wholly unspec'd feature — versioned `FareRule`/
`FareSegmentRule` with price/fare-rule snapshotting on
`SeatReservation`/`Booking.currency` — was also built in the same pass,
touching `apps.fares`, `apps.seating`, and `apps.booking` with destructive
migrations already applied to the dev database.** It is unrelated to
this spec's own scope and is not part of these 4 slices — retroactively
documented at `docs/specs/4-fares-seating-booking-versioning.md` once
discovered, per the same self-check.
