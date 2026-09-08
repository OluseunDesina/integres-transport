# 18-Manifest-and-Staff-Booking: Who is aboard, and booking at the counter

Sixth spec of the Transit OS adoption arc. Depends on spec 15 (the
manifest shows a trip's class).

## Scope and non-goals

Two operator capabilities the brief requires, both of which are joins
and flows over data that already exists rather than new domains.

1. **Trip manifest** — "accessible from trip actions and from trip
   details", showing bookings, passengers, seat allocations, ticket
   references, fare and status. Every field exists across `booking`,
   `ticketing`, `seating` and `identity`. Nothing assembles them.
2. **Staff booking** — the brief lists "Staff Booking" as a primary
   area. `POST /bookings/` books for `request.user` and has no way to
   book on someone else's behalf, so a counter agent cannot serve a
   passenger who walked up.

### In scope

- `GET /trips/{id}/manifest/`, branching on fare collection mode.
- Staff-initiated booking for an existing passenger, reusing
  `create_booking` unchanged.
- Optionally settling that booking from the passenger's wallet, reusing
  the existing wallet payment service.
- `client-admin-app` manifest screen and counter-booking flow.

### Non-goals

- **No cash tender.** ADR-0006's chart of accounts has `wallet`,
  `business_clearing`, `integra_commission`, `psp_suspense` and
  `refund_contra`. There is no cash account, and inventing one is a
  ledger change requiring an ADR amendment, a float/reconciliation
  model, and a cash-drawer story. A counter agent using this flow takes
  payment through the passenger's wallet or leaves the booking
  `pending_payment` for the passenger to pay. **This is the single
  biggest limitation of the staff-booking half and it is deliberate.**
- **No account creation on a passenger's behalf.** Staff booking
  requires an existing passenger account, looked up by email or phone.
  Creating one for a walk-up needs consent, credential delivery and a
  claim flow — its own spec, not a field on this form.
- **No manifest editing.** It is a read view. Moving a passenger
  between seats or trips is a rebooking, and no rebooking service
  exists.
- **No printed/PDF manifest.** CSV export via spec 16's export
  endpoint covers the operational need.
- No boarding *action* from the manifest — boarding happens in
  `validator-app` against a scanned ticket or credential, and adding a
  second, unscanned way to mark someone boarded would undermine the
  signed-ticket guarantee ADR-0005 exists for.

## Data model changes

**None.** Both features are compositions over existing models.

The manifest reads `Booking`, `SeatReservation` (for seat number and
the snapshotted price), `Ticket` (reference and boarding status),
`identity.User` (passenger identity), and `Trip` (class, mode). For a
pay-as-you-go trip it reads `tapngo.FareJourney` instead — see below.

Staff booking calls `apps.booking.services.create_booking()` with a
`passenger` other than the requesting user. That parameter already
exists; nothing about seat allocation, fare quoting, idempotency or the
open-seating capacity lock changes. **This is the whole point of
routing through the service rather than writing a second booking
path** — the ADR-0008 `Trip` row lock is application-code-only, with no
database constraint behind it, so a second write path that forgot to
take it would silently oversell with nothing to catch it.

## API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/trips/{id}/manifest/` | `booking.view` | Paginated; envelope described below |
| `POST` | `/bookings/staff/` | `booking.manage` | Book for another passenger |
| `GET` | `/passengers/lookup/` | `booking.manage` | Resolve a passenger by exact email or phone |

`booking.manage` is a **new codename**, seeded alongside the existing
set and granted to Owner and Manager. Staff booking creates a financial
obligation for someone else; `booking.view` is not sufficient authority
for it.

### The manifest is an envelope, not a list

Following the precedent spec 10 set for `GET /trips/{id}/availability/`
— a bare array made two very different states indistinguishable — the
manifest says what kind of trip it is describing:

```jsonc
{
  "trip": {
    "id": "…", "route": "Ikeja → CMS", "trip_class": "premium",
    "service_date": "2026-09-01", "scheduled_departure_at": "…",
    "status": "in_progress",
    "booking_mode": "reservation", "fare_collection_mode": "prepaid",
    "vehicle": "LAG-221-XY", "driver": "A. Bello"
  },
  "kind": "prepaid",                 // "prepaid" | "pay_as_you_go"
  "totals": { "passengers": 39, "boarded": 31, "capacity": 44 },
  "results": [
    {
      "booking_reference": "…", "passenger_name": "Ada Obi",
      "seat_number": "12A",          // null for open seating
      "ticket_reference": "…", "ticket_status": "boarded",
      "booking_status": "paid",
      "fare": "1200.00", "currency": "NGN",
      "boarded_at": "…"              // null if not yet boarded
    }
  ]
}
```

**`kind: "pay_as_you_go"`** returns open and closed `FareJourney` rows
instead — there are no Bookings or Tickets on such a trip at all, and a
manifest that returned an empty list would be actively misleading to an
operator asking "who is on this bus". Each row carries the passenger,
board stop, alight stop (null while open), and fare (null while open).

`capacity` is `null` when no vehicle is assigned, and comes from the
Business capacity rather than a `Seat` count for open seating — the
same rule spec 16's occupancy metric follows.

### Paginated, and ordered

Standard `LimitOffsetPagination`. Ordered by seat number where seats
exist, otherwise by ticket issuance. Ordering is declared explicitly on
the query, not left to model `Meta` — `Seat.Meta.ordering` is
`-created_at`, which would scatter a group across the vehicle, exactly
as spec 10 found when allocating quick-book seats.

### `POST /bookings/staff/`

```jsonc
{
  "trip": "…", "passenger": "…",          // passenger UUID from the lookup
  "from_stop": "…", "to_stop": "…",
  "seats": [ … ],                          // or "passenger_count", per trip mode
  "pay_from_wallet": true                  // optional
}
```

Takes an `Idempotency-Key` like every other mutating booking endpoint.
Server-side it:

1. resolves the passenger through the tenant-scoped manager (a
   passenger of another Client simply is not found);
2. calls `create_booking(...)` unchanged;
3. if `pay_from_wallet`, calls the existing wallet payment service —
   which either succeeds, posting the ledger entry and marking the
   booking `paid`, or fails on insufficient funds;
4. writes an `AuditLog` entry naming the staff user who acted for the
   passenger.

A wallet failure leaves the booking `pending_payment` and returns the
booking plus an explicit `payment: { status: "failed", reason: … }`.
It does **not** roll the booking back — the seats are held, the
passenger can top up, and destroying a valid hold because payment came
up short would be worse than reporting it.

### `GET /passengers/lookup/`

`?email=` or `?phone=`, **exact match only**. Returns at most one
passenger: id, name, masked email/phone.

Deliberately not a search. A fuzzy passenger search over a Client's
whole user base, available to counter staff, is a data-protection
problem; exact-match lookup answers "is this person, who is standing
here and told me their email, already registered?" and nothing else.
Rate-limited, and every lookup is audited — an exact-match endpoint is
still an enumeration oracle if you let someone hammer it.

## Edge cases

| Case | Expected behaviour |
|---|---|
| Trip with no bookings | `results: []` with `totals.passengers: 0` — distinguishable from a PAYG trip by `kind` |
| Open-seating trip | Rows present, `seat_number: null` throughout |
| PAYG trip | `kind: "pay_as_you_go"`, journeys not bookings |
| Cancelled bookings | Excluded from `results` and `totals` by default; `?include_cancelled=true` includes them, flagged |
| `pending_payment` bookings | **Included**, with `booking_status` shown. An operator needs to know a held seat is unpaid; hiding it is how a seat gets sold twice in practice |
| Booking with several seats | One row per seat/ticket, not per booking — matches `Ticket` being one-per-`SeatReservation` |
| Trip with no vehicle | `capacity: null`, not `0` |
| Passenger lookup, no match | `404` with a neutral message; no distinction between "no such user" and "user of another Client" |
| Staff booking for a passenger of another Client | `404` from the lookup; never a cross-tenant booking |
| Staff booking on a sold-out trip | The existing `TripSoldOut` path, unchanged |
| Staff booking, `pay_from_wallet`, empty wallet | Booking held as `pending_payment`, payment reported failed, seats not released |
| Duplicate staff booking under one `Idempotency-Key` | Original returned; no second hold |
| Staff booking on a PAYG trip | `400` — a PAYG trip sells no bookings. The mirror of the "no tickets on a PAYG trip" rule spec 10 already enforces |

## Failure modes

- **PII exposure.** The manifest is the most passenger-identifying
  screen in the operator console. It is gated on `booking.view`, the
  passenger's contact details are **not** included (name and seat only
  — an operator matching a face to a seat needs no phone number), and
  access is audited. The lookup endpoint returns masked contact values.
- **Query cost.** A 400-seat open-seating manifest fanning out to
  bookings, reservations, tickets and users is an N+1 waiting to
  happen. It is built as an explicit `select_related`/`prefetch_related`
  set with an assertion on query count in the tests — **but** the
  `LedgerAccount` lesson from spec 5 applies to what may be joined:
  never join an RLS-protected table whose rows the caller may not see,
  because the join silently drops rows rather than erroring. Fares come
  from the `SeatReservation` snapshot, which the caller can see.
- **Two write paths to seats.** Avoided by construction: staff booking
  calls `create_booking`. Any future counter flow that "just needs a
  small variation" must extend that service rather than fork it — the
  open-seating capacity invariant has no database constraint behind it.
- **Acting on behalf without a trail.** Every staff booking writes an
  `AuditLog` naming both the acting staff user and the passenger. A
  dispute about a booking someone did not make is otherwise
  unanswerable.

## Test plan

### Backend

- Manifest envelope for each mode: reservation-with-seats,
  open-seating (null seats, Business capacity denominator), PAYG
  (journeys, `kind` correct), empty trip, trip with no vehicle.
- Cancelled excluded by default, included and flagged on request;
  `pending_payment` always included.
- Multi-seat booking produces one row per ticket.
- Ordering explicit and stable — asserted, given `Seat.Meta.ordering`
  would otherwise scatter rows.
- **Query-count assertion** on a large manifest, so an N+1 regression
  fails the suite rather than the production database.
- Staff booking: creates via `create_booking` (asserted by the same
  invariants that service's own tests cover — seats held, fare quoted,
  idempotency honoured); wallet settlement success and
  insufficient-funds paths; audit entry written; PAYG trip rejected;
  sold-out path unchanged.
- Passenger lookup: exact match only, masked fields, neutral `404` for
  both "absent" and "other Client".
- **Cross-client isolation** (mandatory set): another Client's trip
  manifest is a `404`; their passengers are unlookupable; a staff
  booking cannot name them.
- Permission gating, including that `booking.view` alone cannot reach
  `POST /bookings/staff/`, and that `booking.manage` is seeded and
  granted to Owner and Manager only.

### Frontend

`client-admin-app`: `trip-manifest` (reachable from both the trip list
action and trip detail; renders each `kind`; empty and no-vehicle
states distinct), and `counter-booking` (lookup → trip → seats or
passenger count → confirm, with the wallet option and its failure
state rendered inline as well as toasted).

Forms asserted on **rendered** validation output, per the standing rule.
The trip picker must not repeat `booking-list`'s recorded defect — a
`limit=100` fetch against ascending `Trip.Meta.ordering`, which offers a
busy Business its oldest hundred trips. This screen pages or filters by
date; it does not trust one bounded page.

### E2E

Per-project, `client-admin-app`: open a seeded trip's manifest and
assert a known passenger and seat; run a counter booking for the seeded
passenger and assert it appears on that manifest. Axe pass on both
screens.

## Migration impact

One data migration seeding the `booking.manage` codename and granting
it to the Owner and Manager presets. No schema change, nothing
destructive.

## Suggested implementation slicing

Two slices, stop for review between.

**Slice 1 — manifest.** Endpoint, all three `kind` branches, query-count
discipline, tests, and the `client-admin-app` screen. Self-contained and
immediately useful.

**Slice 2 — staff booking.** `booking.manage`, the lookup endpoint, the
staff booking endpoint with its wallet option, audit trail, and the
counter-booking screen.

---

## Implementation note (Slice 1 — manifest, done)

Built 2026-09-07. `GET /trips/{id}/manifest/`, a `manifest` CSV export,
and the `client-admin-app` screen that reads them. **1052/1052 backend
tests** (up from 1022) and **1470 frontend unit tests** (up from 1446).
Slice 2 — `booking.manage`, the passenger lookup and the counter-booking
flow — remains.

### Three places this spec was written against a data model that does not exist

Checked before planning rather than discovered during it:

1. **`Booking.reference` and `Ticket.reference` did not exist.** Both
   models are identified by UUID alone, and **no screen in any of the
   four apps showed an identifier for either**. The envelope in §"The
   manifest is an envelope" names both. So a passenger had nothing to
   quote on the phone and a manifest had nothing to print — which makes
   the spec's "Data model changes: **None**" wrong, not merely
   optimistic.
2. **There is no trip detail screen** to reach the manifest from. There
   is a row menu, a details *drawer*, and `/trips/:id/performance`.
3. **"CSV export via spec 16's export endpoint covers the operational
   need" is false for pay-as-you-go.** The `bookings` export filtered by
   trip does cover a prepaid departure. A PAYG trip has no `Booking`
   rows at all, so that export of one is a **blank file** — the worst
   possible answer to "print me the list of who is aboard".

### `Booking.reference`, added — and only on `Booking`

Same shape as `Incident.reference`: Crockford base32 (no I/L/O/U, so
nothing is ambiguous read aloud), unique per Business, drawn in the
service with a collision retry. Prefix `BKG-`.

**Not on `Ticket`.** A ticket's identity is its signed QR, which is what
a scanner reads; a second human reference for it would be a second thing
to get wrong.

Two migrations, not one: `0008` adds the column, `0009` backfills every
existing row and *then* adds the unique constraint. One migration doing
both fails on the second booking in any Business, because every existing
row holds `""`. The backfill needs
`set_rls_session_vars(None, is_platform_staff=True)` and `all_objects` —
the two details `identity/0021` documents, and `all_objects`
additionally because a soft-deleted booking still occupies
`(business, reference)` in the index. Verified live: **584 rows
backfilled, zero duplicate pairs.**

The retry helper's nested `transaction.atomic()` is load-bearing
**twice** here, where `apps/incidents` needed it once. Besides the
poisoned-transaction problem, `create_booking` runs it inside its own
`atomic()` whose `except IntegrityError` exists to reconcile an
idempotency-key race — without the savepoint a reference collision would
escape into that handler and be reported as a duplicate submission,
which it is not.

### `kind` branches the query, not just the label

Following `GET /trips/{id}/availability/`'s precedent: a bare array made
two very different states indistinguishable. Prepaid reads `Ticket` →
`Booking`/`SeatReservation`/`User`; pay-as-you-go reads
`tapngo.FareJourney`. Verified live on both: a prepaid trip returned 7
rows with 6 boarded, a PAYG trip returned 8 journeys.

`totals.capacity` reuses `apps.analytics.services.seats_sold_and_total`,
promoted from `_seats_sold_and_total` the way spec 17 promoted
`_as_utc_range`. It already owns the open-seating-vs-`Seat`-count branch
and the "no vehicle means unknowable, not zero" rule; a second copy
would have drifted. Verified live: `capacity: null` on a vehicle-less
trip.

Ordering is declared on the query. `Ticket.Meta` and `Seat.Meta` are
both `-created_at`, which scatters a group around the vehicle.

### A test caught the `Decimal` trap in this endpoint's own wire format

The manifest builds plain dicts, and CLAUDE.md records that **a
plain-dict endpoint does not coerce `Decimal`** — it renders a float
while `schema.ts` says string. That is exactly what happened, and the
manifest's own test failed on `Decimal('300.00') == '300.00'` before any
consumer saw it. The rows now go through
`ManifestPrepaidRowSerializer`/`ManifestJourneyRowSerializer`, so the
wire format and the generated types come from one declaration.

The envelope's `results` is a **union**, not a `DictField`.
`ListField(child=DictField())` generated `{[key: string]: unknown}[]`,
handing the frontend an untyped bag and defeating the point of a
generated client. A `PolymorphicProxySerializer` makes it
`ManifestRow = ManifestPrepaidRow | ManifestJourneyRow`, discriminated
by `kind`. `ManifestKindEnum` is in `ENUM_NAME_OVERRIDES` so the
generated type is not a hash of its own choice set.

### The manifest is a row link, not an action-menu item

The trip list's `ui-action-menu` is wrapped in
`*appHasPermission="'scheduling.manage'"` **in its entirety**. An item
inside it would have been invisible to every `booking.view`-only Staff
user — which is the whole audience for a list read at the bus door, and
exactly the defect spec 17 slice 2 caught with `GET /staff/`. It
follows `trip-performance`'s precedent instead: a row link behind its
own codename. Asserted in the e2e.

### The export resource, and a filename that names its trip

Adding it meant giving `AnalyticsFilters` a `trip`, and giving
`ExportSpec` a **`required_filters`**. That second one is deliberate
design rather than a check inside the row builder: the export tests are
registry-driven with no allowlist, so a resource that simply refused
would have had to be *excluded* from them — silently losing its
coverage. Declared, the tests read what a resource needs and supply it,
and the next such resource is handled for free.

A manifest export is named `integra-manifest-<service date>-<short
id>.csv`. Downloading five departures and getting five files called
`integra-manifest-all.csv` is the filename failing at its only job.

### The responsive guard could not reach the one table that needed it

`ui-table`'s docstring points at `e2e/responsive-tables.ts` as the thing
that measures columns at real widths. The manifest was not in it — and
could not be, because that harness takes fixed URLs while a manifest
needs a Trip id, of a trip that actually carries passengers. So the
screen with the most columns in the app was the one the guard could not
see.

It now accepts a **resolver function** for a path, and `trip-manifest`
is in the list. Adding it immediately found two overflows: six columns
came to 690px inside a 654px wrapper at 768 (Fare moved to the third
tier), and 3px at 390 from `whitespace-nowrap` holding "Open seating" on
one line. The second was invisible in the screenshots.

### Two pre-existing e2e failures, diagnosed rather than absorbed

Neither is caused by this slice; one was fixed because it blocked
verification, one was not.

**Fixed: `customer-app/booking.spec.ts` picked an unbookable
departure.** The earliest trip on the fixture route each day is a
Celery-generated one from the seeded Schedule, and nothing ever assigns
it a vehicle — so it is `not_configured`, has no seats, and opens a
picker reading "Not open for booking yet". It is only *in* the results
during the morning window before it departs, which is why this passed
every afternoon for months and failed at 07:20. The helper now walks to
the first departure that actually has a seat map. Fixing it also
surfaced the recorded non-retrying trap: `locator.isVisible()` answers
"no" in the instant before the picker loads, so every candidate looked
unbookable until the check became `expect(...).toBeVisible()`.

**Not fixed: `super-admin-app`'s KYC and KYB queue specs.** Both review
fixtures read `approved` in the dev database — consumed by an earlier
run in the same session, and `seed_e2e_users` is idempotent by natural
key so it does not reset them. The documented single-use-per-seed
limitation, confirmed by querying both tables rather than assumed.

### Verified

- 1052/1052 backend (`--create-db`), ruff and mypy over 316 files,
  `spectacular --validate` 0 errors, no OpenAPI drift either way.
- 1470 frontend unit tests, 9 lint targets, 4 builds.
- Playwright: client-admin **118** (was 113), customer 23, validator 12.
- Two visual iterations, axe clean at 390/768/1200, written up in
  `docs/ui-review/18-manifest/iteration-1.md`.
- Live: both `kind`s, `capacity: null` with no vehicle, the backfilled
  references, the 400 for an export with no trip, and a CSV whose
  filename names its trip.

### Not done, deliberately

- **Slice 2** — `booking.manage`, `GET /passengers/lookup/`,
  `POST /bookings/staff/`, the counter-booking screen.
- **`Ticket.reference`.** The QR is the ticket's identity.
- **Passenger contact details**, per this spec's own PII rule. Noted in
  passing: the existing `bookings` CSV export *does* carry
  `passenger_email`. That inconsistency predates this slice and is left
  flagged rather than changed.

---

## Implementation note — slice 2 (2026-09-07)

`booking.manage`, `GET /passengers/lookup/`, `POST /bookings/staff/` and
the counter-booking screen. Shipped as specified, with three departures
from the spec's text, each recorded below.

### The spec named a field that does not exist — again

`GET /passengers/lookup/` was specified as `?email=` **or** `?phone=`.
**`identity.User` has no phone number.** It carries email, first and
last name and nothing else; `phone` exists on `Client`, `Driver` and
`Incident`, but no passenger has one anywhere in the schema and no
registration path collects one.

Adding the column would have shipped a lookup field that is empty for
every account that exists and filled by nothing — and it would fail as
*"not found"* rather than as *"not supported"*, which is worse than not
offering it. **Email only**, and the gap is written into
`PassengerLookupQuerySerializer`'s own docstring rather than left for
the next reader to rediscover. This is the second time this spec has
named a field the model does not have (slice 1: `Booking.reference`,
`Ticket.reference`); checking before planning caught both.

### The lookup takes either codename, and that was a deliberate widening

The spec gates it on `booking.manage` alone. It ships accepting
**`booking.manage` or `wallet.view`** (`HasAnyPermission`, new in
`apps.core.permissions`), because the endpoint has a second consumer
that has been waiting for it since spec 5.

`client-admin-app`'s wallet-lookup screen shipped with its own
limitation written into its docstring: `GET /wallet/?business=&passenger=`
takes a passenger **UUID**, there was no way to obtain one, and so the
screen only worked if a support ticket happened to quote it. That is
precisely the capability this endpoint is. Gating it on `booking.manage`
alone would have left the screen broken for every **Staff** user, who
hold `wallet.view` and deliberately not `booking.manage` — the recorded
rule about checking a gating codename is reachable before building a
control that needs it.

The cost is real and was taken knowingly: more people can now confirm
that an address is registered. The alternative was a second endpoint
doing the same lookup under another name, which is the same disclosure
with more code. `wallet-lookup` now asks for an email and resolves the
id behind the form.

### The manifest could not show an unpaid booking — slice 1's defect, exposed by slice 2

The one substantive correction. Slice 1 built the prepaid manifest over
`Ticket`, and **a ticket is issued at payment**, so a booking that was
never paid for had no row. The module's own constant said the opposite:

> `pending_payment` is **not** among them, deliberately: an operator
> needs to know a held seat is unpaid, and hiding it is how a seat gets
> sold twice in practice.

True of the filter, false of the result. Slice 1's test did not catch it
because it *manufactured a ticket first* (`mark_booking_paid`) and then
forced the booking back to `pending_payment` — so it only ever proved
that a **ticketed** row is not filtered out by status. Assert the
invariant, not the example.

Slice 2 is what made it urgent rather than theoretical: with **no cash
account in the ledger** (ADR-0006), a counter booking the passenger has
not yet paid for is the *ordinary* outcome of selling at a desk. An
agent who sold a seat and then could not see it on the manifest is
exactly the failure that rule exists to prevent — and the e2e spec found
it by walking the real flow, not by reasoning about it.

`apps.booking.manifest.prepaid_rows` now merges issued tickets with
held-but-unticketed bookings: one row per `SeatReservation`, or per
place on an open-seating booking. `ticket_id`/`ticket_status` are
**null** on those rows rather than carrying an invented `not_issued`
member no `Ticket` could ever hold; the screen renders "Not issued" in a
warning tone. `totals` counts the merged rows, so the header cannot
disagree with the list beneath it. The export follows the same builder.

### Everything else, as specified

- **`create_booking` unchanged.** `apps.booking.staff` composes it
  rather than forking it — the whole point, since the open-seating
  capacity lock is application-code-only with no database constraint
  behind it (ADR-0008). Every refusal a passenger meets (fare not
  configured, seat taken, sold out, PAYG trip, idempotency conflict) is
  met identically at the counter, because the body is validated by a
  subclass of the passenger's own serializer.
- **A wallet shortfall never rolls the booking back.** It returns
  `payment: {status, reason, payment_intent}` beside the booking. Three
  states, not two: "failed" and "never attempted" are different facts,
  and an agent who left the box unticked must not read a failure notice.
- **A replay that finds the booking already paid reports success**,
  rather than calling the wallet service again and reporting
  `BookingNotPayable` for a booking that is in fact settled.
- **`_booking_request_hash` already covered the passenger**, so a replay
  under one key naming a different passenger is a 409 with no new code.
  Asserted anyway — it is the failure that would matter most.
- **Audited on every call**, naming the acting staff user, the
  passenger, the trip and the payment outcome, with the idempotency key
  in the metadata so a retry's duplicate row is identifiable as one.
  (`pay_booking_from_wallet` records its own event with
  `actor=passenger`, which is right for the passenger-initiated path and
  would be misleading as the only record of this one.)
- **A successful lookup is audited; a miss is not.** Logging every
  failed address would build the list of tried addresses this endpoint
  exists to avoid producing. Throttled at `60/hour` per agent.

### Frontend

`counter-booking` is a four-step form in the order the conversation
happens: who → which trip → which places → who pays. Nothing after the
lookup renders until a passenger is resolved.

- **Seats are a list of free seat numbers, not a seat map.** Naturally
  sorted (`numeric: true`, or 10A sorts before 2A). Extracting
  `customer-app`'s graphical picker into `@shared-ui` was the
  alternative and was rejected for this slice: it is tied to
  booking-draft, session storage and that app's routing, so lifting it
  is a refactor with regression risk to a shipped passenger flow.
- **The trip picker filters by service date**, and does not repeat
  `booking-list`'s recorded defect (a `limit=100` fetch against
  ascending `Trip.Meta.ordering`, which cannot reach today's trips).
- **Places are a bounded select**, capped by `capacity_remaining` where
  known and at 10 where it is not — the same cap and reasoning as
  `customer-app`'s picker: an unbounded number field is an invitation to
  a typo that books forty seats.
- **One `Idempotency-Key` per assembled booking**, reused across
  retries and replaced only after one succeeds. Regenerating it per
  submit is how a timeout that reached the server becomes two held
  seats.

### Three defects the build found, none of them theoretical

1. **An infinite loop that froze the browser.** The screen's `effect`s
   called store methods without `untracked`, so each store write
   re-invalidated the effect that caused it. Not an error — a blocked
   main thread, which surfaced as Playwright timing out on
   `page.evaluate` while `page.url()` answered fine. `trip-list` already
   wraps these calls for exactly this reason.
2. **A bounded page plus `.find()`, again.** The stop pickers read the
   route out of `RouteStore.items()`, so a Business with more than one
   page of routes would show empty stop lists with nothing on screen
   saying why. Now `RouteStore.findById` — the recorded rule, which this
   repo has now been bitten by three times.
3. **`ui-form-section` announcing a control's own label.** Sections
   named "Passenger" and "Departure" wrapped "Passenger email" and
   "Departure"; the e2e run failed as a strict-mode violation, which is
   what an a11y defect of this shape looks like from a test. Renamed to
   "Who is travelling" and "Trip and stops".

### Verified

- 1081/1081 backend (`--create-db`), ruff and mypy over 318 files,
  `spectacular --validate` 0 errors, no OpenAPI drift either way.
- 1506 frontend unit tests, 9 lint targets clean, 4 builds with 0 errors.
- Playwright, every project with `--project=`: client-admin **121**
  (was 118), customer 23, super-admin **19**, validator 12.
- Two visual iterations at 390/768/1200, axe clean, written up in
  `docs/ui-review/18-staff-booking/iteration-1.md`.
- Live: the grant migration reached **758/758** existing Owner and
  Manager roles and **0** Staff roles; a real counter booking appears on
  its trip's manifest as "Not issued".

### Not done, deliberately

- **No cash tender.** The spec's own largest limitation, unchanged:
  ADR-0006's chart of accounts has no cash account, and inventing one
  needs an ADR amendment, a float model and a cash-drawer story. The
  screen states it rather than hiding it.
- **No account creation on a passenger's behalf.** Consent, credential
  delivery and a claim flow are its own spec.
- **No `?phone=` lookup.** There is no phone number on a passenger to
  match — see above.
- **No refunds.** There is still no refund service anywhere in this
  system; a staff booking settled from a wallet cannot be reversed
  in-app.
