# 10-Booking-Modes: Open seating, universal Tap & Go, pay-as-you-go

## Scope and non-goals

`Business.booking_mode_default` currently has two values,
`reservation` and `tap_and_go`, and that single enum conflates three
genuinely independent product questions:

- **What do you buy?** A specific seat, or just a place on a departure.
- **How are you identified at boarding?** A ticket QR, or a tap
  credential.
- **When do you pay, and how is the fare determined?** A fixed fare up
  front, or a distance-based fare after travel.

Because they are welded together, "tap and go" currently means all
three at once, and there is no way to express the combination an
operator most often actually wants: *pay up front for an origin and
destination, get a ticket, sit anywhere*.

This spec splits the one enum into orthogonal axes and adds
`open_seating`.

### The resulting model

| Axis | Field | Values |
|---|---|---|
| What you buy | `Business.booking_mode_default` → snapshotted to `Trip.booking_mode` | `reservation` \| `open_seating` |
| Seat choice (reservation only) | `Business.seat_selection_enabled` | bool, default `true` |
| Sell-out policy (open seating only) | `Business.capacity_enforced` | bool, default `true` |
| When you pay | `Business.fare_collection_mode` → snapshotted to `Trip.fare_collection_mode` | `prepaid` \| `pay_as_you_go` |

`tap_and_go` **stops being a booking mode.** It splits in two:

- **The credential is universal.** `TapCredential` (QR or NFC, one
  opaque revocable token) becomes fare media usable in *any* mode. The
  model does not change at all. What changes is that presenting one on
  a prepaid trip resolves to the passenger's existing `Ticket` instead
  of being refused.
- **The fare model is not universal.** `FareJourney`, board/alight
  taps, and distance pricing are inherently pay-after and remain
  incompatible with prepaid modes. That behaviour moves onto
  `fare_collection_mode = pay_as_you_go`.

Naming, settled deliberately: `open_seating` is the established transit
term for "no assigned seat" and says nothing about capacity, which is
exactly the property its two variants share. `seat_selection_enabled =
false` is surfaced to passengers as **"Quick book"**.
`pay_as_you_go` / **PAYG** is TfL's and most global transit's term and
contrasts precisely with a prepaid ticket.

**Do not name the new field `fare_mode`.** `Business.fare_pricing_mode`
already exists and means *how much* (`flat` vs `per_segment`). This
axis is *when*. Conflating the two names in code or conversation will
cost someone an afternoon.

### Non-goals

- No change to `apps.fares` pricing rules, to `apps.ledger`, or to
  ADR-0005's signing *algorithm*. The ticket **payload** changes shape;
  Ed25519-over-CBOR does not.
- No standing-room or overbooking policy beyond the
  `capacity_enforced` boolean.
- No camera-based QR scanning in `validator-app` — still tracked
  separately, still needs a web scanning library.
- No class-of-service or fare tiers.

## Capacity enforcement

Decided in **`docs/adr/0008-open-seating-capacity.md` (Accepted)**:
capacity checks serialize on the `Trip` row via `select_for_update()`,
counting only tickets whose segment overlaps the requested one, because
Postgres can enforce "no two ranges overlap" (ADR-0004's exclusion
constraint) but not "no more than N overlap".

Two obligations come from that ADR and bind this spec directly:

- **Every write path to open-seating tickets goes through the one
  service function that takes the lock.** This is the first
  concurrency invariant in the system with no database-level backstop,
  so a path that creates `Ticket` rows directly would silently defeat
  it — there is no constraint to catch the mistake.
- **The concurrency test in the Test plan below is required, not
  optional**, for the same reason.

## Data model changes

### `businesses.Business`

```python
class BookingMode(models.TextChoices):
    RESERVATION  = "reservation",  "Reservation"
    OPEN_SEATING = "open_seating", "Open seating"
    # TAP_AND_GO removed — it was never a booking mode; see
    # FareCollectionMode below and this spec's Scope section.

class FareCollectionMode(models.TextChoices):
    PREPAID       = "prepaid",       "Prepaid"
    PAY_AS_YOU_GO = "pay_as_you_go", "Pay as you go"
```

New fields, all additive with defaults:

| Field | Type | Notes |
|---|---|---|
| `fare_collection_mode` | `CharField(20, choices, default=PREPAID)` | |
| `seat_selection_enabled` | `BooleanField(default=True)` | Meaningful only when `booking_mode_default == reservation` |
| `capacity_enforced` | `BooleanField(default=True)` | Meaningful only when `booking_mode_default == open_seating` |

The two booleans are deliberately *not* validated against the mode.
Storing an inert value is harmless and keeps a Business's settings
stable across a mode switch and back; the UI hides the irrelevant one
rather than the model rejecting it.

### `scheduling.Trip`

Additive `fare_collection_mode`, snapshotted at creation from the
Business alongside the existing `booking_mode` snapshot — both
`create_manual_trip` and `generate_trips_for_schedule` already do this
for `booking_mode` and gain one line each. Later changes to the
Business default affect only future Trips, unchanged from today.

### `ticketing.Ticket` — the load-bearing change

Today `Ticket.seat_reservation` is a non-null `OneToOneField`, and
`signing.sign_ticket()` takes required `seat_reservation_id` and
`seat_id`. An open-seating ticket has neither.

| Change | Detail |
|---|---|
| `seat_reservation` → `null=True` | Still unique when present |
| New `passenger_index` | `PositiveIntegerField(null=True)`, plus `UniqueConstraint(booking, passenger_index)` — a 4-passenger open-seating booking yields 4 distinct, independently scannable tickets |
| `from_stop` / `to_stop` move onto `Ticket` | Currently read through `seat_reservation`; needed directly for capacity counting and the signed payload |

The "reservation tickets must have a seat reservation" invariant is
enforced in `issue_ticket()`, not as a `CheckConstraint`, because the
mode lives on `Trip` and a check constraint cannot reach across the FK.

### ADR-0005 amendment

`seat_reservation_id` and `seat_id` become **optional** CBOR claims.
This is a payload-shape change, so `docs/adr/0005-qr-ticket-signing-scheme.md`
needs an amendment note recording it.

No dual-read compatibility window is required, because no tickets exist
in production. **State that explicitly in the amendment** rather than
leaving it implied — it is the kind of assumption that becomes
dangerous the moment it silently stops being true.

### `booking.Booking`

Additive `passenger_count` (`PositiveIntegerField`, default 1).
Reservation bookings derive it from their seat count; open-seating
bookings take it from the request.

## Migration impact

Additive fields plus one **data backfill**. Nothing is destructive, so
no explicit approval gate applies (unlike
`docs/specs/4-fares-seating-booking-versioning.md`'s own migrations).

1. **Add all new fields** with defaults.
2. **Data migration** (`RunPython`, with a real reverse function, not
   `noop`):
   - `Business.booking_mode_default == "tap_and_go"` →
     `"open_seating"` **and** `fare_collection_mode = "pay_as_you_go"`.
   - `Trip.booking_mode == "tap_and_go"` → the same pair.
   - Everything else → `fare_collection_mode = "prepaid"`.
   - Backfill `Ticket.from_stop` / `to_stop` from
     `seat_reservation.from_stop` / `to_stop`.
   - Backfill `Booking.passenger_count` from its seat-reservation count.

   This migration touches RLS-protected tables outside an HTTP request,
   so it must call `apps.core.rls.set_rls_session_vars` (or run under
   `platform_staff_bypass()`) itself — otherwise every query is
   silently empty and the backfill is a no-op that looks like a
   success. This is the exact failure mode CLAUDE.md warns about for
   management commands and Celery tasks, and it applies identically
   here.

3. **Then** drop `TAP_AND_GO` from the choices — a state-only
   `AlterField`. Ordering matters for the enum's coherence, not for
   data integrity: `choices` is not a database constraint.
4. `Ticket.seat_reservation` → nullable: a widening `ALTER`, safe.

The dev database has real `tap_and_go` rows (the `seed_e2e_users`
tap-and-go fixture Business, at minimum), so step 2 will do real work
and must be verified, not assumed.

## API surface

| Method | Path | Change |
|---|---|---|
| `POST` | `/bookings/` | Accepts `passenger_count` when the trip is `open_seating`; rejects `seats` in that mode, and rejects `passenger_count` in `reservation` mode |
| `GET` | `/trips/{id}/availability/` | **Breaking:** array → envelope, serving both modes. See "Availability and bookability" below |
| `GET` | `/trips/search/` | Filter widens from `booking_mode=reservation` to `fare_collection_mode=prepaid`, so open-seating trips become bookable by passengers |
| `POST` | `/trips/{id}/tickets/validate/` | Shape unchanged; must accept a payload carrying no seat claims |
| `POST` | `/trips/{id}/taps/` | Gate moves from `booking_mode` to `fare_collection_mode` |
| `GET`/`PATCH` | `/businesses/`, `/businesses/{id}/` | Three new writable fields |

## Availability and bookability

Today `GET /trips/{id}/availability/` returns a bare array of seat
rows, and `get_availability` returns `[]` in two quite different
situations: the trip has no vehicle assigned yet, or every seat is
taken for the requested segment. `seat-picker.ts:99`
(`hasSeats = availability().length > 0`) therefore renders "not open
for booking yet" and "sold out" identically. A passenger cannot tell
them apart, and neither can an operator looking at the same screen.

Open seating would have doubled that problem — capacity is read
through `vehicle.vehicle_type.capacity`, so an unassigned vehicle
means unknown capacity, and a bare `capacity_remaining: 0` would be an
outright lie (it reads "sold out" when the truth is "not configured").
So both modes get one shared answer rather than two accidental ones.

**One envelope, both modes:**

```jsonc
{
  "booking_mode": "reservation" | "open_seating",
  "status": "open" | "not_configured" | "sold_out",
  "seats": [ /* SeatAvailability rows; [] for open_seating */ ],
  "capacity_remaining": 12 | null   // open_seating only; null = unlimited
}
```

| `status` | Means | Reservation | Open seating |
|---|---|---|---|
| `not_configured` | Not bookable yet; an operator fixes it | No vehicle assigned, **or** the vehicle type has zero active seats | No vehicle assigned (only when `capacity_enforced`) |
| `sold_out` | Genuinely full for this segment | Every active seat occupied | `capacity_remaining == 0` |
| `open` | Bookable | Otherwise | Otherwise; always `open` when `capacity_enforced` is false, with `capacity_remaining: null` |

`create_booking` refuses a `not_configured` trip with an error code
**distinct** from the sold-out and seat-taken cases, so the frontend
can word them differently rather than saying "sold out" about a
departure nobody has assigned a bus to.

This keeps open seating consistent with the behaviour reservation mode
already has — `get_availability`'s own docstring calls the vehicle-less
case "the same non-error *not yet configured* state … not a 400/404" —
rather than inventing a parallel rule for one mode.

**This is a breaking response-shape change** (array → object). Exactly
one consumer exists, `customer-app/src/app/trip-search/seat-picker.ts`
(four touch points: the `GET`, `availability.set()`, `hasSeats`, and
the seat map). `api-client/schema.ts` is generated from the OpenAPI
spec, so every call site fails to compile until updated — the same
mitigation the `Booking.status` enum change already relied on. Doing it
once is cheaper than bolting a parallel bookability endpoint alongside.

## Gates that must change

Found by sweep. Each is a real behavioural gate, not a passing mention;
missing any one of them leaves a mode silently unreachable or wrongly
reachable.

| Location | Today | Becomes |
|---|---|---|
| `apps/tapngo/services.py:114` | `trip.booking_mode != TAP_AND_GO` | `trip.fare_collection_mode != PAY_AS_YOU_GO` |
| `apps/booking/serializers.py:85` | rejects anything but `reservation` | accepts `reservation` and `open_seating`; rejects on `fare_collection_mode != prepaid` |
| `apps/scheduling/views.py:183` (`TripSearchView`) | `booking_mode=RESERVATION` | `fare_collection_mode=PREPAID` |
| `validator-app/record-tap.service.ts:72` | `=== 'tap_and_go'` | `fare_collection_mode === 'pay_as_you_go'` |
| `validator-app/validate-ticket.service.ts:58` | `!== 'tap_and_go'` | `fare_collection_mode === 'prepaid'` |

## Edge cases

- **Open-seating trip with no vehicle assigned, `capacity_enforced =
  true`.** Capacity is unknowable (`Trip.vehicle` is nullable, and
  capacity is read through `vehicle.vehicle_type.capacity`), so
  availability reports `status: "not_configured"` and booking is
  refused — the same treatment reservation mode already gives the
  identical condition. Treating unknown capacity as unlimited is the
  worse failure; see ADR-0008. **Not an edge case in practice:** the
  Celery generator creates every scheduled trip with no vehicle at all
  (`apps/scheduling/tasks.py`'s `get_or_create` `defaults` omit it),
  and staff assign one later from the trip list — so this is the normal
  early state of nearly every trip, not a rare misconfiguration.
- **`capacity_enforced` flipped false → true on an already-oversold
  trip.** Existing bookings stand; new ones are refused. Never
  retroactively cancel a paid booking because a setting changed.
- **Business switches `booking_mode_default` mid-life.** Existing Trips
  keep their snapshot. Unchanged from today's behaviour, and the reason
  `seed_e2e_users` needs a separate Business per mode.
- **Quick book requesting more seats than are free.** All-or-nothing;
  no partial allocation. Same rule as today's multi-seat booking.
- **A Business whose `fare_collection_mode` and a Trip's snapshot
  disagree** after a config change: the Trip's snapshot wins,
  everywhere, without exception.
- **Tapping a credential on a prepaid trip with no ticket for that
  passenger.** 404 with a message saying no ticket was found — never a
  silently-opened PAYG journey, which would charge a passenger on a
  service that does not work that way.
- **Open-seating booking cancelled or expired.** Its tickets must stop
  counting against capacity immediately, or a departure silently loses
  places over time.

## Failure modes

- **Concurrent open-seating bookings racing the last place.** The
  ADR-0008 mechanism. Mandatory concurrency spike: real threads, real
  committed transactions, `@pytest.mark.django_db(transaction=True)`,
  mirroring `apps/seating/tests/test_seat_concurrency.py`. Note that
  such a test flushes the entire reused test database including
  `RunPython`-seeded migration data — expect the suite to need
  `pytest --create-db` afterwards, exactly as CLAUDE.md documents.
- **Backfill interrupted mid-migration.** Wrapped in the migration's
  own transaction; a partial state is impossible. The realistic risk is
  not partial write but *silent no-op* from missing RLS session vars —
  see Migration impact, and assert row counts rather than trusting a
  clean exit.
- **A ticket signed before the payload amendment.** Cannot exist in
  production; asserted in the ADR amendment rather than assumed.

## Test plan

**Backend.** Booking creation in each mode and each boolean
combination; capacity counting with overlapping *and* non-overlapping
segments (the whole point of segment-awareness); the ADR-0008
concurrency spike; the backfill migration tested **forwards and
backwards**; ticket issuance with and without a seat; validating a
seatless signed payload; the PAYG gate rejecting a prepaid trip and
vice versa; cross-client isolation on every new or widened queryset;
capacity released on cancellation.

The availability envelope needs all three `status` values covered in
**both** modes — in particular a vehicle-less trip returning
`not_configured` rather than `sold_out` in each, since conflating those
two is the specific defect this change exists to fix, and a test
asserting only "not bookable" would pass either way.

**Frontend.** The business form's three new controls, including the
show/hide logic for the mode-specific booleans; customer-app's booking
flow branching between seat picker and passenger-count; validator-app's
two trip pickers filtering on the new field.

`seat-picker` needs a test per `status`: `not_configured` must render
as "not open for booking yet", **not** as sold out. Its current
`hasSeats` computed (`availability().length > 0`) becomes
status-driven, which is the change that actually fixes the
conflation — a test that only checks "no seat map is shown" would pass
against the old behaviour too.

**E2E.** One open-seating purchase through to a scanned ticket, added
to `frontend/e2e/`. `seed_e2e_users` needs an open-seating Business
fixture for exactly the reason it already needs a tap-and-go one: mode
is snapshotted per-Trip from the Business default and cannot vary
within one Business.

## Slicing

Stop for review between each.

1. **Backend model + backfill.** New fields, the data migration, the
   `Trip` snapshot, and every gate in the table above. No new
   behaviour; `tap_and_go` businesses keep working identically under
   their new names. This slice is verifiable purely by the existing
   suite continuing to pass plus the migration's own tests.
2. **Open-seating booking + capacity** (needs ADR-0008 Accepted).
   `passenger_count`, seatless ticket issuance, the availability
   endpoint's second shape, and the concurrency spike.
3. **Universal tap.** Resolving a tapped credential to an existing
   `Ticket` on prepaid trips in `validator-app`.
4. **Frontend + the item-8 rename** (below).

## Item 8 — the rename, concretely

**Docs:** `CLAUDE.md`; `docs/architecture.md`;
`docs/executive-overview.md`; `docs/specs/4b-tap-and-go.md` — add a
fifth implementation note recording the reframe rather than rewriting
its history, matching how every other superseded decision in this repo
is handled; `docs/adr/0005` — the payload amendment.

**UI strings:** `validator-app`'s nav and both screens;
`customer-app`'s `credentials` screen — which is already correctly
named "Tap & Go", because it issues the *credential*, which is the half
that genuinely becomes universal. That naming needs no change, which is
itself worth recording so a future reader does not "fix" it.

**One live blocker:** the Tap & Go nav link is currently commented out
in an uncommitted working-tree edit to
`customer-app/src/app/app-shell.ts`, while `app-shell.spec.ts` still
expects six links — which is why that spec currently fails. Resolving
that (restore the link, or update the spec and say why) belongs to this
slice.

---

## Implementation note (Slice 1 — model, backfill, gates, done)

Built to the spec. Every gate in the "Gates that must change" table was
still exactly where that table said, so the sweep behind it held up.
643 backend tests passing, up from 631.

### The migration, and one real defect it exposed

Four migrations rather than the spec's implied two, so the ordering is
real rather than incidental:

1. `businesses/0009_booking_mode_axes` — the three new `Business`
   fields.
2. `scheduling/0004_booking_mode_axes` — `Trip.fare_collection_mode`.
3. `businesses/0010_backfill_booking_mode_axes` — the `RunPython`
   split, with a real reverse.
4. `businesses/0011` + `scheduling/0005` — the choices narrowing,
   held back so the enum is never narrower than the data it describes.

**The backfill was initially wrong, and its own test caught it.** It
read through `Model.objects`, which in a migration is a plain unscoped
manager (`AlterModelManagers` serialises it that way — see
`businesses/0005`) but in the live registry is `TenantScopedManager`.
Every test failed as a silent no-op: the update matched zero rows and
exited cleanly. That is precisely the failure the spec warns about,
arriving through the ORM rather than through RLS.

Two things came out of it, both improvements:

- **The backfill now reads through `all_objects`.** This is deliberately
  a cross-client operation, so it uses the manager this codebase makes
  grep-able for exactly that — and it behaves identically under
  historical and live registries, which is what lets the test call the
  functions directly and mean something.
- **The completeness assertion was tautological and is now not.** The
  original compared `.update()`'s return against a count taken through
  the same manager: hide the rows and both are zero and it passes while
  nothing moved. It now counts *remaining* `tap_and_go` rows in raw SQL,
  which removes the manager from the loop. Worth being precise: raw SQL
  bypasses ORM tenancy filtering, **not** RLS — that is covered by the
  `set_rls_session_vars` call at the top, which is what the ORM manager
  turned out not to be.

**Verified against the real dev database**, not just the test suite: 5
businesses and 20 trips held `tap_and_go` going in. Forward → reverse →
forward landed on identical counts each time (5 `open_seating` +
`pay_as_you_go`, 85/471 `prepaid`, zero `tap_and_go` remaining).

### Two tests that changed meaning, not just names

`test_record_tap_rejects_a_reservation_mode_trip` failed after the
gate moved, correctly — it asserted the old semantics. Under the split,
`booking_mode` does not gate taps at all. It is replaced by two tests
that assert the axes separately: a **prepaid** trip refuses taps, and a
**reservation trip that is pay-as-you-go** accepts them. The second is
the one that would have caught a lazy rename.

### Deviations from the plan, both deliberate

- **All `Ticket`/`Booking` schema changes moved to slice 2.** The plan
  put `Ticket.seat_reservation`'s widening here, but nothing in slice 1
  can create a seatless ticket, so it would have been a nullable column
  with no consumer for a whole slice — and slice 2 needs its own
  `Ticket` migration regardless. One migration instead of two.
- **Two client-admin UI sites were touched early.** `business-form`'s
  mode options and `trip-form`'s label both stopped compiling the moment
  `tap_and_go` left the generated enum. The full form treatment (three
  controls, show/hide) is still slice 4; this was the minimum to keep
  the build green between slices, which is not something to defer.

The generated-types mitigation the spec counted on worked exactly as
described — `npm run openapi:generate` turned every stale fixture into
a compile error rather than a silent runtime mismatch, across
`validator-app` and `client-admin-app`.

### Fixture naming, recorded so it is not "fixed" later

`seed_e2e_users`' tap fixture is now `open_seating` + `pay_as_you_go`
but keeps its "Integra E2E Tap & Go Business" name. What it exercises
is the tap *credential*, which is the half that genuinely stayed
universal — the name is still accurate, and renaming it would churn
`prune_e2e_test_data` and the validator e2e specs for nothing.

### State going into slice 2

- 643 backend tests passing; the only red one is
  `apps/ticketing/tests/test_ticket_completion_concurrency.py`, which
  was already failing before this slice and belongs to uncommitted
  booking-completion work. **Diagnose it before slice 2 builds on
  `mark_booking_completed_if_fully_boarded`** — open-seating bookings
  issue N seatless tickets and must drive completion the same way.
- `customer-app`'s `app-shell.spec.ts`, listed as slice 4's blocker,
  resolved outside this work: the nav link was restored in the working
  tree. Slice 4 no longer owns it.
- e2e: validator 5/5, customer 10/10, super-admin 16/16, client-admin
  70/71 — the one failure being F6's trip dropdown, still honestly red
  and still out of scope.

## Implementation note (Slice 2 — open seating, capacity, done)

Built. 666 backend tests passing, up from 646. Every frontend suite
green; e2e green per project except F6's known-red bookings filter.

### The product decision, and what it changed

Capacity counts **issued tickets only** — unpaid bookings hold nothing,
and an oversold departure is remedied commercially. That superseded
ADR-0008's assumption that capacity would be enforced, and the ADR now
carries an amendment saying so.

The consequence is unavoidable and worth restating: tickets are issued
at payment, so N passengers can each be told there is room, all pay,
and the departure oversells. The `Trip` row lock cannot prevent that.
Its job moved from prevention to **detection**: a consistent count, and
a `trip.oversold` audit record for every issuance that crosses the
line. `apps/ticketing/capacity.py`'s module docstring is the primary
reference for exactly what is and is not guaranteed.

**The concurrency test asserts that, not the property the system lost.**
Writing it as "exactly one succeeds" would have failed for the right
reason while telling the reader the wrong story. It pins three things
instead: concurrent issuance never loses or duplicates a ticket; every
oversell is recorded *exactly once* (a duplicate would double-refund, a
miss would strand a passenger); and a demonstrably full departure still
refuses new bookings.

**Named gap:** the remedy has no code path. There is no refund service,
and `apps/wallet/services.py` is read-only. Acting on a `trip.oversold`
record is manual today. Its own slice.

### Additions to this spec, all necessary rather than opportunistic

- **`Booking.from_stop`/`to_stop`.** The spec listed only
  `passenger_count`, but an open-seating booking had nowhere to record
  *which journey* was bought: there are no seat rows to read a segment
  from, and issuance happens later, at payment. Nullable, because a
  reservation booking's journey is per-`SeatReservation` and can
  legitimately differ between seats.
- **`Ticket.segment_range`.** Mirrors `SeatReservation.segment_range`
  exactly. Capacity counting is a segment-overlap query; doing it by
  joining `RouteStop` per request would be per-booking work on the hot
  path, and `&&` on a range column is the pattern this codebase already
  uses for the identical question.
- **`ticket_id` in the signed payload.** The spec's ADR-0005 amendment
  said the seat claims become optional but not what replaces the
  *lookup key*. `validate_ticket` resolved a ticket by
  `seat_reservation_id`, which an open-seating ticket does not have. One
  key that works in both modes beats branching on mode in the validator.
  ADR-0005 amended accordingly, including the explicit statement that no
  dual-read window is needed because no tickets exist in production.

### Two real bugs found while building

1. **`issue_ticket` under `platform_staff_bypass()` saw zero
   `RouteStop` rows.** Deriving `segment_range` called
   `segment_sequence_range`, which reads `RouteStop.objects` — and
   bypass sets the Postgres GUCs but deliberately never touches the
   Python tenancy contextvar. It surfaced as a misleading "Both stops
   must be on the route." Fixed two ways: reservation tickets now reuse
   `seat_reservation.segment_range` (already correct, zero queries, and
   drift between a ticket and its reservation becomes impossible), and
   `segment_sequence_range` gained an explicit `tenant_scoped=False` for
   the open-seating path that genuinely needs the lookup. Exactly the
   trap CLAUDE.md documents, hit for real.
2. **The validator response read stops through `seat_reservation`.**
   Now nullable, so an open-seating scan would have crashed. Stops come
   off the `Ticket` itself; `seat_number` is null for a seatless ticket,
   which is the honest answer — the validator shows a blank rather than
   inventing a seat.

### The breaking availability change

`GET /trips/{id}/availability/` returns an envelope
(`{booking_mode, status, seats, capacity_remaining}`). It fixes a real
pre-existing defect: `get_availability` returned `[]` both for "no
vehicle assigned" and "every seat taken", so `seat-picker` rendered a
departure nobody had assigned a bus to as sold out.

Regenerating `schema.ts` turned every consumer into a compile error, as
the spec expected. **Slice 2 unwraps `.seats` and nothing more** —
acting on `status` changes what a passenger is told and belongs in
slice 4 with its own tests and visual pass. Two e2e specs and one
component spec needed the same one-line unwrap.

`create_booking` now refuses with three distinct outcomes rather than
one: `not_configured` (409, no vehicle — the operator's problem),
`sold_out` (409 — the passenger's), and the existing seat-taken
conflict. Conflating the first two is the defect this slice exists to
fix, so the API test asserts the code *and* that the message does not
say "sold out".

### Migration

Four migrations across two apps, add → backfill → tighten, following
slice 1's discipline (`all_objects`, `set_rls_session_vars`, raw-SQL
leftover count, a real reverse). Verified on the dev database, which
had 7 tickets and 170 bookings: every ticket's backfilled
`segment_range` matches its reservation's exactly, 4 multi-seat
bookings correctly picked up `passenger_count = 2`, and forward →
reverse → forward landed on identical counts.

### State going into slice 3

666 backend tests green, zero known-red backend tests. e2e: customer
10/10, validator 5/5, super-admin 16/16, client-admin 70/71 (F6, still
out of scope). The frontend compiles against the new envelope but does
not yet *use* `status` — that, the business form's three controls, the
seat-picker's per-status states and the open-seating e2e fixture are
slice 4.

---

## Implementation note (Slice 3 — universal tap, done)

Built. **680 backend tests passing**, up from 666, zero red. Every
frontend suite green (`validator-app` 41, up from 31). e2e green per
project except the two client-admin failures named at the end of this
note, neither caused by this slice.

Presenting a `TapCredential` on a prepaid trip now boards the `Ticket`
that passenger already holds, instead of being refused. That is the
whole slice: no new model, no migration, one new service function and
one widened request body.

### Where it lives, and why not on `/taps/`

`POST /trips/{id}/tickets/validate/` takes **either** `payload` (a
scanned ticket QR) **or** `token` (a credential), exactly one, enforced
in `TicketValidateSerializer.validate()` — DRF has no native "exactly
one of", and making either field required would make the other
impossible to send alone.

Widening `POST /trips/{id}/taps/` instead was rejected: its response is
a `TapEvent`, whose `journey` FK is non-null, and a prepaid trip opens
no journey. That endpoint could only have answered with a union type,
and `ticketing.validate` is already the permission that matches the
action. Both codenames sit together in the Manager and Staff presets,
so no permission change was needed.

**One shared boarding body.** `validate_ticket` and
`validate_credential` now differ *only* in how the Ticket is resolved;
everything from the row lock onwards — the time window, the status
checks, the boarded write, `mark_booking_completed_if_fully_boarded`,
the `IdempotencyKey` write, and the already-boarded reconciliation — is
one private `_board()` taking a resolver callable. Copying it was the
obvious alternative and would have been wrong: that reconciliation is
the fix for a real race (see Phase 6's own Slice 2 note), and a second
copy is where such a subtlety quietly rots.

`apps.tapngo.services._resolve_credential` was promoted to public
`resolve_credential` and is called directly, along with its existing
`UnknownToken`/`CredentialInactive` exceptions. A second copy of a
security-relevant hash-and-lookup is not worth avoiding one import;
`apps.tapngo` imports nothing from `apps.ticketing`, so there is no
cycle.

### Group travel decided the resolution rule

A passenger can hold several tickets on one trip — four on an
open-seating group booking, two seats in reservation mode. Refusing
that as "ambiguous" would make group travel unboardable by credential,
so **one tap boards one ticket, oldest first**, and the tap after the
last one 409s. The resolver picks; `_board()` judges — if nothing is
`issued`, it hands back the first ticket anyway so the shared body can
say *why* (already boarded, revoked, expired) rather than collapsing
three situations into one message.

Two locking details worth keeping:

- The whole (small) ticket set is locked, not
  `.filter(status=ISSUED).first()`. Under `FOR UPDATE` a `LIMIT 1` can
  come back empty for a racing second tap even while another unboarded
  ticket exists, because the plan has already fixed its candidate row.
- Bookings are resolved in a separate query so the locking `SELECT`
  carries no join — `FOR UPDATE` across a join would lock the `Booking`
  and `User` rows too.

### The edge case this slice exists for

A credential with no ticket on the trip returns **404**, and a
pay-as-you-go trip presented with a token returns **400** telling the
operator to record a board tap instead. Both tests assert
`FareJourney.objects.count() == 0` explicitly rather than just the
status code: "never a silently-opened journey" is the property, and a
status-only assertion would pass even if one were opened.

### One screen, not two (a product decision taken during the slice)

`record-tap` now lists trips in **both** fare collection modes and
branches on the selected trip's `fare_collection_mode`: prepaid boards
a ticket, pay-as-you-go opens or closes a journey. The alternative — a
fare-media toggle on the validate-ticket screen — was offered and not
taken. A conductor scans; the app works out what that means.

The screen keeps its name. "Record a tap" survived the reframe intact:
the passenger did tap, and tapping is exactly the half of tap-and-go
that became universal.

`stopId` is **disabled**, not merely hidden, on a prepaid trip. It
carries `Validators.required`, and a hidden-but-required control leaves
the form invalid with nothing on screen to explain why — the submit
button would simply do nothing. The prepaid branch also skips the route
stops fetch entirely, since it offers no stop picker.

### A real pre-existing bug, found by the e2e and fixed

**`selectedTrip` never updated.** Both validator screens declared

```ts
computed(() => this.trips().find((t) => t.id === this.form.controls.tripId.value))
```

which depends on **no signal at all** — `trips()` is its only reactive
dependency, so once evaluated it cached "nothing selected" forever. The
trip-detail line under the picker had therefore been dead since it was
written, in both screens, and this slice's `isPrepaid()` inherited the
same defect: the browser showed a prepaid trip selected with the
pay-as-you-go controls still on screen.

Fixed with `toSignal(form.controls.tripId.valueChanges)` in both
components (`@angular/core/rxjs-interop`, following `nav-shell.ts`'s
existing precedent).

The unit tests passed against the bug and the e2e did not, for a
reason worth remembering: in Karma the computed happened to be left
dirty by the trips load and recomputed on its next read, while a real
browser renders in between and leaves it clean. **Both screens now
carry a rendered assertion** — the route name and the mode appearing in
the DOM — because reading the signal from a test passes against the bug
it is meant to catch.

### Verification

Full backend suite, `ruff`, `mypy`, no OpenAPI drift, `build:all`,
`test:all`, and Playwright per project. Live over real HTTP against
`runserver` plus the `postgres`/`redis` containers (the backend image
still predates Phase 6's crypto deps, as Phase 6's own note records):
the credential POST reaches `/tickets/validate/`, no `/taps/` request
is made on a prepaid trip, and the operator is shown whatever the
backend decided.

The new e2e deliberately **does not** assert a status code. The fixture
credential's passenger accumulates real bookings on the shared bookable
route across runs and manual verification, so 200, 404 and 409 are all
reachable depending on this database's history — pinning one would be a
flake dressed as an assertion. It asserts the branch instead: the POST
goes to ticket validation, no tap is recorded, and the result is
reported. Boarding a known-fresh ticket needs a paid-booking fixture,
which arrives with slice 4.

`record.spec.ts` also stopped selecting its trip by index. The picker
now lists every mode, and this dev database seeds several routes for
today, so an index silently selected whichever trip departed earliest.

### Two client-admin e2e failures, neither from this slice

- `bookings.spec.ts` — F6, the trip dropdown that cannot reach recent
  trips. Known, still out of scope, still honestly red.
- `trips.spec.ts::filters the list by service date` — **newly tripped,
  not newly broken.** The test creates a trip on a fixed date and
  asserts it is visible with only a date filter applied; that date now
  holds **29** accumulated trips against a page size of 25, so the new
  row lands on page 2. Same family as F6 and as the Business-list cruft
  `prune_e2e_test_data` was written for. Named, not fixed.

### State going into slice 4

680 backend tests green, zero known-red backend tests. Frontend:
customer 120, client-admin 326, super-admin 67, validator 41, shared-ui
58, layout 39, auth 26, shared-data 12. e2e: customer 10/10, validator
6/6, super-admin 16/16, client-admin 69/71 (both failures above).

Slice 4 is unchanged in scope: the business form's three controls,
`seat-picker`'s per-`status` states, customer-app's open-seating flow,
super-admin's seat-hold screen, the item-8 rename, the open-seating
e2e fixture, and the §10.6 visual pass.

---

## Implementation note (Slice 4 — frontend, quick book, the rename, done)

Built. **690 backend tests passing**, up from 680. Frontend: customer
135, client-admin 333, super-admin 70, validator 41, shared-ui 58,
layout 39, auth 26, shared-data 12 — all green. e2e green per project
except the two client-admin failures named below, neither from this
slice. **This closes Phase 10.**

### Quick book got built, not just exposed

The spec's slice 4 asked only for the *control*. Building it that way
would have shipped a switch that does nothing: `seat_selection_enabled`
was stored from slice 1 and read by **no code anywhere**, so an
operator could turn seat choice off and watch passengers keep choosing
seats. That is the exact "writable field with no behaviour" defect spec
12 existed to fix for `fare_pricing_mode`, so it was put to the user as
a decision and built.

`POST /bookings/` now accepts `passenger_count` on a reservation trip
whose Business has seat selection off, and allocates that many free
seats server-side (`apps.booking.services._allocate_seats`). Three
decisions inside it are worth keeping:

- **Read live off the Business, not snapshotted per Trip** like
  `booking_mode` and `fare_collection_mode` are. Those two describe
  *what was sold*, and changing them under an existing booking would
  rewrite its terms. This one only describes how the seat gets picked;
  a booking made either way ends up holding the same named seats, so
  flipping it mid-week invalidates nothing.
- **Explicit allocation order.** `Seat.Meta.ordering` is `-created_at`,
  so inheriting it would hand out the most recently *added* seat first
  — scattering a group around the vehicle and giving away whichever odd
  seat a later seat-map edit appended. Row, then column, then seat
  number.
- **No lock needed.** Unlike open seating, this path has a real
  database constraint behind it: two concurrent quick books that pick
  the same seat collide on the GiST exclusion constraint inside
  `create_reservation` and one rolls back whole (ADR-0004).

The availability envelope gained `seat_selection_enabled`, which is
**not** simply the Business field of that name — it answers "may a
passenger pick a seat on *this trip*", and so is always false for open
seating, which has no seats to pick. A client reading the Business
field directly would render a seat map for a trip that has none.

### One screen, two ways to buy

`seat-picker` now branches on the envelope rather than on the seat list
being empty — the inference that caused the original defect. Open
seating and quick book take the same path (a passenger-count select),
because from a passenger's side they are the same question; the *copy*
differs, because they are not the same answer. Telling a quick-book
passenger holding seat 3B to "sit anywhere that's free" would be
plainly wrong.

`BookingRequest` became a discriminated union (`kind: 'seats' |
'places'`) rather than one shape with optional halves. `booking-confirm`
sends a genuinely different request body for each and the backend
refuses the wrong one outright, so "both" and "neither" being
representable was worth designing out.

The three `status` values are now load-bearing, with a test per value
per mode. The spec anticipated the trap and it was real: the test
helper originally *derived* `status` from whether the seat list was
empty, which would have let every test pass against the exact
conflation the envelope exists to fix. It states `status` explicitly
now.

### The rename, and what deliberately did not get renamed

`client-admin-app`'s nav item and journey list read **Pay as you go**,
because what they list is `FareJourney` rows, which only exist where
the fare is charged after travel. The route path stays `/tap-go`.

`customer-app`'s `credentials` screen and the `seed_e2e_users` tap
fixture keep their "Tap & Go" names, per the spec — both are about the
*credential*, the half that stayed universal. `docs/specs/4b-tap-and-go.md`
gained its fifth implementation note recording the reframe rather than
rewriting its history.

### Super-admin's seat-hold screen

Nothing is held in open seating, so that screen was letting platform
staff tune a number that changes nothing, with no way to tell. It now
says so, in an amber notice, while leaving the field editable — the
stored value must survive a mode switch and back. Needed one small
backend addition: `booking_mode_default` on
`BusinessSuperAdminSerializer`, which had no other way to know.

### E2E, and the half that cannot be automated

`seed_e2e_users` gained a **prepaid open-seating** Business (its own,
like every other fixture — mode is snapshotted per Trip).

The spec asked for "one open-seating purchase through to a scanned
ticket". That cannot be one test: **paying leaves the app for Paystack,
which no browser can complete.** It is split, honestly, the same way
`bookings.spec.ts` already splits its own:

- `customer-app/open-seating.spec.ts` buys places through the real UI
  and stops at `pending_payment`, exactly where the reservation flow's
  e2e also stops. It asserts the arithmetic (`900.00 × 2 = 1800.00`),
  that no seat map is offered, and that the confirm screen shows a
  passenger count rather than a blank Seats row. It cancels its own
  booking so repeated runs do not pile up.
- `validator-app/validate-ticket.spec.ts` — **the first e2e this screen
  has ever had** — boards a real seatless Ticket and asserts the
  validator shows no seat label. The Ticket is seeded, not bought:
  `_seed_boardable_open_seating_ticket` calls `mark_booking_paid`
  directly, and reseeds whenever the previous run boarded one, since a
  Ticket is single-use.

That seeded booking is `paid` with **no** `PaymentIntent` and no ledger
entry behind it. Deliberate and dev/CI-only — the point is a valid
signed Ticket, not a faithful money trail — and named here rather than
left for someone to find.

Seeding it also hit the trap CLAUDE.md documents for management
commands: `create_booking` reads through `.objects`, and
`platform_staff_bypass()` sets the Postgres GUCs but never the Python
contextvar, so the first lookup raised `Trip.DoesNotExist` for a Trip
that plainly existed. Fixed by setting the contextvar around that one
call.

### Visual pass

`docs/ui-review/10-booking-modes/`, two iterations. Five in-scope
defects found and fixed, of which two were real rather than cosmetic:

- **The switch's explanation was a loose `<p>`** with no
  `aria-describedby` — sighted users got the guidance, screen-reader
  users got a bare switch. Exactly the trap CLAUDE.md already records
  by name for `ui-select`'s `hint`. `ui-toggle` gained a `describedBy`
  input.
- **"your places are held once you reserve" was false.** Open seating
  holds nothing; a place is counted when a ticket is issued at payment.
  The copy had been inherited wholesale from the reservation flow.

One defect is recorded and **not** fixed: `customer-app`'s nav
collapses and overflows horizontally at **390px, the authoritative
passenger viewport** — "Tap & Go" wraps onto three lines and "Sign out"
overlaps "Journeys". It is pre-existing (nothing here touches
`app-shell`) and needs a responsive nav rather than a CSS tweak
smuggled into this slice, but it is the most serious visual defect on
any screen this slice touched.

### Two client-admin e2e failures, neither from this slice

- `bookings.spec.ts` — F6's trip dropdown. Known, out of scope, red.
- `trips.spec.ts::filters the list by service date` — accumulated
  fixture data pushed the row past page 1 (29 trips on the fixture date
  against a page size of 25). Diagnosed in slice 3's note; still not
  fixed.

A third failure **was** this slice's and is fixed:
`businesses.spec.ts`'s keyboard-only test tabs a counted number of
times through the form, and three new controls moved the submit button.
The tab stops are now named one per line, so the next person to add a
control sees what they are changing — and the test proves the new
switch is keyboard-reachable, which is worth having.
