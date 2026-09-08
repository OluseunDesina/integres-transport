# 15-Trip-Classes: Service classes across fleet, scheduling and fares

Third spec of the Transit OS adoption arc. Landed before operational
analytics (spec 16 breaks revenue down by class) and before the trip
manifest (spec 18 shows a ticket's class), because both read a field
that does not exist yet.

## Scope and non-goals

`transit-admin-app-prompt.md` requires trip classes — **Premium,
Exclusive, Standard, Mini** — at minimum, selectable when creating a
route, listed in route configuration, shown on the manifest, and
available as a revenue breakdown dimension. Nothing in this codebase
models a service class today.

This is a cross-cutting data-model change touching `fleet`,
`scheduling`, `network`, `fares`, and both operator- and
passenger-facing frontends. It is spec'd on its own for that reason.

### The decision it must respect

The fares ruling for this arc stands: **no route-level base fare, and
no class multipliers.** Fares stay the versioned
`FareRule`/`FareSegmentRule` timeline with its price snapshot on
`SeatReservation`. Class pricing therefore arrives as a **new dimension
on the existing rules**, not as a second pricing system layered over
them. That constraint drives most of the design below.

### In scope

- A `TripClass` enumeration, and a class on `VehicleType` (what a
  vehicle *is*), on `Schedule` and `Trip` (what a service is *sold as*),
  and an allow-list on `Route` (what a route *may* offer).
- `trip_class` as a dimension on both fare rule models, with wildcard
  support and deterministic precedence.
- Operator UI for all of the above; passenger-facing class display and
  filtering.

### Non-goals

- **Mixed-class vehicles.** A per-`Seat` class — business at the front,
  economy behind — is explicitly out. A `VehicleType` has exactly one
  class. This is the single largest simplification in the spec and it
  is deliberate: per-seat class would reopen the ADR-0004 seat-segment
  exclusion constraint and the whole availability envelope from spec 10.
- **Class-based fare multipliers.** Per the ruling. A Premium fare is
  an explicitly-entered amount, like every other fare in this system.
- **Class-based seat allocation or upgrades.** No "upgrade to Premium"
  flow, no cross-class rebooking.
- **Class on tap-and-go / pay-as-you-go journeys.** `FareJourney`
  pricing already resolves through `get_fare()` and so picks up the
  trip's class for free; no separate PAYG class concept is added.
- No change to `Business.fare_pricing_mode` (flat vs per-segment stays
  per-Business).

## Data model changes

### The enumeration

Declared once, on `Business`, alongside the existing `BookingMode` /
`FareCollectionMode` / `FarePricingMode` enums it sits with
conceptually — every other app already imports `Business` for those, so
this adds no new import edge:

```python
class TripClass(models.TextChoices):
    PREMIUM = "premium", "Premium"
    EXCLUSIVE = "exclusive", "Exclusive"
    STANDARD = "standard", "Standard"
    MINI = "mini", "Mini"
```

`STANDARD` is the default everywhere. It is the class every existing
row backfills to, so the migration is behaviour-preserving.

### `fleet.VehicleType.trip_class`

`CharField(choices=TripClass.choices, default=STANDARD)`, NOT NULL.
What class of service this vehicle can run.

### `network.Route.available_trip_classes`

`JSONField(default=list)` — the classes this route may offer, mirroring
`Schedule.days_of_week`'s existing JSONField precedent. Empty list
means "no restriction". Validated in the serializer against
`TripClass.values`; enforced when a `Schedule` or `Trip` is created on
the route.

This is the brief's "available trip classes" in route configuration.

### `scheduling.Schedule.trip_class` and `scheduling.Trip.trip_class`

Both `CharField(choices=TripClass.choices, default=STANDARD)`, NOT NULL.

`Trip.trip_class` is **snapshotted from the Schedule** at generation
time, exactly as `booking_mode` and `fare_collection_mode` already are
(`apps/scheduling/models.py:55-65` and its comment). A manually-created
Trip takes it from the request, defaulting to `STANDARD`.

The snapshot direction matters and is the opposite of the naive
reading. Class is **not** derived from the assigned vehicle, because
`Trip.vehicle` is nullable and a Trip is generated — and can be booked
— long before a vehicle is assigned. A passenger buys a class; the
operator then has to find a vehicle that honours it. Deriving class
from the vehicle would mean a departure had no class until the morning
it ran.

### `fares.FareRule.trip_class` / `fares.FareSegmentRule.trip_class`

`CharField(max_length=20, blank=True, default="")`, NOT NULL, where the
empty string is a **wildcard meaning "any class"**.

A nullable column was considered and rejected. Postgres `=` does not
match NULL against NULL, so a GiST exclusion constraint containing
`trip_class WITH =` would silently permit two overlapping NULL-class
rules for the same route — the exact duplicate the constraint exists to
prevent. An empty-string sentinel keeps the constraint honest.

The exclusion constraints gain the column:

```sql
ALTER TABLE fares_farerule
  ADD CONSTRAINT no_overlapping_fare_rule_per_route
  EXCLUDE USING gist (
    route_id WITH =,
    trip_class WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
  WHERE (deleted_at IS NULL);
```

and correspondingly for `fares_faresegmentrule`, which keeps its
`from_stop_id` / `to_stop_id` terms.

### Fare resolution precedence

The constraint now guarantees at most one rule per
`(route, trip_class, instant)` — but a Premium trip can legitimately
match **two** rules: an explicit `premium` one and a `""` wildcard.
`apps.fares.services.get_fare()` currently uses `.get()`, which would
raise `MultipleObjectsReturned` on exactly that.

Resolution becomes explicit and ordered: **the exact class match wins;
the wildcard is the fallback; neither found is `FareNotConfigured` as
today.**

```python
rule = (
    FareRule.objects.filter(_effective_at_filter(as_of=moment), route=trip.route)
    .filter(trip_class__in=[trip.trip_class, ""])
    .order_by("-trip_class")     # exact class sorts before "" — see below
    .first()
)
```

`ORDER BY trip_class DESC` puts any non-empty value before the empty
string, so it expresses "specific beats wildcard" without a `CASE`.
That is a subtle thing to depend on, so it is asserted directly by a
test rather than left to the reader.

`get_fare()`'s signature is unchanged — it already takes `trip`, so it
reads `trip.trip_class` itself. Every caller
(`booking`, `tapngo`, `ticketing`, the fare-matrix module) is
untouched.

### Immutability once sold

`Trip.trip_class` **cannot be changed once any non-cancelled `Booking`
exists** for that Trip. Changing it would silently change what a
passenger paid for, and the price they were charged is already
snapshotted against a rule for the old class. Enforced in
`apps.scheduling.services`, not just the serializer, and raised as a
typed exception mapped to `409`.

### Vehicle assignment must honour the class

Assigning a `Vehicle` whose `vehicle_type.trip_class` differs from
`trip.trip_class` is rejected (`400`). Selling Premium and running a
Mini is a refund event, and this system has no refund service
(`docs/specs/10-booking-modes.md`'s own note — the remedy has no code
path). Better to block it at assignment.

`ASSUMPTION:` a hard rejection, not a warning. The alternative — record
it as a `trip.class_mismatch` audit event the way spec 10 records
`trip.oversold` — was considered, and rejected precisely because
`trip.oversold` has already demonstrated that an audit record nobody can
act on is not a control.

## API surface

No new endpoints. `trip_class` is added to existing payloads:

| Endpoint | Change |
|---|---|
| `GET`/`POST` `/vehicle-types/`, `PATCH /vehicle-types/{id}/` | `trip_class` readable and writable |
| `GET`/`POST` `/routes/`, `PATCH /routes/{id}/` | `available_trip_classes` readable and writable |
| `GET`/`POST` `/schedules/`, `PATCH /schedules/{id}/` | `trip_class` readable and writable |
| `GET`/`POST` `/trips/`, `PATCH /trips/{id}/` | `trip_class` readable; writable only while unsold |
| `GET /trips/search/`, `GET /routes/browse/` | `trip_class` in the response; optional `?trip_class=` filter |
| `GET /trips/{id}/availability/` | `trip_class` added to the envelope |
| `GET`/`POST` `/fare-rules/`, `/fare-segment-rules/` | `trip_class` readable and writable, `""` for any class |
| `GET`/`PUT` `/routes/{id}/fare-matrix/` | **`?trip_class=` becomes a required query parameter** — see below |

### The fare matrix becomes class-scoped

`GET /routes/{id}/fare-matrix/` returns one amount per stop pair. With
a class dimension there is one grid *per class*, so the endpoint takes
`?trip_class=` (empty string for the wildcard grid) and the `PUT`
writes into that class's rules only.

This is the one place the change is not purely additive to a caller: a
request without the parameter is a `400` rather than silently editing
the wildcard grid. Spec 12's own hard-won rule applies — the grid
submits only edited cells, because a stale `null` for an untouched cell
would *close* a rule another operator created. Widening that blast
radius to "the wrong class's grid entirely" is not acceptable, so the
parameter is explicit and required.

## Edge cases

| Case | Expected behaviour |
|---|---|
| Route with `available_trip_classes = []` | No restriction; any class may be scheduled |
| Schedule's class not in the route's allow-list | `400` at create/update |
| Route's allow-list narrowed after Schedules exist outside it | Allowed, and existing Schedules are left alone — narrowing must not silently invalidate live services. Surfaced as a warning in the UI, not an error |
| Trip generated from a Schedule whose class was since changed | The Trip keeps the class it was generated with. Snapshot semantics, same as `booking_mode` |
| Changing `Trip.trip_class` with only cancelled Bookings | Allowed — nothing sold survives |
| Changing `Trip.trip_class` with a `pending_payment` Booking | Rejected. A held seat is a live offer at a quoted price |
| Assigning a vehicle of the wrong class | `400`, message naming both classes |
| Unassigning a vehicle | Always allowed; class is the Trip's, not the vehicle's |
| Both a `premium` and a `""` fare rule cover the instant | Exact match wins; asserted by test |
| Only a `""` rule exists | Every class prices from it — this is exactly the pre-migration behaviour, preserved |
| No rule for the class and no wildcard | `FareNotConfigured` → `404`, unchanged |
| Two `""` rules overlapping in time | Rejected by the exclusion constraint, as before |
| A `premium` and a `standard` rule overlapping in time | **Allowed** — different classes, different prices, that is the point |
| PAYG journey on a classed trip | Prices through `get_fare()` and picks up the class automatically; no `FareJourney` change |

## Failure modes

- **Migration on a live database.** Dropping and re-adding an exclusion
  constraint takes an `ACCESS EXCLUSIVE` lock on the table and rebuilds
  the GiST index. On the fares tables this is small today, but the step
  is called out in Migration impact rather than discovered in
  production.
- **A wildcard rule masking a missing class rule.** An operator who
  configures Premium but forgets to price it gets the wildcard price
  silently rather than an error. This is intentional (it is what makes
  the migration behaviour-preserving) but it is a real foot-gun, so the
  fare-matrix UI shows explicitly when a cell is inherited from the
  wildcard grid rather than set for this class.
- **Class changed on a Schedule mid-generation.** The daily generator
  reads the Schedule at run time; a class edited between two runs
  produces Trips of different classes on different days. Correct, and
  matches how `days_of_week` edits already behave.
- **RLS.** Every touched model is already a `BaseModel` with RLS
  enabled. No new model is introduced, so no new
  `EnableRowLevelSecurity` operation is needed — but the
  registry-driven test in `apps/core/tests/test_row_level_security.py`
  still runs and still must pass.

## Test plan

### Backend

- Enumeration and defaults: every touched model defaults to `standard`.
- `Trip` snapshots class from its `Schedule` at generation; a later
  Schedule edit does not retro-change generated Trips.
- Route allow-list: in-list passes, out-of-list `400`s, empty list
  permits anything; narrowing does not invalidate existing Schedules.
- Immutability: class change rejected with a live Booking (`409`),
  permitted with only cancelled ones.
- Vehicle assignment: matching class passes, mismatched `400`s,
  unassignment always allowed.
- **Fare precedence** (the load-bearing group):
  - exact class beats wildcard;
  - wildcard alone prices every class;
  - neither → `FareNotConfigured`;
  - the `order_by("-trip_class")` ordering is asserted directly, so a
    later "tidy-up" of that clause fails loudly;
  - `get_fare()` never raises `MultipleObjectsReturned` when both
    exist — a regression test for the exact bug this design avoids.
- **Constraint tests** (against the real database, not mocked):
  - two overlapping same-class rules rejected;
  - two overlapping different-class rules accepted;
  - two overlapping wildcard rules rejected (the case a nullable column
    would have let through — this is why the sentinel exists).
- Fare matrix: `?trip_class=` required; a `PUT` writes only that class's
  rules and leaves other classes' grids untouched.
- **Cross-client isolation**, per the standing mandatory set: another
  Client's Premium fare rule is invisible to this Client's lookup.
- Migration test: existing rules backfilled to `""` produce byte-identical
  fare quotes before and after.

### Frontend

- `vehicle-type-form`, `schedule-form`, `trip-form`, `route-form`,
  `fare-form`: the new control renders, validates, and submits.
  Per `docs/self-check-2026-08-26-spec11.md`, each is asserted on
  **rendered** validation output — `ui-select` shows an error only when
  the parent binds both `[invalid]` and `[errorMessage]`, and a form
  that binds neither silently does nothing on invalid submit.
- `trip-list`: class column renders as a `ui-status-pill`; colour is
  not the only differentiator (the label is present), per the a11y bar.
- `fare-matrix`: the class selector reloads the grid; switching class
  with unsaved edits warns rather than discarding silently; inherited
  wildcard cells are visually distinct **and** labelled.
- `trip-search` (customer): class shown per result, `?trip_class=`
  filter round-trips.

### E2E

Per-project. `client-admin-app`: create a Premium vehicle type, a
Premium schedule on a route allowing Premium, price the Premium fare
matrix, confirm a generated Trip carries the class and that assigning a
Standard vehicle is refused. `customer-app`: filter trip search by
class and confirm the quoted fare matches the Premium grid, not the
wildcard.

## Migration impact

Additive, backfilled, then constrained — the same sequence
`fares/migrations/0002_version_fare_rules.py` already uses.

1. **Additive**: add every column nullable / defaulted. No lock of
   consequence.
2. **Backfill**: all existing `VehicleType`, `Schedule`, `Trip` rows →
   `standard`; all existing `FareRule` / `FareSegmentRule` rows → `""`
   (wildcard). `Route.available_trip_classes` → `[]`.
   Backfill runs under the RLS-bypass `set_config` pattern the fares
   migration already establishes.
3. **Enforce** `NOT NULL`.
4. **Drop and re-add** both GiST exclusion constraints with
   `trip_class` in the key. **This step takes an `ACCESS EXCLUSIVE`
   lock** on `fares_farerule` and `fares_faresegmentrule` and rebuilds
   their GiST indexes. Brief at current data volumes; stated here so it
   is planned, not discovered.

**Nothing is destructive.** No column is dropped, no row is deleted, no
existing behaviour changes: every pre-existing fare rule becomes a
wildcard rule and prices exactly as it did before. This spec needs no
destructive-migration approval.

### Does this need an ADR?

Judged: **no.** The wildcard-sentinel-plus-precedence decision is a
schema detail within the pattern ADR-0004 already established
(range-overlap exclusion constraints as the enforcement layer), not a
new architectural direction. It is recorded here, in the model
docstring, and in the migration. If a later phase adds per-seat class —
which *would* reopen ADR-0004's constraint shape — that one needs an
ADR first.

## Suggested implementation slicing

Three slices, stop for review between.

**Slice 1 — model and fares.** Enumeration, all five columns, the
migration, `get_fare()` precedence, the constraint rebuild, and the
service-layer rules (immutability, vehicle match, route allow-list).
Backend tests including the constraint and precedence groups. No UI —
every existing screen keeps working on `standard` defaults.

**Slice 2 — operator UI.** `client-admin-app`: vehicle-type, route,
schedule, trip and fare forms; the trip-list column; the class-scoped
fare matrix.

**Slice 3 — passenger UI.** `customer-app`: class on trip search
results and the class filter, class shown through seat-picker and
booking-confirm into the ticket view.

---

## Implementation note (Slice 1, done)

Built 2026-09-02. **797/797 backend tests pass**, up from 745 — 52 new.
1188 frontend unit tests unchanged, four clean builds, lint clean on all
nine projects, and all four e2e projects green. Migration applied to the
real dev database and both rebuilt constraints inspected in `psql`.

### Two decisions taken before building, both departures from this spec

**`POST /trips/{id}/class/`, not `PATCH /trips/{id}/`.** §"API surface"
put `trip_class` in the assignment PATCH. That body is
`TripAssignmentSerializer`, whose `vehicle` and `driver` both
`default=None` and therefore **clear on omission** — a documented,
deliberate behaviour ("a null clears the current assignment"). Putting a
guarded field in a body with two clear-on-omit fields means a class edit
that forgets to resend the vehicle silently unassigns it. The class now
has its own endpoint and its own serializer, modelled on
`/trips/{id}/status/` — the other guarded single-field Trip mutation.

**No separate backfill or NOT-NULL migration step.** §"Migration impact"
prescribes add-nullable → backfill → enforce. On Postgres 16
`ADD COLUMN ... DEFAULT <constant>` is catalog-only and presents the
default for every existing row without a rewrite, so the three steps
collapse into one with the same lock profile and the same result. What
was **not** dropped is the step that actually takes a lock: `fares/0004`
drops and re-adds both GiST exclusion constraints with `trip_class` in
the key.

Measured on the dev database after migrating: 13 `FareRule` and 139
`FareSegmentRule` rows all `''`; 897 Trips, 127 Schedules and 537
VehicleTypes all `standard`; 0 Routes restricting classes. Every
existing price and every existing service unchanged, which is what
"behaviour-preserving" had to mean.

### Two real bugs found only by regenerating the frontend types

**1. A serializer `default=` makes drf-spectacular emit the field as
*required*.** `trip_class` was first written as
`ChoiceField(required=False, default=STANDARD)` on the vehicle-type,
schedule, trip and both fare-rule create serializers. DRF treats that as
optional; the generated `schema.ts` did not, and four existing
`client-admin-app` call sites stopped compiling — a slice spec'd as "no
UI" would have forced UI changes into it. The same quirk is already
visible on `RouteCreate.code`, which has carried it since Phase 3
unnoticed.

Fixed by dropping the serializer default entirely: `required=False` with
no `default=` means the key is absent from `validated_data` and the
service function's own default applies. **One default, in one place** —
which is better than what the spec described regardless of the schema.

**2. The generated read type was wrong about every fare rule in the
database.** `FareRule.trip_class` inferred from the model produced
`TripClassEnum` — the four classes, no blank. But the model field is
`blank=True` and **every** rule that predates this slice returns `''`,
so the type claimed a value could not occur that in fact occurs on 100%
of rows. A consumer switching on it would have had no case that matched.
Fixed by declaring the field explicitly with `allow_blank=True` on both
read serializers, which emits `TripClassEnum | BlankEnum`.

Worth generalising: **a `blank=True` model field with `choices` loses
the blank when a ModelSerializer infers it**, and the loss is invisible
until something consumes the schema.

### The frontend touch

Two lines, as planned. `fare-matrix.ts` sends `trip_class: ''` — the
wildcard grid, byte-for-byte what it edited before — on both its `GET`
and its `PUT`, and its spec asserts that rather than loosening the
assertion to ignore it. Six response fixtures across `client-admin-app`
and `validator-app` gained the new read-only field.

### Verified live, over real HTTP

Because none of it can be proven from pytest alone, against the real dev
stack: the matrix 400s with no `?trip_class=`, 200s for `''` and for
`premium`, and 400s for a bogus class; a Premium rule at 2500 and the
existing 900 wildcard coexist on one route and one instant (the
constraint permitting different classes to overlap, which is the point);
a Premium trip quotes 2500 while a Standard trip on the same route
quotes 900; assigning a Mini vehicle to a Premium trip is refused with
*"This is a premium service and LIVE-CLS-1 is a mini vehicle."*;
changing an unsold trip's class moves its quote from 900 to 2500;
and once a paid Booking exists the same call is a 409, while re-sending
the class the trip already has stays a 200. All created rows removed
afterwards.

### One thing worth knowing for slice 2

`get_fare()` falls back to the wildcard; **the matrix deliberately does
not**. `_current_rules` filters `trip_class` exactly, so a class's grid
shows `null` where it inherits a wildcard price rather than showing the
inherited amount. Displaying the inherited value would make a save
supersede a rule the operator never looked at. §"Failure modes" already
asks the UI to mark inherited cells as inherited — that is a slice 2
job, and it needs a second read of the wildcard grid to do it, not a
change to this filter.

### Not done, deliberately

No UI beyond those two lines. `Route.available_trip_classes` is
writable through the API but has no form control yet; `Schedule`,
`Trip` and `VehicleType` likewise. That is slice 2.

---

## Implementation note (Slice 2, done)

Built 2026-09-03. **496 `client-admin-app` unit tests** (up from 461),
1223 across the workspace, four clean builds, lint clean on nine
projects, **all four e2e projects green** (`client-admin-app` 86/86,
including a new `trip-classes.spec.ts`). Backend unchanged at 797.
Visual pass: `docs/ui-review/15-trip-classes/iteration-1.md`.

Everything slice 1 built is now reachable. Before this, all five
columns were writable through the API and had no control anywhere, and
the fare matrix could only ever edit the wildcard grid.

### One backend edit, and why it is not a scope breach

`RouteSerializer.available_trip_classes` is now declared explicitly as a
`ListField(child=CharField())`. Inferred from the model it is a
`JSONField` with no item type, so drf-spectacular emitted `unknown` and
three frontend call sites would each have had to cast it back to a list
of strings — while `RouteCreateSerializer` already declared its own, so
the read and write shapes of one field disagreed in the generated types.
No behaviour, no migration; the same class of fix as slice 1's
`allow_blank` one, and recorded here for the same reason.

### Decisions taken with the user

- **The class renders as a neutral `ui-status-pill`, label only.** That
  component's four tones are semantic — a Mini is not negative and a
  Premium is not a warning — so colour carries nothing here and cannot
  mislead. It also makes the "colour is never the only signal" bar
  trivially true.
- **The grid shows inherited amounts, dimmed and labelled.**
- **`fare-list`, `vehicle-type-list` and `schedule-list` gained a class
  column too**, beyond this spec's `trip-list`. `fare-list` is close to
  a correctness fix: two rules for one route differ *only* by class, so
  without it a Premium fare and an Any-class fare render as the same
  route at two prices with nothing explaining why.

### The inherited-cell mechanism, in one sentence

**A placeholder, not a value.** That single choice gives all three
required behaviours at once — the browser draws it dim, typing replaces
it, and leaving it alone keeps the input empty, so the cell is never
dirty and never submitted. Seeding the amount into `draft` instead would
have marked every inherited cell dirty on load, and a first save would
have copied the whole wildcard grid into the class, silently detaching
it from prices the operator still edits elsewhere.

### Four real defects, none found by the thing that should have

**1. Narrowing the options did not move the value into them.** A control
still holding `standard` while the route offers Premium alone renders a
`<select>` with no matching `<option>`: it *looks* empty, keeps its old
value, and 400s on submit with "this route does not offer standard
services" — the exact failure the narrowing exists to prevent, reached
from the other side. The unit tests were green against it; the e2e spec
caught it. Fixed with a reconciliation `effect` on `schedule-form` and
`trip-form`, plus two unit tests.

**2. The grid was editable while showing another class's prices.**
Between the selector changing and the new grid arriving, heading and
legend already named the new class while the table still held the
previous one's amounts, every cell live. Fixed with a `switching`
signal that disables the cells and sets `aria-busy` until the data
matches the label — which is also what let the e2e stop racing it.

**3. The inherited amount was drawn at 2.64:1.** Nothing set a
placeholder colour, so Tailwind's preflight used `currentColor` at 50%.
It is not a hint — it is the price a passenger pays — and it would have
been the one number on the grid a low-vision operator could not read.
Now `placeholder:text-muted` (4.76:1) plus `placeholder:italic`, so the
distinction does not rest on contrast alone.

**4. Class and Status were adjacent, both neutral pills.** "Standard"
beside "Scheduled" is two identical grey chips with the same first
letter. Class moved beside Route, which it belongs with anyway.

Also worth knowing: **`patchValue` applies an explicit `undefined`**
rather than skipping the key. Every field here carries a model default,
so DRF marks it `required=False` and the generated read type admits
`undefined` — patching that straight into a required control blanks it
and makes the form silently unsubmittable. Both edit forms guard with
`?? 'standard'`.

### One deviation from this spec's own §E2E

It asks the e2e to "confirm a generated Trip carries the class". Trips
are generated by a nightly Celery Beat job a Playwright run cannot
trigger, so **a manual Premium trip stands in**, and the Schedule→Trip
snapshot stays covered by `apps/scheduling/tests/test_trip_classes.py`,
which asserts both that a generated trip takes its schedule's class and
that editing the schedule afterwards does not retro-change it.

### Not done

`customer-app` entirely — slice 3: class on trip search results, the
`?trip_class=` filter, and class carried through seat-picker and
booking-confirm into the ticket view.

---

## Implementation note (Slice 3, done)

Built 2026-09-03. **This closes spec 15.** 799/799 backend tests (up
from 797), 187 `customer-app` unit tests (up from 172), 1238 across the
workspace, four clean builds, lint clean on all nine projects, OpenAPI
drift clean both directions, and all four e2e projects green —
`customer-app` at 18, including a new `trip-classes.spec.ts`. Visual
pass at `docs/ui-review/15-trip-classes/iteration-3.md`.

### What the passenger now sees

The class appears at five points, and each reads it from the source
that is authoritative *at that point* rather than passing one value
down the flow:

| Screen | Source |
|---|---|
| `trip-search` result card | `GET /trips/search/`'s `trip_class` |
| `trip-search` filter | `available_trip_classes` on the browsed Route |
| `seat-picker` journey line | the availability envelope's `trip_class` |
| `booking-confirm` review row | router state, written from that envelope |
| `my-bookings` / `booking-tickets` | the API response for each screen |

### Two backend fields, agreed before building

Neither `my-bookings` nor the ticket view had any way to learn the
class. `BookingSerializer`'s nested trip carried id, route, departure
and service date; `TicketSerializer` carried nothing about the trip at
all; and there is **no `GET /bookings/{id}/`** to fall back on. Router
state was not an option for the ticket screen either — spec 6 made it a
routed path param precisely so it survives a refresh, and state does
not.

So: `trip_class` on `BookingTripSerializer`, and on `TicketSerializer`
sourced through `booking.trip`. The second needs
`select_related("booking__trip")` on `BookingTicketsView.get_queryset()`
to stay one query — the same "this field reads through, so the view
must join" note `BookingSerializer.get_trip` has carried since Phase 4.
Both are read-only and additive; no migration, no new endpoint.

### The filter narrows to the route, and clears rather than reconciling

`RouteBrowseSerializer` extends `RouteSerializer`, so
`available_trip_classes` was already in the browse response — narrowing
the filter costs no request, and a passenger can never filter to a
class the route does not run and read the empty result as "sold out".

Slice 2's recorded trap applies here too: **narrowing a `<select>`'s
options does not move a held value into them.** But the fix is
different, and simpler. Slice 2's forms needed a reconciliation
`effect` because several things could narrow their options; here only a
route change can, and `onRouteChange` was already clearing the stop
selection for exactly the same reason — the stops belong to the route
that was just replaced. The class clears with them. One line, no
effect, and the unit test asserts the cleared value directly.

### "All classes" here, "Any class" there

`customer-app` gets its own `shared/trip-class.ts` rather than
importing client-admin's — per-app, following `validator-app`'s
`labels.ts`, since `@shared-ui` is presentational and a domain label
map is not.

The fare half of client-admin's module is deliberately **not** copied.
No passenger surface touches a fare rule, and `''` means something
genuinely different on each side: on the fare screens it is a
*wildcard* that an exact-class rule overrides ("Any class"); here it is
simply "do not filter" ("All classes"). Two labels, on purpose — the
same distinction `trip-list`'s own filter already drew.

### The state contract, and why the new field is optional

`SeatPickerRequest.tripClass` is `?: string`, and has to stay that way.
`booking-draft.ts`'s guards run against `history.state`, so a passenger
mid-booking when a new build ships is carrying a state object written
by the old one. A required field would fail `isSeatPickerRequest` and
bounce them back to `/search` with a half-made booking behind them —
for a label. There is a unit test for exactly that shape, and it
asserts the screen did *not* redirect, not merely that the row is
absent.

`booking-confirm.returnToSeatPicker` rebuilds the request field by
field rather than spreading it, so the class had to be added there too
or `Back` would silently drop it. That is the second time this slice
touched a hand-rolled copy of a state object; the comment now says why
it is hand-rolled.

### The e2e fixture, and the one thing it had to avoid

`_seed_bookable_journey` gained a Premium `VehicleType`, `Vehicle`,
`FareRule` (1250 against the wildcard's 750) and a Premium `Trip` on
the **same Route and the same dates** as the Standard ones — a route
that runs one class cannot demonstrate anything this slice does. The
route's `available_trip_classes` is now `[premium, standard]`, set on
every run rather than only at creation, so a database seeded before
spec 15 comes forward.

Three constraints, all learned from suites that had already gone red
this way:

- **The Premium departure is at 18:45, not 06:30.** `Trip.Meta.ordering`
  is `("service_date", "scheduled_departure_at")`, so the Standard trip
  stays first and the three existing specs that click the first
  `Continue` keep selecting the trip they were written against.
- **Not `today + 90`** — `booking.spec.ts` asserts "No departures
  found" on exactly that date.
- **The Premium fare-rule existence check filters by class.** The
  unqualified `business + route` check the Standard rule uses would
  match the wildcard rule and skip this one forever, leaving Premium
  trips priced from the wildcard — the exact thing the test exists to
  disprove.

All four Playwright projects were re-run, not just `customer-app`: this
fixture is shared, and the last change to it left `customer-app`'s own
suite red for weeks unnoticed.

### One defect found by the e2e, in the e2e

`expect(locator).toHaveCount(n)` retries; `await locator.count()` does
not. The first version of the "both classes are reachable" test counted
immediately after clicking Search and resolved against the pre-search
page — reporting zero Standard departures on a page that had eleven.
Worth knowing generally: a bare `count()` in a Playwright assertion is
a race wearing an assertion's clothes.

### Named, not built

- **The ticket screen still shows no route and no departure time.**
  Adding the class sharpens this rather than causing it: the class is
  now the only journey-shaped fact on the card, and it is the least
  identifying one. Fixing it means route and departure on
  `TicketSerializer`, which is spec 6's surface. Recorded as N1 in the
  visual review.
- **A single-Booking `GET`.** The two serializer fields made one
  unnecessary here; if a later screen needs the whole Booking by id,
  that is its own decision.
- **Class in `payments`, `journeys` or `wallet`.** A pay-as-you-go
  journey already prices through `get_fare()` and picks up the class
  automatically; showing it there was not in scope.
