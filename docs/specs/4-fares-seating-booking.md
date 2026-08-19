# Phase 4: Fares, Seating, Booking

## 1. Scope and non-goals

**In scope**: three new backend domain apps — `fares` (per-Business
pricing, flat or per-segment), `seating` (real per-seat inventory
replacing Phase 3's plain `VehicleType.capacity` count, and the
seat-hold/reservation concurrency model), `booking` (the passenger-facing
Booking that ties a Trip, one or more seats, and a fare together) —
plus two additive fields on the existing `businesses.Business` model,
five new fine-grained permission codenames, and the first
passenger-facing (non-staff) mutating API endpoints in the system. This
is the phase where the platform starts doing the thing it exists to do
commercially: a passenger reserves a seat.

This spec exists because `docs/adr/0004-seat-segment-concurrency-strategy.md`
is now decided (see that document for the full reasoning) — nothing
here should re-litigate that ADR's decision, only apply it.

**Explicitly deferred / non-goals:**

- **Real payment capture.** A `Booking` this phase reaches
  `pending_payment` and stops there — see §2's `Booking.status` and §6.
  Phase 5 (Payments, Wallet, Ledger — its own ADR gate, `docs/adr/0006`)
  is what transitions a `Booking` to a paid/confirmed state. Nothing in
  this phase references `apps.payments`, `apps.wallet`, or `apps.ledger`.
- **QR ticket issuance.** Phase 6, gated on `docs/adr/0005`. A confirmed
  `Booking` this phase produces no ticket artifact.
- **`tap_and_go` fare collection (Metro).** Everything in this spec —
  `Seat`, `SeatReservation`, `Booking` — applies only to Businesses with
  `booking_mode_default == reservation` (or, per-Trip, a snapshotted
  `Trip.booking_mode == reservation`, per Phase 3's existing
  denormalization). A `tap_and_go` Business's fare-collection mechanism
  is a real, still-open design question — **not** answered here, and
  not silently assumed to be "the same thing without seat selection."
  Revisit as its own spec when that vertical is prioritized.
- **Fare inference across an unrecorded segment.** In `per_segment`
  pricing mode, every valid `(from_stop, to_stop)` pair a passenger can
  book must have its own explicit `FareSegmentRule` row. There is no
  fare-composition logic (e.g. deriving A→C's price from A→B + B→C) —
  see §5.
- **Seat map visual geometry.** `Seat.row`/`Seat.column` exist as plain
  optional integers for a future visual seat-picker to use; no layout
  engine, no per-`VehicleType` diagram builder.
- **Overbooking/waitlist.** A Trip with no available seat for a
  requested segment returns a clear error; there is no waitlist
  concept.
- **Booking modification.** A `Booking` can be created and cancelled;
  changing seats/segments on an existing `Booking` is not supported —
  the passenger cancels and rebooks. Simpler for v1, revisit if support
  volume shows this matters.

## 2. Data model changes

All new models are `apps.core.models.BaseModel` subclasses (UUID PK,
`client` FK, timestamps, soft-delete, Postgres RLS via
`EnableRowLevelSecurity` in the same migration that creates them),
matching the unbroken convention every domain model since Phase 1 has
used. Every FK uses `related_name="+"`, same reasoning as Phase 3's
models (a reverse accessor on an RLS-protected model would traverse
`TenantScopedManager`).

### `apps.businesses.Business` — two additive fields

| Field | Type | Notes |
|---|---|---|
| `fare_pricing_mode` | `CharField`, `TextChoices` (`flat`/`per_segment`), default `flat` | Client-admin-editable via the existing `PATCH /businesses/{id}/` (`business.manage`) — it's the operator's own pricing model choice, same editability class as `booking_mode_default` |
| `seat_hold_minutes` | `PositiveIntegerField`, default `15` | **Not** client-admin-editable. Only mutable via a new super-admin-only endpoint (§3) — per `docs/adr/0004`, an operator must not be able to lengthen their own hold window |

Both additive (`AddField` with a server default), non-destructive,
matching Phase 3's own migration-safety record.

### `apps.fares`

**`FareRule`** — one flat fare per Route, used when
`business.fare_pricing_mode == flat`.

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | denormalized from `route.business`, validated to match — same narrowing pattern `Schedule.business` uses |
| `route` | FK → `network.Route`, `on_delete=PROTECT`, unique | one `FareRule` per Route |
| `amount` | `DecimalField(max_digits=10, decimal_places=2)` | currency is `route.business.currency`, not stored redundantly |
| `is_active` | `BooleanField(default=True)` | |

**`FareSegmentRule`** — per-stop-pair fare, used when
`business.fare_pricing_mode == per_segment`.

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | denormalized, same pattern |
| `route` | FK → `network.Route`, `on_delete=PROTECT` | |
| `from_stop` | FK → `network.Stop`, `on_delete=PROTECT` | |
| `to_stop` | FK → `network.Stop`, `on_delete=PROTECT` | |
| `amount` | `DecimalField(max_digits=10, decimal_places=2)` | |

`UniqueConstraint(fields=["route", "from_stop", "to_stop"], name="unique_fare_segment_per_route")`.
Service-layer validation (not a DB constraint, matching `RouteStop`'s
own precedent): both stops must belong to the route via `RouteStop`,
and `from_stop`'s `sequence` must be strictly less than `to_stop`'s.

A Route only ever uses one of `FareRule`/`FareSegmentRule` — which one
is read off `route.business.fare_pricing_mode` at lookup time, not
stored per-Route. Switching a Business's `fare_pricing_mode` after fare
rules already exist under the old mode does not delete the now-unused
rows (no destructive cascade); it's a service-layer `ASSUMPTION:` that
an operator switching modes will re-enter fares under the new mode
before creating new Bookings, surfaced as a plain warning in the
client-admin UI when this phase's frontend slice is built, not enforced
server-side.

### `apps.seating`

**`Seat`** — real per-seat inventory, replacing Phase 3's
plain-integer-only `VehicleType.capacity` as the thing a `Booking`
actually reserves (`capacity` itself is unchanged and still exists —
see below).

| Field | Type | Notes |
|---|---|---|
| `vehicle_type` | FK → `fleet.VehicleType`, `on_delete=PROTECT` | |
| `seat_number` | `CharField(10)` | e.g. `"12A"`, `"7"` — free-form label, not a computed index |
| `row` | `PositiveIntegerField(null=True, blank=True)` | optional, for a future visual picker — §1 non-goals |
| `column` | `PositiveIntegerField(null=True, blank=True)` | optional, same |
| `is_active` | `BooleanField(default=True)` | |

`UniqueConstraint(fields=["vehicle_type", "seat_number"], name="unique_seat_number_per_vehicle_type")`.
Service-layer validation: creating a `Seat` beyond
`vehicle_type.capacity` active seats is rejected — `capacity` remains
the authoritative cap set in Phase 3; `Seat` rows populate it, they
don't replace it. A `VehicleType` with zero `Seat` rows is a real,
valid state (fleet added before seats are configured) — a `Trip` on
such a `VehicleType` simply has no bookable seats yet, a clear
non-error condition surfaced to the passenger as "seating not yet
configured for this trip," not a 500.

**`SeatReservation`** — the single table implementing
`docs/adr/0004`'s unified hold/booking lifecycle.

| Field | Type | Notes |
|---|---|---|
| `trip` | FK → `scheduling.Trip`, `on_delete=PROTECT` | |
| `seat` | FK → `Seat`, `on_delete=PROTECT` | |
| `booking` | FK → `booking.Booking`, `on_delete=PROTECT` | always set — a `SeatReservation` only ever exists as part of a `Booking`, see §4 |
| `from_stop` | FK → `network.Stop`, `on_delete=PROTECT` | user-facing; what the passenger actually boards at |
| `to_stop` | FK → `network.Stop`, `on_delete=PROTECT` | user-facing; what the passenger actually alights at |
| `segment_range` | `IntegerRangeField` (`django.contrib.postgres.fields`) | **derived, internal-only** — computed from `RouteStop.sequence` for `from_stop`/`to_stop` at creation; never read or written by application logic beyond the write that creates it, never serialized in an API response |
| `status` | `CharField`, `TextChoices` (`held`/`confirmed`/`expired`/`released`) | see transitions below |
| `held_until` | `DateTimeField(null=True, blank=True)` | set at creation to `now() + business.seat_hold_minutes`; null once `confirmed` (no longer time-limited) |

**Legal transitions:**

```
held      -> {confirmed, expired, released}
confirmed -> {}   # terminal this phase — Phase 5 owns any further state
expired   -> {}   # terminal
released  -> {}   # terminal
```

`held -> confirmed` is not reachable by any endpoint this phase (it
requires payment success, Phase 5) — the transition is named here so
Phase 5's spec has a fixed target, not a new decision to make. `held ->
expired` is driven by the Celery sweep task (§4). `held -> released` is
driven by explicit passenger/staff cancellation (§3).

**The concurrency constraint** (raw SQL, applied via migration,
mirroring `EnableRowLevelSecurity`'s pattern of a reusable migration
operation rather than ORM-level-only enforcement):

```sql
ALTER TABLE seating_seatreservation
  ADD CONSTRAINT no_overlapping_active_segment_per_seat_trip
  EXCLUDE USING gist (
    seat_id WITH =,
    trip_id WITH =,
    segment_range WITH &&
  )
  WHERE (status IN ('held', 'confirmed'));
```

Requires `btree_gist` (enabled in the dev Postgres image since Phase
0). This is the enforcement mechanism `docs/adr/0004` requires and the
subject of the mandatory concurrency spike test (§7).

### `apps.booking`

**`Booking`**

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | denormalized from `trip.business` |
| `trip` | FK → `scheduling.Trip`, `on_delete=PROTECT` | |
| `passenger` | FK → `identity.User`, `on_delete=PROTECT` | the authenticated passenger who created it |
| `status` | `CharField`, `TextChoices` (`pending_payment`/`cancelled`/`expired`) | **no `confirmed` this phase** — see §1 |
| `total_amount` | `DecimalField(max_digits=10, decimal_places=2)` | sum of the fare-service lookup for each seat/segment in the booking, computed once at creation |
| `cancellation_reason` | `TextField(blank=True)` | populated on explicit cancel |

No separate `held_until` field — every `SeatReservation` under one
`Booking` is created in the same atomic call with the same
`held_until`, so they always expire together; the Booking's effective
expiry is always its reservations' shared `held_until`, not a value
duplicated onto `Booking` itself.

**Legal transitions:**

```
pending_payment -> {cancelled, expired}
cancelled       -> {}   # terminal
expired         -> {}   # terminal
```

A `Booking` reaching `expired` or `cancelled` transitions every one of
its `SeatReservation` rows to the matching terminal state
(`expired`→`expired`, `cancelled`→`released`) in the same transaction —
never left dangling in `held`.

### New `Permission` codenames

Own data migration in `apps/identity`, matching Phase 3's precedent of
not editing prior seed migrations:

| Codename | Description |
|---|---|
| `fares.view` | View fare rules |
| `fares.manage` | Create/edit `FareRule`/`FareSegmentRule` |
| `seating.view` | View seat layouts |
| `seating.manage` | Create/edit `Seat` rows for a `VehicleType` |
| `booking.view` | Client-admin staff: view Bookings made against their Business (support/ops visibility) |

`apps/identity/services.py::DEFAULT_ROLE_PERMISSIONS`: Manager gets all
five (consistent with already holding `fleet.manage`/
`scheduling.manage`); Staff gets the three `.view` codenames only,
consistent with existing precedent. There is no `booking.manage`
codename for client-admin staff — cancelling a Booking on a passenger's
behalf is deliberately out of scope this phase (§1); staff can see
Bookings, not act on them.

**Passenger-facing endpoints are not `Role`/`Permission`-gated at
all** — passengers have no `Role` (per `docs/adr/0003`, they're
tenant-scoped `User` rows, but role-based staff permissions don't apply
to them). Booking creation/cancellation is gated on `IsAuthenticated`
plus the normal tenancy scoping every `BaseModel` query already
enforces — this is the first phase where that distinction (staff
permission-gated vs. passenger tenancy-scoped-only) actually matters,
so it's called out explicitly rather than left implicit.

## 3. API surface

Mounted at bare `/api/v1/`, matching every prior phase's convention.

| Method & path | Auth | Audited | Notes |
|---|---|---|---|
| `GET /fare-rules/?route=` | `fares.view` (staff) | — | Returns whichever of `FareRule`/`FareSegmentRule` applies per `business.fare_pricing_mode` |
| `POST /fare-rules/` | `fares.manage` (staff) | ✅ `fare_rule.created` | Body shape depends on the Business's current `fare_pricing_mode` |
| `PATCH /fare-rules/{id}/` | `fares.manage` (staff) | ✅ `fare_rule.updated` | |
| `GET /vehicle-types/{id}/seats/` | `seating.view` (staff) | — | |
| `PUT /vehicle-types/{id}/seats/` | `seating.manage` (staff) | ✅ `vehicle_type.seats_updated` | Bulk replace, mirrors `PUT /routes/{id}/stops/`'s replace-the-set shape |
| `GET /trips/{id}/availability/?from_stop=&to_stop=` | passenger (`IsAuthenticated`) or staff (`scheduling.view`) | — | Every `Seat` on the Trip's `VehicleType`, each with `is_available: bool` for the requested segment |
| `GET /trips/{id}/fare/?from_stop=&to_stop=` | passenger or staff | — | `{"amount": "...", "currency": "..."}` via the fare-lookup service (§4); `404` if no applicable fare rule exists for that segment — see §5 |
| `POST /bookings/` | passenger (`IsAuthenticated`) | ✅ `booking.created` | Body `{trip, seats: [{seat, from_stop, to_stop}, ...]}`; requires an `Idempotency-Key` header — first real consumer of `apps.core.models.IdempotencyKey` |
| `POST /bookings/{id}/cancel/` | passenger, own booking only | ✅ `booking.cancelled` | Only legal from `pending_payment` |
| `GET /bookings/mine/` | passenger | — | Passenger's own booking history |
| `GET /bookings/?trip=&status=` | `booking.view` (staff) | — | Ops visibility, paginated, matches `Trip`'s filter-bar precedent |
| `PATCH /super-admin/businesses/{id}/seat-hold/` | `is_platform_staff` | ✅ `business.seat_hold_updated` | Body `{"seat_hold_minutes": <int>}`; mirrors the existing super-admin KYB-queue endpoints' auth shape, not a new pattern |

**Serializer FK-resolution note** (the now-standing rule from Phase 1/3):
every writable FK above (`FareRule.route`, `Seat.vehicle_type`,
`SeatReservation.seat`/`.from_stop`/`.to_stop`, `Booking.trip`) is
resolved inside a `validate_<field>()` method against
`Model.objects.get(pk=...)`, never a class-body `queryset=`.

`POST /bookings/` request handling, in order (all inside one
`transaction.atomic()` block, matching `register_client()`'s existing
pattern of "own the transaction, don't rely on caller discipline"):

1. Resolve `trip`; reject if `trip.booking_mode != Business.BookingMode.RESERVATION`
   (a `tap_and_go` Trip has no bookable seats — §1) or
   `trip.status != scheduled`.
2. For each requested `{seat, from_stop, to_stop}`: validate the stops
   belong to `trip.route` in the right order (same validation
   `FareSegmentRule` uses), look up the fare via §4's fare service.
3. Create the `Booking` row (`status=pending_payment`,
   `total_amount` = sum of step 2's fares).
4. Create one `SeatReservation` per seat (`status=held`,
   `held_until = now() + business.seat_hold_minutes`).
5. If the exclusion constraint rejects any insert (someone else holds
   or has confirmed an overlapping segment on that seat), the whole
   transaction rolls back and the endpoint returns `409 Conflict` with
   which seat/segment was unavailable — never a partial booking.

No new rate limits — authenticated, tenancy-scoped endpoints, same
throttle posture as every prior phase's non-auth endpoints.

## 4. Service layer and Celery sweep task

`services.py` per app, fat-service/thin-view, matching every prior
phase's shape. Every mutating function calls
`apps.core.audit.record_audit_event(...)`.

**`apps/fares/services.py`**

```python
def get_fare(*, trip: Trip, from_stop: Stop, to_stop: Stop) -> Decimal:
    """Dispatches on trip.business.fare_pricing_mode. Raises
    FareNotConfigured (mapped to a 404) if flat mode has no FareRule
    for trip.route, or per_segment mode has no exact FareSegmentRule
    for (from_stop, to_stop) — no cross-segment inference, see §1/§5."""
```

**`apps/seating/services.py`**

```python
def get_availability(*, trip: Trip, from_stop: Stop, to_stop: Stop) -> list[SeatAvailability]:
    """One row per active Seat on trip's VehicleType; is_available is
    False iff an active (held/confirmed) SeatReservation on that seat
    for this trip has an overlapping segment_range — the same predicate
    the exclusion constraint enforces, computed here for read-only
    display before a write is attempted."""

def create_reservation(*, trip: Trip, seat: Seat, from_stop: Stop, to_stop: Stop,
                        booking: Booking, hold_minutes: int) -> SeatReservation:
    """Computes segment_range from RouteStop.sequence, inserts with
    status=held. Lets the database's exclusion constraint be the final
    word — does not pre-check availability and trust it, since that
    would reintroduce the race the constraint exists to close."""
```

**`apps/booking/services.py`**

```python
def create_booking(*, trip: Trip, passenger: User, seats: list[SeatRequest],
                    idempotency_key: str) -> Booking:
    """The transaction described in §3. Wraps apps.core.models.IdempotencyKey
    lookup/creation around the whole operation — a retried request with
    the same key returns the original Booking, not a second one."""

def cancel_booking(*, booking: Booking, cancelled_by: User, reason: str) -> Booking:
    """pending_payment -> cancelled; all SeatReservations -> released."""
```

**Celery Beat task, `apps/seating/tasks.py`** — `expire_seat_holds`,
mirroring `apps.scheduling`'s existing daily Trip-generation job as the
direct precedent (same app, same "system-context code" shape, runs
under `platform_staff_bypass()` since it has no authenticated request).
Runs every minute (materially more frequent than the daily Trip job,
since a 15-minute hold needs sub-hold-duration granularity to expire
promptly): finds `SeatReservation` rows with `status=held` and
`held_until < now()`, sets them to `expired`, and for each affected
`Booking`, if **all** of its `SeatReservation` rows are now
non-`held`, transitions the `Booking` to `expired` in the same
transaction.

## 5. Edge cases

- **No fare configured for a requested segment.** `per_segment` mode
  with a missing `FareSegmentRule` for an otherwise-valid stop pair —
  `GET /trips/{id}/fare/` returns `404` with a message naming the
  missing segment; `POST /bookings/` rejects the whole request rather
  than silently omitting that seat's price.
- **`fare_pricing_mode` switched after rules exist under the old
  mode.** Named in §2 — old rows aren't deleted, new lookups simply use
  the new mode's rule type, which may not exist yet (falls into the
  case above).
- **Booking a seat beyond `VehicleType.capacity`, or before any `Seat`
  rows exist for that `VehicleType`.** Both surface as ordinary "no
  seats available" states — `get_availability()` simply returns an
  empty or all-unavailable list, not an error.
- **Concurrent bookings for overlapping segments on the same seat.**
  The reason this ADR/spec exists — handled by the exclusion
  constraint, §2/§7.
- **A `Booking`'s hold expires between the availability check and the
  booking request.** `POST /bookings/` doesn't pre-check availability
  separately from the write — it always attempts the `SeatReservation`
  insert and lets the constraint decide, so this collapses into the
  same `409` path as any other conflict, not a distinct race window.
- **Passenger tries to cancel someone else's Booking, or a Booking not
  in `pending_payment`.** `403`/`400` respectively — ownership check
  plus the transition-map validation already established by `Trip`'s
  status-transition endpoint in Phase 3.
- **A `Trip` is cancelled (Phase 3's existing status-transition
  endpoint) while it has `held`/would-be-`confirmed` `SeatReservation`s
  against it.** Out of scope to auto-resolve this phase —
  `ASSUMPTION:` flagged here rather than silently handled: Phase 3's
  Trip-cancellation endpoint does not know about `SeatReservation` yet
  (it predates this app). Revisit as a small follow-up once this phase
  lands — likely the same "cascade to released" treatment Schedule
  deactivation already gives future Trips.
- **Cross-Business seat/stop assignment.** Same class of check Phase 3
  introduced for Vehicle/Driver assignment: a `Seat` from one Business's
  `VehicleType` can't be reserved against a `Trip` from a different
  Business, validated explicitly (`TenantScopedManager` alone catches
  cross-*Client*, not cross-*Business within one Client*).

## 6. Failure modes

- **Exclusion constraint violation on insert** (the expected, correct
  rejection of a genuine conflict) — mapped to `409 Conflict`, not a
  `500`; the whole `Booking` transaction rolls back, so a
  partially-held multi-seat booking never persists.
- **Celery sweep task falls behind or fails to run** (broker down,
  worker crash) — `held` reservations simply outlive their
  `held_until` until the task catches up; a subsequent booking attempt
  against that seat/segment fails at the constraint (correctly) even
  though the passenger who originally held it may reasonably have
  expected it released. `ASSUMPTION:` an operational monitoring
  concern (task-queue health), not a data-correctness one — the
  constraint, not the sweep task, is what prevents double-booking; the
  sweep task only prevents *stale unfairness* to other passengers, and
  its own staleness is bounded by ordinary Celery Beat monitoring, not
  a new mechanism this spec invents.
- **`IdempotencyKey` collision from a genuinely different request body
  reusing the same key** — mirrors whatever behavior
  `apps.core.models.IdempotencyKey` already defines generically
  (`request_hash` comparison); if the stored hash doesn't match the new
  request, return `409` rather than either silently serving the old
  response or creating a second Booking.

## 7. Test plan

**Backend — models/services:**
- `FareRule`/`FareSegmentRule` CRUD, RLS adversarial tests (mandatory
  per-model pattern since Phase 1), the `per_segment` ordering
  validation (`from_stop` before `to_stop`).
- `Seat` capacity-cap validation, uniqueness.
- `SeatReservation` status-transition legality, the sweep task's
  batch-expiry + cascading Booking-expiry logic.
- `Booking` creation's full transaction (success, partial-conflict
  rollback, idempotency-key replay, ownership-gated cancel).

**Backend — the mandatory concurrency spike (`docs/adr/0004`,
cross-cutting, this is the test that promotes the ADR to fully
"Accepted"):** a `pytest-django` `TransactionTestCase` (not the default
`TestCase`, which wraps each test in a rolled-back transaction and
would mask real constraint/isolation behavior) spinning up N concurrent
database connections/threads requesting overlapping segments on one
seat on one Trip, asserting **exactly one** succeeds and every other
gets the `409`/constraint-violation path — not a flaky race, a
deterministic assertion run multiple times in CI to catch
non-determinism early.

**Backend — endpoints:** every named URL gets at least one
`reverse()`-referencing test (the scripted diff check every prior
phase's self-check has run). Query-count (`django_assert_max_num_queries`)
coverage on `GET /trips/{id}/availability/` and `GET /bookings/`, since
both are exactly the shape (`N` seats/bookings joined against related
data) that produced real N+1 findings in Phase 1's self-check.

**Frontend**: no client-admin or customer-app UI is scoped in this
document — this spec is backend-only, matching Phase 3's own
backend/frontend slice split (`docs/specs/3-network-scheduling-fleet.md`
built the backend and its UI as separate slices; this phase's UI slice
is scoped separately once this spec is approved).

**E2E**: none this document — depends on the (not-yet-scoped) frontend
slice.

## 8. Migration impact

All additive: two new fields on `Business` (server defaults, no
backfill needed beyond Django's own default-value application), three
new apps' `CreateModel` + `EnableRowLevelSecurity` migrations, one new
raw-SQL exclusion-constraint migration (reversible — `DROP CONSTRAINT`
in `reverse_sql`), one new `apps/identity` permission-seeding data
migration (five new rows, append-only per the existing convention). No
`RemoveField`/`DeleteModel`/`AlterField` anywhere. Nothing here touches
`network`, `fleet`, or `scheduling`'s existing tables beyond reading
them via FK.

## 9. Suggested implementation slicing

Backend app dependency order: `apps.fares` depends only on `network`
and `businesses` — fully independent of the other two new apps.
`apps.seating`'s `SeatReservation.booking` is a **required** FK to
`apps.booking.Booking` (§2), so `seating`'s model layer cannot be
migrated without `booking`'s `Booking` model already defined — the
same cross-app FK coupling that forced `apps/scheduling` to depend on
both `network` and `fleet` in Phase 3. That coupling is what makes the
slicing below 3 slices, not 4.

1. **`apps/fares` backend** (`Business.fare_pricing_mode` field,
   `FareRule`, `FareSegmentRule`, the fare-lookup service, `GET`/`POST`
   fare-rule endpoints). Smallest, fully independent — sequenced first
   for the same reason Phase 3 built `network` first: proves the
   new-app pattern (new permission codenames, `DEFAULT_ROLE_PERMISSIONS`
   edit, RLS registry auto-pickup) before the harder slice depends on
   nothing from it.
2. **`apps/seating` + `apps/booking`'s `Booking` model, together**
   (`Seat`, `SeatReservation`, the GiST exclusion constraint, the
   ADR-0004-mandated concurrency spike test, the
   `Business.seat_hold_minutes` field + its super-admin-only endpoint,
   the Celery sweep task). Built as one slice because the FK coupling
   above makes them impossible to migrate independently — same "prove
   the hard cross-cutting mechanism in one pass" justification Phase 3
   gave `scheduling`. This is where `docs/adr/0004` actually earns
   "Accepted" status.
3. **`apps/booking`'s creation/cancellation flow** (`create_booking`'s
   full transaction, `POST /bookings/`, `POST /bookings/{id}/cancel/`,
   `GET /bookings/mine/`, `GET /bookings/` for staff, `IdempotencyKey`
   wiring). Depends on both prior slices (needs real fares to price a
   booking, real seats/constraint to reserve one) — sequenced last.

Frontend is deliberately **not** a slice of this spec at all — §7
already states no client-admin/customer-app UI is scoped in this
document (unlike Phase 3, which scoped its own UI slice). A frontend
slice is real future work but belongs to its own spec addendum once
slices 1–3 exist to build against.

Each slice gets its own stop-and-review, per the working agreement —
this is a proposed order, not a request to build all three in one
pass.

**Implementation note (Slice 1, `apps/fares` backend, done)**: built as
planned, with one deliberate deviation from this spec's §3 phrasing and
one real bug found and fixed along the way, both recorded here rather
than silently built —

1. **Two endpoints, not one.** §3 describes a single
   `GET /fare-rules/?route=` that "returns whichever of
   `FareRule`/`FareSegmentRule` applies." Built instead as two distinct
   list-create endpoints — `/fare-rules/` (flat) and
   `/fare-segment-rules/` (per-segment) — since a single serializer
   whose response shape depends on runtime `Business` state is exactly
   the kind of schema-generation ambiguity
   `apps.network.views.RouteListCreateView`'s own `extend_schema_view`
   comment already flags as a real problem in this codebase (one
   serializer class is what `api-client`'s generated `schema.ts` types
   against). Documented in `apps/fares/serializers.py`'s module
   docstring, not just here.
2. **Real bug, caught by this slice's own test suite, not guessed
   at**: `Business.fare_pricing_mode` has a model-level default
   (`flat`), so DRF marks the generated serializer field
   `required=False` — but `BusinessSerializer.create()` indexes
   `validated_data["fare_pricing_mode"]` directly rather than calling
   `Model.objects.create(**validated_data)`, and DRF does **not**
   populate a validated-data key with the model's default when a
   field is simply omitted from the request (that auto-fill only
   happens on the un-overridden create path). Every field this
   `create()` touched before Phase 4 was required, so this gap was
   never exercised until now. Fixed with `.get("fare_pricing_mode",
   Business.FarePricingMode.FLAT)`; four pre-existing Business-creation
   tests that omit the new field caught this immediately once
   `fare_pricing_mode` was added to `Meta.fields`, before it reached a
   manual smoke test.

Also updated: `apps/identity/services.py::DEFAULT_ROLE_PERMISSIONS`
(Manager gets `fares.view`+`fares.manage`, Staff gets `fares.view`,
matching Phase 3's own precedent for new operational-domain
permissions) and the two identity tests that hard-code the full
permission list/set for those roles — the same category of
test-maintenance Phase 3's own network/fleet/scheduling permission
additions required.

Verified: `245 passed` (up from 219 at the end of Phase 3), coverage
97%; `ruff check apps config` / `mypy apps config` clean; migrations
round-trip additive (`businesses.0003`, `fares.0001`,
`identity.0008`), `makemigrations --check --dry-run` reports no drift;
OpenAPI regenerates with the same 4 pre-existing enum-naming warnings
Phase 3 already documented, no new ones. Frontend/e2e: none — out of
scope for this slice per §7 above.

**Implementation note (Slice 2, `apps/seating` + `apps/booking`'s bare
`Booking` model, done)**: built as planned per this section's own
dependency analysis (both apps landed together, `Booking` bare with no
service/view layer of its own yet). `docs/adr/0004` now reads
**Accepted** — the concurrency spike test
(`apps/seating/tests/test_seat_concurrency.py`) exists and passes
reliably. Real findings along the way, not guessed at:

1. **A genuine Postgres behavior the spike test itself surfaced**:
   under real N-way concurrent contention for the same seat/segment,
   Postgres does not always resolve every losing transaction with a
   clean exclusion-constraint violation (`IntegrityError`) — some are
   chosen as the victim of an actual deadlock between transactions each
   waiting on another's row lock while checking the constraint
   (`OperationalError: deadlock detected`, SQLSTATE `40P01`).
   `create_reservation` now catches both and treats them identically
   (`SeatUnavailable`) — see `docs/adr/0004`'s own updated Consequences
   section for the full account. Confirmed via 5 consecutive clean runs
   of the 6-worker spike after the fix, not just one passing run.
2. **A fresh test database needs `btree_gist` created explicitly** —
   confirmed live: `docker/postgres/init-extensions.sql` only runs
   against the dev database at container-init time, not against a
   pytest-created `test_integra_afc` database, which had zero
   extensions installed until this slice's own migration created one.
   Fixed by having `apps/seating/migrations/0001_initial.py` run
   `CREATE EXTENSION IF NOT EXISTS btree_gist` itself rather than
   trusting out-of-band environment setup — the same "own the
   guarantee" principle `apps.core.rls.platform_staff_bypass` already
   established for Celery tasks. `integra_app` (the app's
   non-superuser DB role) can run this since `btree_gist` has been a
   Postgres "trusted" extension since v13 — confirmed empirically
   against this project's own role setup, not assumed.
3. **A real response-shape bug in the new super-admin seat-hold
   endpoint**, caught immediately by its own test, not a manual smoke
   test: `BusinessSeatHoldView` originally returned `BusinessSerializer(updated).data`
   — but `seat_hold_minutes` is deliberately absent from
   `BusinessSerializer.Meta.fields` (§2's whole point), so the
   response silently omitted the field it had just updated. Fixed by
   giving the endpoint its own response shape
   (`BusinessSeatHoldSerializer`, `id` + `seat_hold_minutes` only).
4. **A local-only test-environment gotcha worth recording so a future
   session doesn't mistake it for a real regression**: repeatedly
   re-running the concurrency spike test alone against a `--reuse-db`
   persisted local test database (this project's own `pyproject.toml`
   default) left that shared database's `identity_permission` table
   empty — `pytest.mark.django_db(transaction=True)` tests reset the
   *entire* database via a real flush after they run (they can't rely
   on transaction rollback for isolation, since they test real
   committed transactions), and `flush` does not replay
   `RunPython`-seeded migration data, only `post_migrate`-signal data.
   The very next full-suite run against that same stale database then
   failed 121 unrelated tests across every app, all with the same
   underlying cause (`HasPermission` checks silently failing with no
   `Permission` rows to match against) — resolved with a one-time
   `pytest --create-db` to force a fresh test database; no code change
   was needed, and CI is unaffected (a fresh CI runner never has a
   pre-existing test database for `--reuse-db` to find). Recorded here
   because the failure signature (mass, cross-app, permission-shaped
   failures with no apparent common cause) could otherwise look alarming
   enough to chase as a real regression.

Also updated: `apps/identity/services.py::DEFAULT_ROLE_PERMISSIONS`
(Manager gets `seating.view`+`seating.manage`, Staff gets
`seating.view`) and the same two identity tests Slice 1 already had to
touch, for the same reason.

Verified: `273 passed` (up from 245 at the end of Slice 1), coverage
98%; `ruff`/`mypy` clean; every migration in this slice
(`businesses.0004`, `booking.0001`, `seating.0001`, `seating.0002`,
`identity.0009`) round-trips cleanly, including the exclusion
constraint and RLS operations; OpenAPI regenerates with the same 4
pre-existing warnings, no new ones. Frontend/e2e: none — still out of
scope, per §7.

**Implementation note (Slice 3, `apps/booking`'s creation/cancellation
flow, done)**: built as planned — `apps/booking/services.py` (
`create_booking`, `cancel_booking`), `serializers.py`, `views.py`, and
`urls.py` (`POST /bookings/`, `POST /bookings/{id}/cancel/`,
`GET /bookings/mine/`, `GET /bookings/` for staff), plus the last of
this phase's five permission codenames (`booking.view`,
`identity.0010`). Phase 4's backend is now fully built per §9's
three-slice plan. One deliberate design choice and one real N+1 found
by this slice's own query-count test, both recorded here rather than
silently built:

1. **`IdempotencyKey` handling only memorizes a *successful* attempt,
   not the spec's more literal "wraps lookup/creation around the whole
   operation" phrasing might suggest.** `create_booking` creates the
   `IdempotencyKey` row in the *same* `transaction.atomic()` block as
   the `Booking`/`SeatReservation` rows it guards — a failed attempt
   (no fare configured, a seat conflict) rolls the `IdempotencyKey` row
   back along with everything else, so a retry with the same key after
   a genuine failure is free to try again (e.g. against a different
   seat) rather than being permanently wedged against the failed
   outcome. Only a *matching* replay after a *successful* booking
   returns the original `Booking`; a replay with a different body under
   the same key still raises `IdempotencyKeyConflict` → `409`, per §6.
   A concurrent double-submission of the same key is resolved by
   `IdempotencyKey`'s own unique constraint: the loser's final
   `IdempotencyKey.objects.create()` call raises `IntegrityError`,
   which rolls back that entire attempt (including any `Booking`/
   `SeatReservation` rows it had already written) before the view
   reconciles it against the winner's now-committed row — the same
   narrow-catch-and-reconcile shape
   `apps.seating.services.create_reservation` already established for
   the exclusion constraint. The reusable hashing/exception primitives
   live in a new `apps/core/idempotency.py`, not duplicated into
   `apps/booking` — `docs/architecture.md` already flagged
   `IdempotencyKey` as "ready for Phase 5's payment endpoints," so the
   generic half of this belongs in `core`, matching how
   `apps/core/audit.py` owns `record_audit_event`.
2. **A real N+1, caught by this slice's own `django_assert_max_num_queries`
   test before it shipped**: every FK in `apps.seating` uses
   `related_name="+"` (§2), so `SeatReservation.booking` has no reverse
   accessor — `BookingSerializer.get_seats` cannot `Prefetch()` a
   Booking's reservations the normal way. A naive per-object
   `SeatReservation.objects.filter(booking=obj)` inside `get_seats`
   would have run once per row on `GET /bookings/`, exactly the N+1
   shape `apps.network.views.RouteListCreateView`'s own docstring
   already warns about elsewhere in this codebase. Fixed by having
   `BookingListCreateView.list()`/`BookingMineView.list()` batch-fetch
   every visible page's reservations in one query
   (`_reservations_by_booking`) and pass the grouping into
   `BookingSerializer` via context; `get_seats` falls back to a live
   single-row query only for the genuinely single-object responses
   (`POST /bookings/`'s and the cancel endpoint's own response), where
   one extra query is not an N+1.
3. **No new rate limiting**, per §3's own explicit statement — a
   pre-existing forward-looking comment in
   `config/settings/base.py` (written back in Phase 0/1) speculated
   that "seat-hold and booking endpoints" would need their own throttle
   scopes; this spec's own §3 already overrides that speculation
   ("same throttle posture as every prior phase's non-auth endpoints"),
   so no scope was added for `POST /bookings/` and none was retrofitted
   onto Slice 2's seat-hold endpoint either — left as a known,
   pre-existing (and now stale) comment, not a gap this slice needed to
   close.

Also updated: `apps/identity/services.py::DEFAULT_ROLE_PERMISSIONS`
(Manager and Staff both gain `booking.view` — Staff gets view-only,
consistent with there being no `booking.manage` codename per §2) and
the same two identity tests every prior slice's permission addition
has had to touch.

Verified: `303 passed` (up from 273 at the end of Slice 2), coverage
97%; `ruff`/`mypy` clean; `identity.0010` round-trips cleanly
(unapply/reapply against the dev database); `makemigrations --check
--dry-run` reports no drift; OpenAPI regenerates with the same 4
pre-existing warnings, no new ones (`Booking.status`'s enum folded into
an existing collision group rather than adding a fifth warning).
Frontend/e2e: none — still out of scope, per §7; a UI slice for all of
Phase 4 remains its own future spec addendum.

Phase 4's backend is complete: `apps/fares`, `apps/seating`, and
`apps/booking` are all built, tested, and documented per this spec's
three slices. `docs/adr/0004` is Accepted. What remains before the
platform's commercial loop (a passenger reserving and paying for a
seat) is fully real is Phase 5 (Payments, Wallet, Ledger, gated on
`docs/adr/0006`) transitioning a `Booking` past `pending_payment`, and
the not-yet-scoped Phase 4 frontend slice.
