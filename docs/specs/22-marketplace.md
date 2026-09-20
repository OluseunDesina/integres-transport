# 22-Marketplace: a cross-operator booking marketplace

First spec of a new arc, not a continuation of the Transit OS adoption
arc (specs 1-21, all complete). Adds the "Tenant/TransitOS Mobile"
deployment mode named in stakeholder conversation but never built: a
passenger can search and book trips across **every** Client/operator on
the platform, not just their own Client's Businesses — the way Wakanow
aggregates unrelated airlines. See ADR-0009 for the cross-tenant access
mechanism this spec depends on; read that first.

## Scope and non-goals

### In scope

- Passenger self-registration (`POST /api/v1/auth/customer/register/`)
  under a new singleton **Marketplace Client** — the first passenger
  self-registration path on the whole platform, not marketplace-specific
  in mechanism, just its first consumer.
- Cross-Client trip search/browse and stop suggestion, mirroring
  `apps.network.services.find_route_stop_matches` /
  `apps.network.views.StopSuggestView`'s shape exactly, but resolving
  across every Client instead of the requester's own.
- Cross-Client seat availability, booking creation, and payment intent
  creation for one specific, already-found Trip.
- Widening six existing "my own records" views (`BookingMineView`,
  `BookingCancelView`, `PaymentIntentMineView`/`PaymentIntentDetailView`,
  `BookingTicketsView`, the `NotificationMine*` views) so a marketplace
  passenger's own records — which now legitimately belong to an
  operator's Client, not their own — stay visible to, and actionable by,
  them. `BookingCancelView` was found only while wiring the frontend's
  own cancel action, not in the original design pass — named here as a
  reminder that this list was verified against real usage, not assumed
  complete from reading code alone.
- A new frontend app, `marketplace-app`: registration/login, a
  Wakanow/Trip.com-style search landing page and flat (not
  grouped-by-operator) results list, and the existing booking flow
  (seat-picker → booking-confirm → payment → my-bookings → tickets)
  reused, duplicated into the new app for this slice.

### Non-goals (deferred, not silently dropped)

- Tap-and-go / open-seating marketplace support. Reservation-mode,
  prepaid-only, matching what `customer-app`'s own search already
  assumes (`fare_collection_mode == PREPAID` is one of the forced
  predicates below).
- Email verification, password reset, or phone collection on
  registration.
- Extracting the reused booking-flow screens into a shared library.
  Duplicated into `marketplace-app` deliberately — the marketplace's own
  search UX needs to be proven against the Wakanow/Trip.com reference
  before locking in a shared abstraction across two apps.
- Any operator-facing change: no client-admin marketplace opt-in/opt-out
  toggle, no marketplace-specific commission or settlement logic. A
  marketplace booking lands under the operator's own Client exactly like
  any other booking they took directly — commission/settlement treatment
  for a marketplace-referred booking is a real, separate product question
  for later.
- Cross-Business route aggregation ranking, geo/nearest-stop search, or
  anything beyond a flat list — same non-goal `docs/specs/4-fares-
  seating-booking-frontend.md` already recorded for the single-Client
  case, unchanged here.
- A Route's `available_trip_classes` narrowing on the marketplace search
  filter — same "all four classes, narrow on results not on the filter"
  design the reworked `customer-app` search already settled on
  (`docs/specs/4-fares-seating-booking-frontend.md` §3.3), reused as-is.

## Data model changes

**`Client`** gains `is_marketplace` (`BooleanField`, default `False`),
with a `UniqueConstraint(fields=["is_marketplace"], condition=Q
(is_marketplace=True), name="single_marketplace_client")` — mirroring
`apps.ledger`'s existing `single_integra_commission_account` constraint
exactly. A migration seeds the one row via `get_or_create(is_marketplace
=True, defaults={"name": "TransitOS Marketplace"})`. `Client` carries no
RLS (confirmed: no `EnableRowLevelSecurity` operation on its migrations),
so the seed needs none of the `platform_staff_bypass()` handling
`apps.ledger`'s own commission-account migration required.

No other schema change. `Booking`/`PaymentIntent`/`Ticket`/`Notification`
already carry everything needed (`client`, `business`, `passenger`/
`recipient`) — see ADR-0009's "the data model already tolerates this"
finding.

## API surface

All new endpoints `IsAuthenticated` only (passengers hold no Role,
ADR-0003) except registration, which is anonymous.

- `POST /api/v1/auth/customer/register/` — `{email, password, first_name,
  last_name?}` (matching `User`'s own field names directly, not a single
  combined `full_name`) → creates a `User` under the Marketplace Client
  (`is_client_staff=False`, `is_platform_staff=False`), returns the same
  token-pair shape login already returns (via
  `CustomerTokenObtainSerializer.get_token`, unchanged — no new JWT
  audience). 400 on an email already used *by this same Client* (existing
  per-Client uniqueness constraint — a marketplace-registered email can
  coincide with some operator's own passenger, since uniqueness is
  per-Client).
- `GET /api/v1/marketplace/stops/suggest/?q=&limit=` — identical response
  shape to `apps.network.views.StopSuggestView`, resolved via
  `Stop.all_objects` across every Client instead of the requester's own,
  filtered to `is_active=True`.
- `GET /api/v1/marketplace/trips/search/?origin=&destination=&service_date=&trip_class=` —
  identical response shape to the existing `TripSearchResult`
  (`trip`, `from_stop`, `to_stop`, `stops_between`, `fare`), plus the
  Trip's own `business.name` already included via the existing
  `TripSerializer`'s nested route/business shape — enough for a result
  card to show which operator it is without grouping by it. Backed by a
  new `apps.network.services.find_route_stop_matches_across_clients`
  (same signature and stop-pair-matching logic as the existing function,
  `all_objects` instead of `.objects`) plus the same per-Trip
  `FareNotConfigured`-excludes-the-row handling `TripSearchView` already
  has.
- `GET /api/v1/marketplace/trips/{id}/availability/` — identical response
  shape to `apps.seating.views.TripAvailabilityView`, Trip resolved via
  the new shared helper (below) instead of `Trip.objects`.
- `GET /api/v1/marketplace/trips/{id}/fare/` — identical response shape
  to `apps.fares.views.TripFareView`; the seat picker's own fresh quote,
  independent of the search result's already-embedded fare.
- `POST /api/v1/marketplace/bookings/` — identical request/response shape
  to the existing booking-create endpoint. Resolves the Trip via the
  shared helper, then calls `apps.booking.services.create_booking`
  unchanged.
- `POST /api/v1/marketplace/payments/` — identical shape to the existing
  payment-intent-create endpoint, delegating to `apps.payments.services`
  unchanged once the Booking already exists (Booking is by this point a
  normal, already-created row — no cross-tenant resolution needed here).

**Shared resolution helper** (new, lives once, used by both the
availability view and the booking-create view — not copy-pasted):
resolves one Trip via `Trip.all_objects.filter(id=..., status=SCHEDULED,
fare_collection_mode=PREPAID, route__status=ACTIVE,
business__kyb_status=APPROVED)`. Raises a `TripNotBookable` exception
(mapped to 404 — indistinguishable from "doesn't exist" to the caller,
same posture as every other not-found-vs-not-authorized case in this
codebase) if any predicate fails.

**Widened existing views** (`.objects` → `.all_objects`, existing
ownership filter kept/added, `deleted_at__isnull=True` added):
`apps.booking.views.BookingMineView`, `apps.booking.views
.BookingCancelView` (its `booking.passenger_id != user.id` check is the
sole gate either way — a cross-Client stranger's booking now 403s rather
than 404ing, consistent with the same-Client stranger case, not a
regression), `apps.payments.views.PaymentIntentMineView`/
`PaymentIntentDetailView`, `apps.ticketing.views.BookingTicketsView`
(both its Booking ownership lookup and its Ticket `get_queryset`),
`apps.notifications.views._notifications_for`. No response-shape change
to any of these — same serializer, same URL, same audience; only the
queryset's manager and explicit filters change (`BookingCancelView`'s
404-to-403 status-code change is the one deliberate exception, named
above).

**A new endpoint not in the original design pass**: `GET
/marketplace/trips/{id}/fare/`, the cross-Client variant of
`apps.fares.views.TripFareView` — found only while wiring the frontend's
seat picker, which fetches a fresh fare quote independently of the
search result's own embedded one (prices can move between search and
seat selection). Same resolve-then-assume-Client pattern as the other
marketplace views.

## Edge cases

- **A search term matches a Stop belonging to a Business whose KYB has
  since been un-approved** (no revoke/suspend state exists today, but
  nothing prevents `decide_business_kyb` being called a second time to
  flip an already-approved Business — see ADR-0009): excluded, since
  `business__kyb_status=APPROVED` is a forced predicate on both the
  search and the single-Trip resolution helper, not assumed from write
  time.
- **A marketplace passenger's email collides with an existing passenger
  under some operator's own Client**: allowed — email uniqueness is
  per-Client (existing constraint), registration only checks uniqueness
  against the Marketplace Client specifically.
- **A marketplace booking, once created, needs to appear in the
  *operator's* own client-admin booking list/ledger/settlement runs**:
  it already does, unchanged — `Booking.client` is always `trip.client`
  (the operator's), independent of `passenger.client` (the Marketplace
  Client). No operator-side code path needs to know the booking came from
  the marketplace at all.
- **An unrelated passenger — not the one who made the booking — must
  still be unable to read it**, even after the widened views drop RLS's
  Client-match: the existing `passenger=request.user` (or equivalent)
  filter is the only remaining check, so this must be asserted by a test
  for every one of the five widened views, not assumed to follow from the
  code change.
- **A Trip search/resolution racing a Trip's status changing out from
  under it** (e.g. cancelled between search and booking-create): already
  handled by the existing `create_booking` service's own status checks —
  unchanged behaviour, just reached via a cross-Client Trip instead of a
  same-Client one.

## Failure modes

- **The Marketplace Client row is missing** (a fresh environment where
  the seed migration hasn't run, or it was deleted): registration and
  every marketplace endpoint fail loudly at
  `get_or_create_marketplace_client()`'s first call — no silent fallback
  to creating a second one, since the `UniqueConstraint` would reject a
  second `is_marketplace=True` row outright and surface as a 500, which
  is the correct failure mode for a misconfigured deployment rather than
  degrading unnoticed.
- **A caller reaches a marketplace endpoint with a non-`customer`-audience
  JWT, or no JWT** (`IsAuthenticated` only, no Role/Permission gate,
  same as every other passenger-facing view — nothing here checks the
  audience claim beyond what `IsAuthenticated` already implies): treated
  identically to how every other passenger-facing endpoint already
  behaves today — not a new gap this spec introduces.

## Test plan

Backend:
- `get_or_create_marketplace_client()` idempotency; registration creates
  a User under it and returns a working token; a same-email registration
  under a *different* existing Client's passenger still succeeds
  (per-Client uniqueness).
- `find_route_stop_matches_across_clients`: each of the four predicates
  excludes independently (inactive route, un-approved business,
  non-scheduled trip, non-prepaid business) even when the *same-Client*
  variant would still find it — proves the marketplace path isn't
  silently reusing RLS's old safety net.
- The shared single-Trip resolution helper: same four predicates, plus
  the 404-on-failure mapping.
- **Cross-Client isolation, the other direction**: an *unrelated*
  passenger (not the booking's own) still gets nothing from any of the
  five widened views — this is the test that would catch a mistakenly
  dropped ownership filter, and is at least as important as proving the
  owning passenger *can* now see their own row.
- A full cross-Client booking integration test: two distinct seeded
  Clients/Businesses, a marketplace-registered passenger searches,
  resolves a Trip under the *other* Client, books it, and the resulting
  Booking's `client`/`business` are the operator's — not the
  passenger's own.

Frontend: `marketplace-app`'s search/results components (debounced
suggestion combobox reused from `customer-app`'s pattern, result-card
rendering including the operator-name metadata), registration form.

E2E: register → search → find a Trip under a Client the passenger does
not belong to → book → pay (stubbed, same posture as existing specs) →
see it in My Bookings → view the ticket. A second e2e assertion that an
operator's own client-admin login sees the same booking in their own
list.

## Migration impact

Additive only: one new nullable-defaulted boolean column plus a partial
unique constraint on `Client`, seeded via `get_or_create` in the same
migration (or an immediately-following data migration, matching
`apps.ledger`'s own two-step precedent). Nothing destructive, nothing
backfilled onto existing rows beyond the single new seeded row.

## Slice 2 — guest browsing, richer results, traveler details, a real hold-expiry fix

Eight enhancements requested directly against the shipped slice 1 app,
not a re-plan of it: (1) browsing (search + results) needs no session,
only the reservation step does; (2) search results gain vehicle type,
departure/arrival time, and duration; (3) results move to their own
`/search/results` route so they can be sorted/filtered and bookmarked;
(4) the result card's action is relabelled "Book now"; (5) seat-picker
collects a traveler (title/name/phone/email/DOB/gender/nationality) per
seat, or one lead traveler for a places-mode booking; (6) a persistent
trip/booking summary sidebar runs through seat-picker; (7) a real fix
for a race between a seat hold lapsing and the once-a-minute sweep task
noticing; (8) loading-state polish throughout, folded into each screen
above rather than a separate pass.

**Data model change**: a new `apps.booking.models.Traveler` (`BaseModel`)
— `booking` FK (`CASCADE`), `seat_reservation` FK (nullable, `CASCADE`,
a **string** reference to `"seating.SeatReservation"` since that app
already imports `Booking` the other way), `title`/`first_name`/
`last_name`/`phone`/`email`/`date_of_birth`/`gender`/`nationality`.
Additive and fully optional at the base `apps.booking` level —
`customer-app`'s own booking flow sends none of this and is unaffected;
only `apps.marketplace`'s own `MarketplaceBookingCreateSerializer`
(a `BookingCreateSerializer` subclass, same subclassing precedent
`StaffBookingCreateSerializer` already established) makes it required.
A seats-mode booking gets one `Traveler` per seat, tied to that seat's
`SeatReservation`; a places-mode one (open-seating or quick-book — both
are "a passenger count, not chosen seats") gets a single lead traveler
tied to the `Booking` itself with `seat_reservation=None`.

**API surface changes**:
- `MarketplaceStopSuggestView`/`MarketplaceTripSearchView`/
  `MarketplaceTripAvailabilityView`/`MarketplaceTripFareView` are now
  `AllowAny`, not `IsAuthenticated` — a guest can browse with no session
  at all, matching the Wakanow/TravelBeta/Trip.com reference this app is
  modelled on. `MarketplaceBookingCreateView`/
  `MarketplacePaymentIntentCreateView` stay `IsAuthenticated`: both need
  `request.user` as the passenger, so logging in (or registering) is the
  one point a guest is actually required to. No middleware change needed
  — `TenancyMiddleware` already tolerates an absent/invalid Bearer token.
- `TripSearchResultSerializer` gains `duration_minutes`/
  `scheduled_arrival_at`, both computed from `Route.estimated_duration_
  minutes` (an existing, nullable, operator-set field from spec
  19-route-lifecycle — no migration needed) — `None` on either when the
  operator hasn't set a duration for that route. `TripSerializer`'s
  `vehicle` gains a nested `vehicle_type: {id, name}`.
- `BookingCreateSerializer` (and its nested per-seat serializer) gain an
  optional `traveler` field, in the shape above; `apps.marketplace`'s own
  subclass makes it required.

**Edge case, closed**: a `SeatReservation.held_until` can lapse up to a
minute before `apps.seating.tasks.expire_seat_holds`'s periodic sweep
actually marks it `expired` — during that window `Booking.status` still
read `pending_payment`, so `initiate_payment`/`initiate_payment_with_
wallet`/`pay_booking_from_wallet` would all have accepted payment for an
already-lapsed hold, and `initiate_payment` would have gone further and
*re-extended* it via `refresh_seat_holds`. Closed by a new
`apps.seating.services.expire_stale_holds_for_booking` (and its
already-locked-row sibling `expire_stale_holds_for_locked_booking`),
called synchronously before each of those three functions' own
`PENDING_PAYMENT` check — but **after** each function's own
idempotency-replay short-circuit, not before it, so a legitimate replay
of an already-paid booking still returns the original `PaymentIntent`
rather than being wrongly rejected.

## Slice 3 — no seat map, auto-assign and "Change seat", seats-left everywhere

Requested directly against the shipped slice 2 flow as a redesign
comparison ("suggested flow": Find a trip → Passengers → Pay → QR
tickets), with two of its four stages explicitly excluded — hold time
matched to payment method, and post-payment "Change seats" open until a
cutoff. What remains: (1) search results show a real free-seat count,
not just for open seating; (2) the "Passengers" step collects names
first and never asks for a specific seat, on any booking mode; (3) the
backend auto-allocates a seat per named passenger, the same way
quick-book already did, generalized to also cover a trip whose operator
would otherwise let a passenger choose; (4) once seats are held, a
"Change seat" link lets a passenger move off an auto-assigned one —
gated on the operator's own `seat_selection_enabled` policy, since a
true quick-book trip (`False`) means the operator does not want
passenger seat choice at all, not even after the fact.

**Data model change**: none. `Traveler`/`SeatReservation` both already
had everything this needed; `SeatReservation.Status.RELEASED` (declared
in slice 1, never previously reached in practice) is what a "Change
seat" swap leaves behind on the seat given up.

**API surface changes**:
- `Bookability.capacity_remaining` (`apps.seating.services.get_bookability`)
  is now a real free-seat count for a seats-mode trip too, not just open
  seating — the seat list it already builds was never surfaced under
  this name for that branch. `TripSearchResultSerializer` gains a
  `capacity_remaining` field of the same meaning, computed by both
  search loops (`TripSearchView`, `search_trips_across_clients`) the
  same way `fare` already is — one `get_bookability()` call per matched
  result, the same cost class as the existing per-result `get_fare()`
  call.
- `BookingCreateSerializer` gains an optional `travelers` (plural) list,
  alongside the existing singular `traveler`. Given without an explicit
  `seats` choice, `create_booking` auto-allocates one seat per entry via
  the same `_allocate_seats` quick-book already used — generalized to
  run whenever `travelers` is given, not only when the trip's own
  `is_quick_book()` is true. `MarketplaceBookingCreateSerializer` now
  requires `travelers` (one per `passenger_count`) unconditionally and
  rejects `seats` outright — the per-seat `seats[].traveler` shape slice
  2 introduced for marketplace bookings is gone; every marketplace
  booking is "how many, and who," never "which seats."
- `BookingSerializer` gains `travelers` (booking-level, for a places-mode
  booking's passengers, none tied to a seat) and `BookingSeatReservation`
  gains a nested `traveler`, both read-back additions closing the gap
  slice 2's own Implementation note named and left open ("traveler
  display-back... deliberately NOT built"). Batched via the same
  `reservations_by_booking`-context shape the existing seats field
  already uses, so a booking *list* stays one query, not one per row.
- New `POST /bookings/{id}/reservations/{reservation_id}/change-seat/`
  (`apps.booking`) and its cross-Client marketplace mirror. Body is just
  `{seat}`; ownership and the operator's `seat_selection_enabled` policy
  are both checked before `apps.seating.services.change_seat` runs.
  `change_seat` creates a fresh `HELD` reservation on the new seat via
  the existing `create_reservation` (so a losing race against a
  concurrent booking is the same `SeatUnavailable` path, not a new one),
  marks the old reservation `RELEASED` rather than deleting it (deleting
  would cascade away the `Traveler` row tied to it), and repoints that
  `Traveler`'s FK to the new reservation.

**Edge case, closed**: a `Traveler` row surviving a seat change at all.
`SeatReservation.seat` is never updated in place — a fresh row is
created and the old one released — which is exactly the shape that
would normally cascade-delete the traveler tied to it; `change_seat`
repoints the FK itself, in the same transaction, rather than relying on
`create_reservation` to know a `Traveler` exists.

**Non-goal, explicitly excluded by the request**: hold duration varying
by chosen payment method, and a "Change seats" affordance open *after*
payment until a cutoff. Both would be real, separable pieces of work —
the former a moderate change (`hold_minutes` is already threaded through
per-call, not hardcoded), the latter a genuinely new capability (nothing
today lets a passenger touch an already-`CONFIRMED`/ticketed
reservation) — and neither is built here.

## Implementation note — Slice 1

Shipped in one pass, backend and frontend together, not split into
separate slices — the plan's own build order (ADR/spec → backend →
frontend → verification) was followed literally rather than stopped for
review between backend and frontend, since the whole point of a
marketplace is unverifiable without a real consumer of the new
endpoints.

**What actually shipped, beyond the original plan**, each found by
building or by driving the flow through a real browser rather than
assumed from reading code:

- `BookingCancelView` — a sixth widened "my own records" view, not five.
  Found wiring `my-bookings`'s own Cancel action. Its cross-Client
  "stranger's booking" test now expects 403, not 404 (§ Widened existing
  views above explains why this is a deliberate consequence, not a
  regression).
- `GET /marketplace/trips/{id}/fare/` — a sixth marketplace endpoint,
  not five. Found wiring the seat picker, which quotes fare
  independently of the search result's own embedded one.
- `TripSearchResultSerializer`/`BookingSerializer` both needed a new
  `business_name` field. The original design assumed `TripSerializer`'s
  existing nested route/business shape already named the operator; it
  doesn't — `Trip.business` serializes as a bare id, and `TripRoute` is
  `{id, name}` only. Both fixes are additive `SerializerMethodField`s,
  each requiring `select_related("business")` added at its own call
  site to avoid a new N+1 (one of which, in `search_trips_across_
  clients`, would otherwise have executed *outside* `platform_staff_
  bypass()` and failed the RLS check entirely, not just been slow).
- The three-mechanism cross-tenant read architecture ADR-0009 describes
  was itself refined mid-build: an early version of
  `find_route_stop_matches_across_clients` used `all_objects` alone and
  silently returned nothing for a genuinely cross-Client match, caught
  by its own test. `platform_staff_bypass()` (RLS) and
  `set_current_client_id`/`apps.marketplace.services.as_client` (the
  ORM contextvar) both turned out to be independently necessary — the
  ADR was corrected once this was confirmed live, not left describing
  the earlier, incomplete design.
- CORS: `config/settings/local.py`'s `CORS_ALLOWED_ORIGINS` needed
  `http://localhost:4204` added — found only by actually running
  `marketplace-app` against the real dev backend, not by any test
  (`APIClient`-based tests never hit CORS at all).

**Verification performed**: full backend suite (1241 passed), full
frontend suite across every project (marketplace-app: 21 passed), `ruff`/
`mypy` clean, OpenAPI schema regenerated with zero drift, every
project's `ng lint` clean, `ng build` clean for all five apps. Beyond
the automated suites: a real, live, non-mocked run — a fresh dev-database
fixture under a second, unrelated Client; register a marketplace
passenger through the actual UI; search and confirm a competing
operator's name, fare and stop count render; open the seat picker and
confirm its own independent fare quote; reserve a seat; confirm the
held-seat countdown; land on My Bookings and confirm the same operator
name renders there too, reading through the widened `BookingMineView`.
Zero browser console errors throughout except one expected, harmless
400 (`GET /wallet/mine/` for a Business under a Client the passenger
does not belong to — wallet is out of scope for this slice, and the
screen already degrades to "no wallet option shown" without it, exactly
as designed rather than by accident).

**Named, not fixed**: e2e automation (a real Playwright project/spec for
this flow, as opposed to the throwaway script used to verify it live);
extracting the duplicated booking-flow screens into a shared library,
once the marketplace UX is proven further; operator-side commission/
settlement treatment for a marketplace-referred booking, a real product
question doc'd as out of scope rather than decided by default; the two
carried, unrelated `client-admin-app` findings from the previous
self-check (action-menu, `live-operations` aria-role) — untouched,
confirmed out of scope for this arc.

**Next (slice 1)**: superseded by slice 2 below — see that section's own
**Next** for what is actually outstanding now.

## Implementation note — Slice 2

Shipped in one pass, same discipline as slice 1: backend, then frontend,
then full-stack verification, not stopped for review in between.

**What actually shipped, beyond the original plan**, each found by
building or by running the real test suites rather than assumed from
reading code:

- `Route.estimated_duration_minutes` already existed (spec
  19-route-lifecycle, already editable through the client-admin route
  form) — the plan's own assumption that a new field and a new
  operator-facing form would be needed was wrong, checked before
  building either. Duration/arrival ended up being a pure read-side
  addition: two computed `SerializerMethodField`s, no migration.
- `Traveler.objects.create(...)`'s `client` parameter needed a real
  `apps.clients.models.Client` type hint, not `object` — caught by
  `mypy`, not by any runtime test.
- Two real, non-obvious bugs in the hold-expiry fix, both caught only by
  running the real test suites (not by reasoning about the code):
  - **A deadlock, measurably real, not theoretical.** The first version
    called the new expiry check as its own separate
    `transaction.atomic()` block, immediately before
    `pay_booking_from_wallet`'s own — two sequential lock acquisitions
    on the same `Booking` row instead of one. Repeated runs of
    `test_blend_settlement_and_a_concurrent_wallet_spend_race_safely`
    went from 0/13 failures to roughly 1/3 once this landed. Fixed by
    running the check *inside* that function's own existing lock
    (`expire_stale_holds_for_locked_booking`) instead of acquiring a
    second one — confirmed back to 0 failures over 28 further runs.
  - **A cache-eviction bug with no exception anywhere near its cause.**
    The first version called `booking.refresh_from_db()` on the
    *caller's own* `Booking` instance inside `initiate_payment`/
    `initiate_payment_with_wallet`. That method clears Django's cached
    related-object state on whatever instance it's called on — and
    since Python passes objects by reference, this silently evicted the
    cache on the *caller's* object too. An analytics test that read
    `booking.trip` (already cached, from inside a tenant context) and
    then paid the booking and read `booking.trip` again (now outside
    any tenant context, since the payment call's own context had
    already exited) started failing with `Trip.DoesNotExist` — a
    downstream analytics test, nowhere near the payments code that
    caused it. Fixed by reassigning `booking = Booking.objects.get(pk=
    booking.pk)` to a fresh local object instead of mutating the
    parameter in place.
- One accepted trade from the deadlock fix above: `pay_booking_from_
  wallet`'s own hold-expiry check now runs inside its main
  `transaction.atomic()` block, so raising `BookingNotPayable` for a
  lapsed hold rolls the expiry write back along with everything else —
  the row can read `pending_payment` in the database for up to another
  minute, until the periodic sweep catches it independently. The
  invariant that actually matters (payment is refused) holds regardless;
  only how soon the row reflects it is affected, and only on this one
  function's direct-caller path.

**Verification performed**: full backend suite (1261 passed, `--create-
db` fresh), `ruff`/`mypy` clean across the whole backend, OpenAPI schema
regenerated with zero drift. All ten frontend projects' `test:all`
green, all five apps' `ng lint` clean, all five apps' `ng build` clean.
The three payments concurrency test files most relevant to the
hold-expiry fix (`test_blended_payment_concurrency`,
`test_wallet_payment_concurrency`, `test_payments_concurrency`) each run
5+ times independently to confirm the deadlock fix held, not just once.
No live browser pass this slice (offered; not requested).

**Named, not fixed**: everything slice 1's own "Named, not fixed" list
already carried (e2e automation, the shared booking-flow library
extraction, marketplace commission/settlement treatment, the two
unrelated `client-admin-app` findings) — none revisited this slice.
Traveler details are captured but not yet surfaced back on `my-bookings`/
ticket screens (the plan's own original scope included this; dropped as
a deliberate, named simplification once slice 2's actual ask — capturing
the data during reservation — turned out not to require displaying it
back, and wiring a batched N+1-safe read-back was assessed as more
machinery than this slice's real requirement justified).

**Next**: nothing scheduled. If a third slice is asked for, the
traveler-display-back item above and the real Playwright e2e project
slice 1 already named are the two most likely starting points.

## Implementation note — Slice 3

Shipped backend-then-frontend in one pass, same discipline as slices 1
and 2. Closes the traveler-display-back gap slice 2's own note left
open, as a side effect of needing it for real this time (a "Change
seat" confirmation has to say whose seat is moving).

**What actually shipped, beyond the original request**, each found by
reading the code or running the real test suites before writing around
it:

- Two pre-existing, latent `.objects`-vs-`all_objects` bugs, caught
  while wiring up the new `traveler` read-back and before they could
  ship broken. `BookingSerializer._reservations()`'s single-object
  fallback (used by `BookingCancelView`'s own response, among others)
  read `SeatReservation.objects`, not `all_objects` — silently correct
  for any Client-owned booking, silently *empty* for a marketplace
  passenger's own cross-Client one, since that code path runs inside
  `platform_staff_bypass()` with no matching `as_client()` to point the
  Python tenancy contextvar anywhere in particular. Never caught before
  because nothing asserted on `seats`/`hold_expires_at` in a cancel
  response for a marketplace booking. Fixed there and in the two new
  `Traveler` fallback queries that would otherwise have inherited the
  identical bug from new code instead of old.
- `capacity_remaining`'s meaning had to be widened, not just wired up. A
  seats-mode `Bookability` always returned `None` for it — a real
  per-seat count sat right there in the `seats` list `get_bookability`
  already built, just never read under this name. Widening it (and
  updating the one existing test that asserted the old always-`None`
  behaviour) was cheaper than adding a parallel field, and made the new
  "N seats left" search-result field a two-line addition in each search
  loop instead of a new query path.
- `MarketplaceBookingCreateSerializer.validate()` needed to check its
  own requirements (`travelers` present, `seats` absent) *before*
  calling `super().validate()`, not after — the base class's own
  branching gives a trip-mode-specific error ("seats is required") for
  a full-seat-choice trip sent with neither field, and marketplace's own
  "travelers is required" is what should have won instead. Caught by a
  test asserting the specific error key, not by inspection: the first
  version silently returned the wrong one.
- `booking-draft.ts`'s `BookingRequest` collapsed from a discriminated
  union (`kind: 'seats' | 'places'`, two different shapes) to one flat
  shape (`passengerCount` + `travelers[]`) — not a refactor for its own
  sake, but because the union's entire reason to exist (two different
  request bodies for two different ways of buying) went away once
  seat-picker stopped producing a `seats`-shaped request at all.
- `seat-picker.ts` lost its seat-grid rendering entirely (`SeatRow`,
  `splitAtAisleGaps`, `bySeatNumber`, `toggleSeat`, `selectedSeatIds`)
  — not hidden behind a flag, deleted, since slice 3's whole point is
  that this screen never asks for a specific seat any more. The one
  remaining net-new-component note from that file's old docstring (no
  seat-grid primitive exists anywhere in `shared-ui`) is now moot for
  this screen; `booking-confirm`'s own "Change seat" picker renders a
  flat list of seat numbers, not a grid, since picking one seat to swap
  to is a much smaller job than picking a whole party's worth up front.

**Verification performed**: full backend suite (1273 passed, fresh
`--create-db`), `ruff`/`mypy` clean across the whole backend, OpenAPI
schema regenerated and checked against the committed one with zero
drift. All ten frontend projects' `test:all` green (1715 tests total,
up from 1673), all five apps' `ng lint` clean, all five apps' `ng build`
clean. New backend tests cover: `capacity_remaining` for both booking
modes and all three `Bookability` statuses; auto-allocation with named
travelers for a trip that would otherwise require an explicit seat
choice; open seating with more than one named traveler; the
change-seat service function directly (happy path, seat-already-taken,
reservation-no-longer-held) and both its HTTP endpoints (ownership,
the `seat_selection_enabled` gate, a 404 for a reservation on someone
else's booking). New frontend tests cover `seat-picker`'s passenger-
count growing/shrinking without losing entered data, and
`booking-confirm`'s request-body shape, seat/traveler display, the
change-seat flow end to end, and the trip-filled-up return path. No
live browser pass this slice (offered per standing practice; not
requested).

**Named, not fixed**: everything slice 2's own list already carried,
minus the traveler-display-back item this slice closes. The two
explicitly excluded pieces from the originating request — hold duration
varying by payment method, and a post-payment "Change seats" window
open until a cutoff — are deliberately not built; see this slice's own
"Non-goal" note above for why each is a separable piece of work rather
than a natural extension of what shipped here.

**Next**: nothing scheduled. If a fourth slice is asked for, the two
excluded pieces above are the most likely starting points, followed by
the real Playwright e2e project slice 1 originally named.

## Cross-app note — slice 3's patterns ported to `customer-app` (2026-09-20)

Not a slice of this spec — `customer-app` is a separate, white-labeled
app outside the marketplace, and the user's request was explicitly to
carry three specific pieces of this app's own UI/UX to the others: the
"N seats left" search-result count, the sticky trip/booking summary
sidebar layout, and the "Change seat" link plus hold timer. Recorded
here because the reused parts — `capacity_remaining`, the
`change_seat` service, `BookingChangeSeatSerializer`, and
`apps.booking`'s own (non-marketplace) change-seat endpoint — are all
slice 3's own work, already generic across both apps with no backend
change needed.

**What did *not* port, deliberately**: `customer-app` keeps its manual
seat map. The user explicitly scoped this to the three items above, not
slice 3's own "no seat map, auto-assign" rework — `seat-picker.ts`
(customer-app) is unchanged in that respect; a passenger there still
picks a seat before it is held. `canChangeSeat` is derived from the
existing `kind: 'seats'` discriminant instead of a new
`seatSelectionEnabled` field for exactly that reason: in this app's own
model, `kind === 'seats'` already means the operator's
`seat_selection_enabled` was on when the passenger chose it, since
`buysPlaces()` only takes the passenger-count path otherwise.

**What shipped**: `trip-search.html` shows `capacity_remaining` per
result (`null` omitted, matching marketplace's own `capacityLabel`
convention exactly); `seat-picker.html`'s two branches (seat map,
passenger count) now share one sticky `<aside>` summary, replacing two
near-duplicate bottom bars; `booking-confirm.ts`/`.html` gained the
same `openChangeSeat`/`chooseNewSeat`/`cancelChangeSeat` methods as
marketplace's own `booking-confirm`, pointed at `/api/v1/trips/{id}/
availability/` and `/api/v1/bookings/{id}/reservations/{reservation_pk}/
change-seat/` (the base-app paths, not marketplace's `/marketplace/`-
prefixed ones) — the hold timer (`ui-countdown`) was already wired from
docs/specs/21-passenger-experience.md slice 2 and needed no change.

**Follow-up sweep (same day)**: asked directly whether other marketplace
UI/UX changes — "buttons etc" — had been missed. A side-by-side of every
button label across both apps' three booking screens turned up two real
differences and confirmed `my-bookings`/`booking-tickets` already at
parity (identical or explainably different — marketplace shows
`business_name` per booking, `customer-app` doesn't, because only a
marketplace passenger's bookings can span more than one operator).
Applied: the result-card button's label ("Continue" → "Book now",
`trip-search.html`) and an icon footer strip (`calendar-days`/`truck`/
`users`, matching `search-results.html`'s own) replacing the old plain-
text date/vehicle/seats-left line. Left alone: `booking-confirm`'s
submit button (`customer-app` says "Reserve seats"/"Reserve places",
marketplace says one "Reserve booking" for both) — not a missed label
update, a consequence of `customer-app` still knowing pre-submit whether
a trip is seats-mode (it kept the seat map), which marketplace's
seat-picker no longer does; flattening it to match would remove real
information the current wording still has.

**Also checked and left alone**: `client-admin-app`'s `counter-booking`
already shows a seats-left pill (`capacityLabel`, pre-existing); it has
no intermediate "held, review before paying" step for a hold
timer or "Change seat" to attach to — it goes straight from the seat/
passenger-count form to a final outcome panel, by design (a counter
agent finishes one transaction per passenger, docs/specs/18-manifest-
and-staff-booking.md). `super-admin-app`'s only seating-adjacent screen
(`seat-hold`) configures the hold-duration setting, not a live booking
flow. `validator-app` has no search or booking screen at all. None of
the three pieces above were forced onto these apps for that reason;
this is a deliberate scope decision, not an oversight, and is repeated
here since none of the three has its own spec to record it against.

Also surfaced, and **not** built: `marketplace-app`'s `login`/`register`
have no `customer-app` equivalent beyond `login` — `customer-app` has no
self-registration screen or route at all. This is not an oversight
either; per this spec's own scope section, `POST /api/v1/auth/customer/
register/` was "the first passenger self-registration path on the whole
platform" when slice 1 built it — before marketplace, every
`customer-app` passenger account was provisioned some other way (an
operator's own onboarding, out of this codebase's scope). Whether a
`customer-app` passenger should be able to self-register at all, and
which Client such an account would belong to, is a real product
decision this session did not have standing to make, so it is named
here rather than guessed at.

**Verification performed**: `customer-app`'s own suite (281/281,
up from 272 — 9 new tests covering the seats-left label, the icon
footer strip, and the change-seat flow end to end), `ng lint
customer-app` clean, `ng build customer-app` clean, `tsc --noEmit` on
its spec project clean. No backend change, so no backend suite re-run
was needed; the endpoints under test were already covered by slice 3's
own backend test suite.
