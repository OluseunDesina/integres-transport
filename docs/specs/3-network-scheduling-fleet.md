# Phase 3: Network, Scheduling, Fleet

## 1. Scope and non-goals

**In scope**: three new backend domain apps — `network` (Route, Stop,
ordered Route↔Stop), `fleet` (VehicleType, Vehicle, Driver), `scheduling`
(Schedule, Trip, a Celery Beat job that materializes concrete Trip rows
from each active Schedule) — plus `client-admin-app` screens for all six
models and six new fine-grained permission codenames
(`network.view`/`.manage`, `fleet.view`/`.manage`,
`scheduling.view`/`.manage`).

This is the operational domain every later phase builds on: Fares (Phase
4) prices a Route; Seating (Phase 4) maps a VehicleType's `capacity` into
a real seat layout; Booking (Phase 4) reserves seats on a Trip. None of
that exists yet — Phase 3 only builds the network/fleet/schedule shape
those phases will consume.

**Explicitly deferred / non-goals:**

- **Fares, Seating, Booking, Payments** — Phase 4+. The Phase 0 plan's
  original one-line sketch grouped `fares` in with this phase; that's
  superseded here, not treated as a contradiction to resolve. Nothing in
  this spec references `apps.fares`, `apps.ledger`, `apps.wallet`, or
  `apps.ticketing`.
- **Real seat maps.** `VehicleType.capacity` is a plain integer count
  this phase — no per-seat rows, no layout geometry. That's Phase 4's
  `apps.seating` (`SeatLayout`, per ADR-0004's segment-concurrency work),
  which will add a new model referencing `VehicleType` by FK without
  needing to touch or migrate this table.
- **Vehicle/Driver compliance document upload + review.** `Vehicle`/
  `Driver` carry plain expiry-date fields, not a `KycDocument`/
  `KybDocument`-style upload/approval workflow — an operator's own fleet
  assets aren't a third party being vetted, so that pattern doesn't
  obviously fit. An expired field produces a non-blocking
  `compliance_warnings` list, not a hard block (§6).
- **Automatic/time-based Trip status transitions.** All transitions are
  staff-driven via API this phase — no vehicle telemetry or validator
  app exists yet to justify an automatic clock-based flip to
  `in_progress`/`completed`.
- **PostGIS / geospatial queries.** No radius or nearest-stop search —
  `Stop.latitude`/`.longitude` are plain nullable `Decimal` fields, not
  a `PointField`. `django.contrib.gis` is not installed and
  `docker/postgres/init-extensions.sql` only enables `btree_gist` (for
  ADR-0004, a Phase 4 concern). `ASSUMPTION:` same "documented but
  unbuilt" treatment Phase 0 gave AWS provisioning generally.
- **Loop routes** (the same Stop appearing twice on one Route) — `RouteStop`
  enforces `unique_together(route, stop)` this phase.
- **Cross-Business Stop sharing within one Client.** `Stop` is
  Business-scoped, not Client-scoped, even though a Client running two
  Businesses in the same city could physically share a location.
  `ASSUMPTION:` revisit only if that becomes a real product ask.

## 2. Data model changes

All new models are `apps.core.models.BaseModel` subclasses (UUID PK,
`client` FK, timestamps, soft-delete, Postgres RLS via
`apps.core.migration_operations.EnableRowLevelSecurity` in the same
migration that creates them) unless noted. Every FK uses
`related_name="+"`, matching the `KycDocument`/`KybDocument`/
`Business.kyb_decided_by` precedent — a reverse accessor for a `BaseModel`
subclass would traverse `TenantScopedManager`, same reasoning already
established. Nothing here is a "no tenant yet" exception like
`Permission`/`ClientInvitation` — every model is genuinely tenant-owned
from creation.

### `apps.network`

**`Route`**

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | |
| `name` | `CharField(255)` | |
| `code` | `CharField(32, blank=True)` | optional short code |
| `description` | `TextField(blank=True)` | |
| `is_active` | `BooleanField(default=True)` | soft "retire" toggle, mirrors `Business.is_active` — no delete endpoint |

`UniqueConstraint(fields=["business", "code"], condition=~Q(code=""), name="unique_route_code_per_business")` —
blank codes never collide.

`Route` carries no vertical-specific fields of its own — it's
structurally vertical-agnostic (an ordered list of Stops). Any
vertical-specific behavior (fare zones for metro vs. flat fare for
shuttle) is `apps.fares`' problem; `route.business.vertical` is read via
the FK when a future phase needs it.

**`Stop`**

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | |
| `name` | `CharField(255)` | |
| `address` | `CharField(500, blank=True)` | free-text descriptor |
| `latitude` | `DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)` | |
| `longitude` | `DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)` | |
| `is_active` | `BooleanField(default=True)` | |

Service-layer validation (not a DB constraint): at least one of
`address` or (`latitude` **and** `longitude`) must be provided.

**`RouteStop`** (through model, ordered Route↔Stop relationship)

| Field | Type | Notes |
|---|---|---|
| `route` | FK → `Route`, `on_delete=CASCADE` | |
| `stop` | FK → `Stop`, `on_delete=PROTECT` | |
| `sequence` | `PositiveIntegerField` | 1-based position on the route |

`unique_together(route, sequence)` and `(route, stop)`. Rows are
hard-deleted and recreated on every reorder (`set_route_stops()`, §4) —
there's no historical value in a stale sequence row the way there is in
a `KycDocument`; the resulting order is still visible via the
`route.stops_updated` audit event's metadata. `Route`/`Stop` themselves
remain soft-deletable via the inherited `BaseModel.soft_delete()`, not
exposed via any endpoint this phase (same as `Business`).

### `apps.fleet`

**`VehicleType`**

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | |
| `name` | `CharField(100)` | e.g. "33-seater coaster" |
| `capacity` | `PositiveIntegerField` | seat **count only** — see §1 non-goals |
| `is_active` | `BooleanField(default=True)` | |

**`Vehicle`**

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | |
| `vehicle_type` | FK → `VehicleType`, `on_delete=PROTECT` | |
| `registration_number` | `CharField(32)` | |
| `insurance_expires_at` | `DateField(null=True, blank=True)` | |
| `roadworthiness_expires_at` | `DateField(null=True, blank=True)` | vehicle inspection cert |
| `is_active` | `BooleanField(default=True)` | |

`UniqueConstraint(fields=["client", "registration_number"], name="unique_vehicle_registration_per_client")`.
`ASSUMPTION:` uniqueness scoped per-Client, not globally — same
reasoning as `Client.email`'s per-tenant scoping; real plates are
nationally unique but nothing in this phase requires enforcing that
globally, and it avoids cross-tenant test/demo-data collisions.

**`Driver`**

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | |
| `name` | `CharField(255)` | |
| `phone` | `CharField(32, blank=True)` | no format validation — same `Client.phone` precedent |
| `license_number` | `CharField(64)` | |
| `license_expires_at` | `DateField(null=True, blank=True)` | |
| `is_active` | `BooleanField(default=True)` | |

`UniqueConstraint(fields=["client", "license_number"], name="unique_driver_license_per_client")`,
same reasoning as `Vehicle.registration_number`.

**Compliance semantics (`DECISION`)**: an expired `Vehicle`/`Driver`
field does **not** hard-block Trip creation or assignment this phase.
`GET /vehicles/`, `GET /drivers/`, and `GET /trips/` rows each carry a
computed `compliance_warnings: string[]` (e.g. `"Vehicle insurance
expired on 2026-01-01"`) for the UI to show as a warning, not a
validation error. There's no upload/approval workflow to make "expired"
an authoritative gate, and no grace-period/override-permission model has
been designed for a hard block — this defers the *hard* version of the
gate while making the *soft* version real (visible, not silently
ignored). Revisit if operators report this isn't strict enough.

### `apps.scheduling`

**`Schedule`**

| Field | Type | Notes |
|---|---|---|
| `route` | FK → `network.Route`, `on_delete=PROTECT` | |
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | denormalized from `route.business`, validated to match at creation — same narrowing pattern `KybDocument.business` uses alongside `BaseModel.client` |
| `days_of_week` | `JSONField(default=list)` | list of ISO weekday ints, `1`=Monday…`7`=Sunday (`date.isoweekday()` convention) |
| `departure_time` | `TimeField` | naive time-of-day, interpreted in `business.timezone` at generation time |
| `effective_from` | `DateField` | |
| `effective_until` | `DateField(null=True, blank=True)` | null = indefinite |
| `is_active` | `BooleanField(default=True)` | pauses generation without deleting; flipping to `False` also cascade-cancels future Trips, §6 |

`days_of_week` is `JSONField`, not Postgres `ArrayField`, for
consistency with the only two existing precedents in the codebase
(`AuditLog.metadata`, `IdempotencyKey.response_body`) rather than
introducing a new Postgres-specific field type for a 7-element list.
Validated in the serializer: non-empty, all values in `1..7`, no
duplicates, canonicalized sorted-ascending before save.

**`Trip`** (the materialized instance)

| Field | Type | Notes |
|---|---|---|
| `schedule` | FK → `Schedule`, `null=True, blank=True`, `on_delete=SET_NULL` | null = manual one-off trip |
| `route` | FK → `network.Route`, `on_delete=PROTECT` | always required, even for manual trips |
| `business` | FK → `businesses.Business`, `on_delete=PROTECT` | denormalized |
| `service_date` | `DateField` | business-local calendar date |
| `scheduled_departure_at` | `DateTimeField` | **UTC**, computed from `service_date` + `departure_time`, localized via `business.timezone` |
| `status` | `CharField`, `TextChoices` | see transition map below |
| `status_changed_at` | `DateTimeField(null=True, blank=True)` | updated on every transition |
| `vehicle` | FK → `fleet.Vehicle`, `null=True, blank=True`, `on_delete=SET_NULL` | assignable after creation |
| `driver` | FK → `fleet.Driver`, `null=True, blank=True`, `on_delete=SET_NULL` | assignable after creation |
| `booking_mode` | `CharField`, `choices=Business.BookingMode.choices` | **snapshotted** at creation from `business.booking_mode_default` — Route/Business mode changes only affect future Trips, per the Phase 0 plan's already-resolved contradiction #2 |
| `cancellation_reason` | `TextField(blank=True)` | populated on `cancelled` |

```python
class Status(models.TextChoices):
    SCHEDULED = "scheduled", "Scheduled"
    IN_PROGRESS = "in_progress", "In progress"
    COMPLETED = "completed", "Completed"
    CANCELLED = "cancelled", "Cancelled"

class Meta:
    ordering = ["service_date", "scheduled_departure_at"]  # overrides BaseModel's -created_at
```

**Legal transitions**:

```
scheduled   -> {in_progress, cancelled}
in_progress -> {completed, cancelled}
completed   -> {}   # terminal
cancelled   -> {}   # terminal
```

A request to transition to the Trip's own current status is an
idempotent no-op success; a request to anything not in the map above is
a `400` validation error (same shape as `KybDecisionSerializer`'s
rejection-reason validation).

`UniqueConstraint(fields=["schedule", "service_date"], condition=Q(schedule__isnull=False), name="unique_trip_per_schedule_per_service_date")` —
the generation task's idempotency mechanism (§4); manual trips
(`schedule=NULL`) are exempt so multiple ad-hoc trips can share a
route/date.

### New `Permission` codenames

Own data migration in `apps/identity`, not editing the existing
`0003_seed_permissions.py`:

| Codename | Description |
|---|---|
| `network.view` | View Routes and Stops |
| `network.manage` | Create/edit Routes and Stops, reorder Route↔Stop |
| `fleet.view` | View Vehicle Types, Vehicles, Drivers |
| `fleet.manage` | Create/edit Vehicle Types, Vehicles, Drivers |
| `scheduling.view` | View Schedules and Trips |
| `scheduling.manage` | Create/edit Schedules, create manual Trips, assign vehicle/driver, transition Trip status |

Six new codenames rather than reusing `business.manage` — confirmed with
the user. Routes/Fleet/Scheduling are genuinely separable operational
domains (a future "Dispatcher" role could plausibly hold
`scheduling.manage` without `fleet.manage`), matching the existing
`<domain>.manage` naming style rather than overloading `business.manage`
further.

`apps/identity/services.py::DEFAULT_ROLE_PERMISSIONS` gets a direct edit
(additive, but a real code change to Phase 1 code, not a new migration —
call out in review):

```python
"Owner": None,  # unchanged — all permissions
"Manager": [..., "network.view", "network.manage", "fleet.view", "fleet.manage",
                 "scheduling.view", "scheduling.manage"],
"Staff": [..., "network.view", "fleet.view", "scheduling.view"],
```

Manager gets full operational control (consistent with already holding
`business.manage`); Staff gets read-only (consistent with holding
`client.view` only today).

No migration here is destructive — every change is additive (`CreateModel`
+ RLS enablement, new `AddField`-free tables, new seeded rows).

## 3. API surface

All mounted at bare `/api/v1/` via each app's own `urls.py`, matching
`apps/businesses/urls.py`'s convention (not `/api/v1/network/...`). No
`GET .../{id}/` detail endpoints anywhere — matches the existing
`Business` precedent exactly: list responses embed everything needed,
and edit screens read from the already-loaded `ListStore` item rather
than issuing a second fetch.

| Method & path | Permission | Audited | Notes |
|---|---|---|---|---|
| `GET /routes/` | `network.view` | — | Paginated; each row embeds ordered `stops` |
| `POST /routes/` | `network.manage` | ✅ `route.created` | Requires `business.kyb_status == approved` (§6) |
| `PATCH /routes/{id}/` | `network.manage` | ✅ `route.updated` | `name`/`code`/`description`/`is_active` |
| `PUT /routes/{id}/stops/` | `network.manage` | ✅ `route.stops_updated` | Body `{"stops": ["<stop_id>", ...]}`, array order = sequence |
| `GET /stops/` | `network.view` | — | |
| `POST /stops/` | `network.manage` | ✅ `stop.created` | |
| `PATCH /stops/{id}/` | `network.manage` | ✅ `stop.updated` | |
| `GET /vehicle-types/` | `fleet.view` | — | |
| `POST /vehicle-types/` | `fleet.manage` | ✅ `vehicle_type.created` | |
| `PATCH /vehicle-types/{id}/` | `fleet.manage` | ✅ `vehicle_type.updated` | |
| `GET /vehicles/` | `fleet.view` | — | Embeds `compliance_warnings` |
| `POST /vehicles/` | `fleet.manage` | ✅ `vehicle.created` | |
| `PATCH /vehicles/{id}/` | `fleet.manage` | ✅ `vehicle.updated` | |
| `GET /drivers/` | `fleet.view` | — | Embeds `compliance_warnings` |
| `POST /drivers/` | `fleet.manage` | ✅ `driver.created` | |
| `PATCH /drivers/{id}/` | `fleet.manage` | ✅ `driver.updated` | |
| `GET /schedules/` | `scheduling.view` | — | |
| `POST /schedules/` | `scheduling.manage` | ✅ `schedule.created` | |
| `PATCH /schedules/{id}/` | `scheduling.manage` | ✅ `schedule.updated` | May cascade-cancel future Trips, §6 |
| `GET /trips/?route=&schedule=&service_date=&status=&limit=&offset=` | `scheduling.view` | — | First real `ListStore.updateQuery()` consumer |
| `POST /trips/` | `scheduling.manage` | ✅ `trip.created` | Manual trip; `schedule` forced null server-side |
| `PATCH /trips/{id}/` | `scheduling.manage` | ✅ `trip.assignment_updated` | Body `{vehicle, driver}` (UUIDs, nullable) — assignment only |
| `POST /trips/{id}/status/` | `scheduling.manage` | ✅ `trip.status_changed` | Body `{status, reason?}` — state-machine transition |

**Serializer FK-resolution note** (the standing class-body-evaluation
trap): every writable FK field above (`Schedule.route`, `Trip.vehicle`/
`.driver`, `Vehicle.vehicle_type`, the stop-reorder body's stop IDs) is
resolved manually inside a `validate_<field>()` method against
`Model.objects.get(pk=...)` (raising a field-level error on
missing/cross-tenant), never via
`serializers.PrimaryKeyRelatedField(queryset=Model.objects.all())` —
that queryset is evaluated once at class-body time, before any request
sets a tenancy context.

`Trip` gets two serializers, mirroring the `BusinessSerializer`/
`BusinessKybQueueSerializer` split: `TripSerializer` (read shape —
nested `route: {id, name}`, `vehicle: {id, registration_number} | null`,
`driver: {id, name} | null`, computed `compliance_warnings`) and
`TripStatusSerializer` (plain `serializers.Serializer`, not a
`ModelSerializer` — `status` `ChoiceField` + optional `reason`
`CharField`, mirroring `KybDecisionSerializer`'s reject-needs-a-reason
validation, adapted to "cancelled needs a reason").

Cross-**Business** (not just cross-Client) checks are needed where
`TenantScopedManager` alone doesn't catch it: assigning a Vehicle/Driver
from a different Business within the same Client to a Trip must be
rejected explicitly in `validate_vehicle`/`validate_driver`
(`vehicle.business_id == trip.business_id`).

No new rate limits — these are authenticated, permission-gated,
non-public endpoints, same throttle posture as `Business`'s equivalents
(none).

## 4. Service layer and Celery generation task

`services.py` per app, fat-service/thin-view, matching
`apps/businesses/services.py`'s shape exactly. Every function below
calls `apps.core.audit.record_audit_event(actor=..., action="<domain>.<verb>", target=<instance>, **relevant_fields)`.

**`apps/network/services.py`**

```python
def create_route(*, business: Business, name: str, code: str, description: str, created_by: User) -> Route:
    """Enforces business.kyb_status == Business.KybStatus.APPROVED (§6)."""

def update_route(*, route: Route, updated_by: User, **fields: Any) -> Route: ...

def create_stop(*, business: Business, name: str, address: str,
                 latitude: Decimal | None, longitude: Decimal | None, created_by: User) -> Stop:
    """Validates at least one of address or (latitude and longitude)."""

def update_stop(*, stop: Stop, updated_by: User, **fields: Any) -> Stop: ...

def set_route_stops(*, route: Route, stop_ids: list[str], updated_by: User) -> list[RouteStop]:
    """Validates every stop_id belongs to route.business, no duplicates.
    Hard-deletes stale RouteStop rows + creates the new ordered set in one
    transaction. Audits route.stops_updated with the resulting stop_ids."""
```

**`apps/fleet/services.py`**

```python
def create_vehicle_type(*, business: Business, name: str, capacity: int, created_by: User) -> VehicleType: ...
def update_vehicle_type(*, vehicle_type: VehicleType, updated_by: User, **fields: Any) -> VehicleType: ...

def create_vehicle(*, business: Business, vehicle_type: VehicleType, registration_number: str,
                    insurance_expires_at: date | None, roadworthiness_expires_at: date | None,
                    created_by: User) -> Vehicle: ...
def update_vehicle(*, vehicle: Vehicle, updated_by: User, **fields: Any) -> Vehicle: ...

def create_driver(*, business: Business, name: str, phone: str, license_number: str,
                   license_expires_at: date | None, created_by: User) -> Driver: ...
def update_driver(*, driver: Driver, updated_by: User, **fields: Any) -> Driver: ...

def compliance_warnings_for(obj: Vehicle | Driver) -> list[str]:
    """Pure function, no I/O — checks each expiry field against
    date.today(), returns human-readable warning strings. Called from
    both serializers (GET responses) with no persistence of its own."""
```

**`apps/scheduling/services.py`**

```python
def compute_scheduled_departure_at(business: Business, service_date: date, departure_time: time) -> datetime:
    """Shared helper: localizes service_date+departure_time in
    ZoneInfo(business.timezone), converts to UTC. Used by both
    create_manual_trip() and the generation task so the two Trip-creation
    paths can never disagree on this arithmetic."""

def create_schedule(*, route: Route, days_of_week: list[int], departure_time: time,
                     effective_from: date, effective_until: date | None, created_by: User) -> Schedule: ...

def update_schedule(*, schedule: Schedule, updated_by: User, **fields: Any) -> Schedule:
    """If days_of_week narrows, effective_until shrinks below an
    already-generated future date, or is_active flips False: wraps the
    read+cancel loop in select_for_update() and calls
    _cancel_future_trips_for_schedule() (below)."""

def _cancel_future_trips_for_schedule(schedule: Schedule, reason: str, actor: User) -> None:
    """Finds Trips for this schedule with status=scheduled and
    service_date >= today-in-business-timezone whose date no longer
    matches the current pattern (or all of them, if is_active=False),
    and calls transition_trip_status(..., reason=reason) on each —
    reusing the real service function so each gets its own standard
    trip.status_changed audit row with the real acting staff member as
    actor. Never touches in_progress/completed Trips."""

def create_manual_trip(*, route: Route, service_date: date, departure_time: time,
                        vehicle: Vehicle | None, driver: Driver | None, created_by: User) -> Trip:
    """schedule=None always. booking_mode snapshotted from
    route.business.booking_mode_default."""

def assign_trip_resources(*, trip: Trip, vehicle: Vehicle | None, driver: Driver | None,
                           updated_by: User) -> Trip:
    """Validates vehicle.business_id == trip.business_id and
    driver.business_id == trip.business_id when non-null."""

def transition_trip_status(*, trip: Trip, new_status: str, reason: str, actor: User) -> Trip:
    """Validated against the TRIP_TRANSITIONS map (§2). Same-status
    request is an idempotent no-op success; illegal transition raises a
    ValidationError-shaped exception the view surfaces as 400."""
```

### Celery Beat generation job

**Infrastructure gap this phase must close**: `docker-compose.yml`
today defines `postgres`, `redis`, `backend`, `celery-worker` — no
`celery-beat` service. `django_celery_beat` is already in
`INSTALLED_APPS` (added in an earlier phase, unused until now) but
nothing runs its scheduler. This phase adds a `celery-beat` service
(`command: celery -A config beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler`)
— without it, everything below is dead code that never runs in any
environment, dev or prod-shaped.

**Registration**: a data migration in `apps/scheduling` creates a
`CrontabSchedule` (`hour=1, minute=0` — 01:00 UTC daily) + `PeriodicTask`
row pointing at `apps.scheduling.tasks.generate_trips`. DB-backed via
`django_celery_beat`'s scheduler, so the run time is adjustable later via
Django admin without a code deploy — not hardcoded in
`CELERY_BEAT_SCHEDULE`.

**Why a single fixed UTC time, not staggered per Business timezone**:
this is a fast, DB-only batch job with no external calls — Lagos (WAT,
UTC+1) and Botswana (CAT, UTC+2) don't need individually off-peak run
times for a job this cheap. Confirmed with the user over a
timezone-staggered alternative.

**Horizon: `TRIP_GENERATION_HORIZON_DAYS = 14`** (a setting, not
hardcoded in the task — tunable via env/ops without a deploy). Confirmed
with the user over a 30-day alternative. Long enough that a future
booking flow always has ~2 weeks of bookable inventory the day after a
run; short enough the `Trip` table doesn't balloon with months of rows
per long-lived Schedule. Running daily rolls the window forward by
exactly one day each run — no gaps, no need to ever generate a large
batch in one pass.

**Algorithm** (`apps/scheduling/tasks.py`):

```python
@shared_task
def generate_trips() -> None:
    generated = 0
    schedule_count = 0
    skipped_invalid_timezone: list[str] = []
    with platform_staff_bypass():   # Celery has no ambient tenancy context —
                                     # required per CLAUDE.md for any task
                                     # touching BaseModel rows outside a request
        for schedule in Schedule.all_objects.filter(
            is_active=True, deleted_at__isnull=True
        ).select_related("business"):
            schedule_count += 1
            try:
                generated += len(
                    generate_trips_for_schedule(schedule, settings.TRIP_GENERATION_HORIZON_DAYS)
                )
            except ZoneInfoNotFoundError:
                skipped_invalid_timezone.append(str(schedule.id))
    record_audit_event(
        actor=None, action="scheduling.trips_generated", client_id=None,
        schedule_count=schedule_count, trip_count=generated,
        skipped_invalid_timezone=skipped_invalid_timezone,
    )

def generate_trips_for_schedule(schedule: Schedule, horizon_days: int) -> list[Trip]:
    """Pure-ish, unit-testable without Celery/Beat. 'Today' is evaluated
    in the Schedule's own Business timezone, not server UTC."""
    tz = ZoneInfo(schedule.business.timezone)  # raises ZoneInfoNotFoundError, caught by caller
    today_local = datetime.now(tz).date()
    created = []
    for offset in range(horizon_days + 1):
        service_date = today_local + timedelta(days=offset)
        if service_date.isoweekday() not in schedule.days_of_week:
            continue
        if service_date < schedule.effective_from:
            continue
        if schedule.effective_until and service_date > schedule.effective_until:
            continue
        trip, _ = Trip.all_objects.get_or_create(
            schedule=schedule, service_date=service_date,
            defaults=dict(
                client=schedule.client, business=schedule.business, route=schedule.route,
                scheduled_departure_at=compute_scheduled_departure_at(
                    schedule.business, service_date, schedule.departure_time
                ),
                booking_mode=schedule.business.booking_mode_default,
                status=Trip.Status.SCHEDULED,
            ),
        )
        created.append(trip)
    return created
```

**Idempotency**: the `UniqueConstraint(schedule, service_date)` (§2)
plus `get_or_create()` means re-running the task for a date/schedule
pair that already has a Trip is a true no-op — DB-enforced, safe under
concurrent or partial-failure execution, stronger than an
application-level "have I already run today" flag.

**Reconciliation on `update_schedule()`**: the generation task is purely
additive — it never edits or deletes an existing Trip, only creates
missing ones for dates newly entering the rolling window.
`_cancel_future_trips_for_schedule()` (above) handles the opposite
direction: a narrowing edit or deactivation cascade-cancels
already-generated future, not-yet-departed Trips that no longer match.
`ASSUMPTION:` editing `departure_time` alone does **not** retroactively
move already-generated future Trips' `scheduled_departure_at` — same
posture as `booking_mode` snapshotting; an operator who needs the new
time reflected on near-term Trips must explicitly cancel and let the
next run regenerate, or use a booking-aware reschedule flow this phase
doesn't build (Phase 4+).

## 5. Frontend (`client-admin-app`)

Following the exact `businesses/` (list+create/edit) and
`super-admin-app/kyc-queue/` (table+`ui-confirm-dialog`) patterns
established in Phase 2.

**New `ListStore` subclasses** (`src/app/shared/data/store/`):
`RouteStore`, `StopStore`, `VehicleTypeStore`, `VehicleStore`,
`DriverStore`, `ScheduleStore` — each `extends ListStore<T>`,
`super({}, 25)`, a ~15-line `fetchPage()` mirroring `BusinessStore`
exactly. `TripStore` is the **first real `TQuery` consumer** —
`extends ListStore<Trip, {route?: string; schedule?: string; service_date?: string; status?: string}>`,
passing all four as optional query params, finally exercising
`updateQuery()` (shipped in Phase 2, unused until now).

**Screens** (list + create/edit per domain, matching `business-list`/
`business-form`'s two-component-per-domain shape):

- `routes/route-list`, `routes/route-form` — form includes an inline
  ordered stop-picker: an "add stop" `ui-select` + a reorderable list
  with up/down buttons, local to `client-admin-app/src/app/routes/`
  (single consumer, not shared-ui-worthy — same "used once, local"
  precedent as the KYC/KYB approve-reject form).
- `stops/stop-list`, `stops/stop-form` — plain form (`name`, `address`,
  `latitude`, `longitude` as text inputs; no map picker, out of scope).
- `vehicle-types/vehicle-type-list`, `vehicle-type-form`.
- `vehicles/vehicle-list`, `vehicle-form` — `vehicle_type` picker via
  `ui-select`, expiry dates via the widened `TextField` `type="date"`;
  list row shows `ui-status-pill` (`tone='negative'` when
  `compliance_warnings` is non-empty).
- `drivers/driver-list`, `driver-form` — same shape as vehicles.
- `schedules/schedule-list`, `schedule-form` — `route` picker
  (`ui-select`, options fetched via a plain `limit=100` GET, same "small
  unpaginated helper" pattern `GET /staff/roles/` already established —
  no new backend endpoint), a local 7-checkbox days-of-week group
  (single consumer, not shared-ui), `departure_time` via
  `TextField type="time"`, `effective_from`/`effective_until` via
  `type="date"`.
- `trips/trip-list` — **Trip gets its own top-level screen**, not
  nested-only under Schedule/Route: a nested-only view would hide manual
  one-off trips and wouldn't provide one place to assign vehicle/driver
  or transition status. Uses `TripStore`'s query filters
  (route/schedule/service_date/status dropdowns above the table) — this
  is also how "Trips visible under a Schedule" is satisfied, by
  filtering the same list rather than a separate nested endpoint/screen.
- `trips/trip-form` — create-only (manual trips): route, service_date,
  departure_time, vehicle, driver.
- Trip **status transition** and **vehicle/driver assignment** happen
  inline from `trip-list` rows: status transition reuses the
  `ui-confirm-dialog` + reason-field pattern from `kyc-queue.ts`
  (`cancelled` needs a reason); vehicle/driver assignment is a plain
  inline `ui-select` + auto-`PATCH`-on-change, mirroring Phase 2 Slice
  2's staff inline-role-edit precedent rather than a dialog.

**`shared-ui` change**: `TextField.type` widens from
`'text' | 'email' | 'password'` (confirmed against the current
component) to add `'date' | 'time'` — a small, backward-compatible
extension of an existing component, same precedent as `ui-button`
gaining a `'danger'` variant in Phase 2. Phase 2's own spec explicitly
deferred `ui-date-input`/`ui-money-input` as "not yet needed"; this is
the first phase that actually needs date/time input, and widening
`TextField` is cheaper than a new CVA component for what's structurally
an `<input type="date">`/`<input type="time">`.

No other new `shared-ui` components — `ui-table`/`ui-paginator`/
`ui-status-pill`/`ui-select`/`ui-empty-state`/`ui-confirm-dialog` all get
reused as-is, proving (per Phase 2's own stated goal) that they
generalize past their first two consumers.

**Nav items** (`app-shell.ts`): "Routes" / "Stops" (`network.view`),
"Vehicle Types" / "Vehicles" / "Drivers" (`fleet.view`), "Schedules" /
"Trips" (`scheduling.view`) — write routes gated per-route on the
matching `.manage` codename, same three-layer pattern (route guard +
nav-filter + in-page `*appHasPermission` directive) as every prior
screen.

## 6. Edge cases

- **Creating a Route under a Business whose `kyb_status != approved`**:
  `DECISION`, closing the gap Phase 1 explicitly left open for this
  phase ("`kyb_status` will gate Route/Trip creation in Phase 3 — the
  field exists for that now, nothing enforces it yet"). `create_route()`
  now enforces `business.kyb_status == Business.KybStatus.APPROVED`,
  rejecting otherwise with a clear error. `Schedule`/`Trip` creation
  does **not** re-check — a `Route` existing is sufficient evidence its
  `Business` was approved at Route-creation time, and `kyb_status` has
  no downgrade-after-approval path in the current model, so a second
  check downstream would be redundant.
- **Two Routes sharing the same Stop**: allowed by design — real transit
  networks reuse stops across routes.
- **Route-stop reordering removing a Stop a future Phase 4 fare/seat
  segment might reference**: out of scope this phase (no Fares/Seating
  exist yet to reference a stop-segment) — flagged for whenever Phase 4
  is spec'd, not solved here.
- **`Schedule.effective_from` in the past**: allowed — the generation
  task's window starts at "today," so a past `effective_from` just means
  the schedule has "always" been active.
- **`Schedule.days_of_week` edited to include a new day**: the newly
  matching future dates within the rolling window are generated on the
  next run — no explicit "regenerate now" action needed, consistent with
  the additive/no-manual-trigger design.
- **Two staff editing the same Schedule concurrently**, one narrowing
  `days_of_week` while the other's request is in flight:
  `update_schedule()` wraps the reconciliation read+cancel loop in
  `select_for_update()`, same precedent as `decide_client_kyc`, to avoid
  a lost-update race producing an inconsistent cancellation set.
- **Deactivating a Schedule (`is_active=False`)**: `DECISION` — cascades
  to cancel future not-yet-departed Trips, not just silently stops
  future generation. "Stop running this schedule" is a real operator
  action that should visibly retract already-published upcoming trips;
  leaving stale `scheduled` Trips sitting around for a deactivated
  Schedule would be a silent surprise, not a safe default.
- **Assigning a Vehicle/Driver from a different Business (same Client)
  to a Trip**: rejected explicitly in `validate_vehicle`/`validate_driver`
  — `TenantScopedManager` prevents cross-*client* leakage but nothing
  stops a Client with two Businesses from mixing up which Business a
  Vehicle belongs to.
- **Cancelling a Trip that already has an assigned vehicle/driver**:
  allowed — cancellation doesn't clear the assignment; a cancelled
  trip's historical assignment (who *would* have driven it) is still
  meaningful audit context.
- **A manual Trip created for a `service_date` a Schedule's generation
  would also produce for the same Route/date**: allowed — the unique
  constraint only fires when `schedule` is non-null and matches, so
  nothing deduplicates across a manual Trip and a schedule-generated one.
  Accepted as an intentional scenario (e.g. an unscheduled surge trip),
  not a bug.
- **`Business.timezone` holding an invalid IANA string** (nothing
  validates it today — Phase 1's `ASSUMPTION:` on `currency`/`timezone`
  carries forward unchanged): `ZoneInfo(business.timezone)` raises
  `ZoneInfoNotFoundError` — the generation task catches this
  per-Schedule, skips it, and records it in the run's audit metadata
  rather than crashing the whole batch for every other Business's
  Schedules.

## 7. Failure modes

- **Celery Beat not running in an environment**: Trips silently never
  generate — no error surfaces anywhere in the API, since nothing calls
  the task synchronously. A future readiness-check-style safeguard
  (asserting the last `scheduling.trips_generated` audit event isn't
  more than ~26h old) is a real operational need but not built this
  phase — flagged, not solved.
- **Generation task partial failure mid-run** (e.g. a DB error on the
  5th of 50 Schedules): each Schedule's Trips are created via
  independent `get_or_create()` calls, not one giant transaction
  spanning the whole task — a failure partway through leaves earlier
  Schedules' Trips committed and later ones un-generated, which the
  *next day's* run naturally catches up on (idempotent, additive design
  tolerates partial failure gracefully).
- **RLS session variables unset for the Celery task** (forgetting
  `platform_staff_bypass()`): fails closed per CLAUDE.md's documented
  behavior — the task sees zero Schedules/Trips across every Client, not
  a crash, not a cross-tenant leak. A silent "nothing happened" is the
  actual failure signature to watch for in task logs.
- **DST transitions**: `ASSUMPTION:` not handled specially — Lagos
  (WAT) and Botswana (CAT) don't observe DST, so `zoneinfo`'s
  ambiguous/nonexistent-local-time edge cases don't arise for this
  phase's actual target markets. Flagged as a real gap if a future
  Business's timezone does observe DST.
- **Concurrent Trip status transitions** (two staff both cancel the same
  Trip): the second request's `transition_trip_status()` sees the
  already-cancelled state and returns the idempotent no-op success
  rather than erroring — deliberately more forgiving than
  `decide_client_kyc`'s "already decided" hard-reject, since
  re-cancelling an already-cancelled Trip isn't a conflicting outcome
  the way two contradictory KYC decisions would be.

## 8. Test plan

**Backend**: per app, mirroring `apps/businesses/tests/`'s shape —
creation/list/patch happy paths; non-`<domain>.manage`-holding staff →
403 on writes, 200 on `.view`-gated reads; cross-client access → 404
(via `TenantScopedManager`); cross-**business** Vehicle/Driver
assignment to a Trip → rejected. `set_route_stops()`: valid reorder,
rejects a stop from a different business, rejects duplicates. Trip state
machine: every legal transition succeeds and audits; every illegal
transition (e.g. `completed → scheduled`) returns 400; re-requesting the
current status is a no-op 200. `create_route()` rejects when
`business.kyb_status != approved`. `compliance_warnings_for()`: no
warnings when nothing expired, correct messages when one/both fields are
past `date.today()`.

Trip generation (unit-testable without Celery, via
`generate_trips_for_schedule()` directly): correct dates generated
within the horizon respecting `days_of_week`/`effective_from`/
`effective_until`; re-running produces zero new rows (idempotency,
asserted via `django_assert_max_num_queries` or a plain count check);
`update_schedule()` narrowing cascades cancellation to the right Trips
only (not `in_progress`/`completed` ones); `is_active=False` cancels all
future scheduled Trips; an invalid `Business.timezone` is skipped
without crashing the batch (assert via `generate_trips()`'s audit
metadata). The adversarial raw-SQL RLS test, run against all 6 new
models per the registry-driven completeness test's automatic pickup —
confirm, don't modify that test itself.

**Frontend (Karma)**: each new `ListStore` subclass (mapping + error
path, mirrors `business.store.spec.ts`); `TripStore` specifically tests
`updateQuery()` round-tripping into the right query params. Route-stop
reorder widget (add/remove/reorder emits the right ordered ID array).
Days-of-week checkbox group (emits the right int array). `TextField`'s
new `date`/`time` type variants render the correct native input type.
Each list/form component pair (renders rows, permission-gated
create/edit affordances, PATCH-on-change for inline Trip assignment,
reverts on failure — same pattern Staff's inline role-edit already
established).

**E2E (Playwright + axe)**, per screen, full state matrix (loading/
empty/populated/error/validation-error/success/permission-denied) at
390/768/1440px: Route create + reorder-stops flow; Stop create; Vehicle
Type/Vehicle/Driver create with a stress case (an expired date showing
the compliance warning); Schedule create; Trip list with each filter
exercised, manual Trip creation, inline vehicle/driver assignment, and
the full `ui-confirm-dialog` status-transition flow (approve-analog:
`scheduled → in_progress`; reject-analog: `→ cancelled` requiring a
reason) — reusing the `kyc-queue.spec.ts` keyboard/focus-restoration
coverage pattern for this dialog's second real consumer beyond KYC/KYB.
A dedicated non-Playwright test (pytest, calling the task function
directly) is the appropriate tool for the generation job itself — no
Celery Beat process runs inside the e2e suite.

## 9. Migration impact

All additive — no destructive step in this phase:

- Three new Django apps (`network`, `fleet`, `scheduling`) each get a
  `CreateModel` + `EnableRowLevelSecurity` migration per model, same
  pattern every prior app has used. The registry-driven RLS-completeness
  test (`apps/core/tests/test_row_level_security.py`) picks up all 6 new
  models automatically via `apps.get_models()` — no allowlist edit
  needed.
- `apps/identity` gets a new data migration seeding the 6 permission
  codenames (own migration, `0003_seed_permissions.py` untouched).
- `apps/identity/services.py::DEFAULT_ROLE_PERMISSIONS` — a direct
  Python-code edit (additive: new keys appended to existing lists), not
  a migration. Called out explicitly since it's a cross-phase touch to
  Phase 1 code, same category of deviation Phase 1 Slice 4's
  `IsClientStaff`→`HasPermission` retrofit already established as
  acceptable when flagged up front.
- `apps/scheduling` gets a data migration creating the `CrontabSchedule`
  + `PeriodicTask` rows for the generation job (django_celery_beat's own
  tables, already migrated in since `django_celery_beat` has been
  installed since an earlier phase — confirm its own migrations are
  already applied, not newly added here).
- `config/settings/base.py` — `apps.network`, `apps.fleet`,
  `apps.scheduling` added to `INSTALLED_APPS`; new
  `TRIP_GENERATION_HORIZON_DAYS = 14` setting.
- `config/urls.py` — three new `path("api/v1/", include("apps.<name>.urls"))`
  lines.
- `docker-compose.yml` — new `celery-beat` service (infrastructure
  change, not a code migration, but required for §4 to ever run
  anywhere).

## 10. Suggested implementation slicing

Backend app dependency order: `network` and `fleet` both depend only on
`businesses` (parallelizable, no cross-dependency between them);
`scheduling` depends on **both** (`Schedule.route` → `network.Route`,
`Trip.vehicle`/`.driver` → `fleet.Vehicle`/`.Driver`). That FK graph
directly determines the order below — `scheduling` cannot be built
first.

1. **`apps/network` backend + frontend** (Route/Stop/RouteStop, list/
   create/edit, ordered-stop reorder). Smallest independent domain,
   proves the new-app pattern (new permission codenames,
   `DEFAULT_ROLE_PERMISSIONS` edit, RLS registry auto-pickup) before the
   bigger `scheduling` slice depends on it.
2. **`apps/fleet` backend + frontend** (VehicleType/Vehicle/Driver, list/
   create/edit, compliance-warning display). Independent of slice 1 —
   sequenced second for review cadence, not a real dependency.
   Establishes the `TextField` date-input widening slice 4 also needs.
3. **`apps/scheduling` backend** (Schedule, Trip, state machine, manual-
   trip creation, vehicle/driver assignment, status-transition endpoint)
   **+ the Celery generation task + the new `celery-beat` service**.
   Deliberately the largest slice, same "prove the hard cross-cutting
   mechanism in one pass" justification as Phase 1's RLS slice and
   Phase 2's NavShell slice — this is the one slice that has to prove
   the cross-app FK wiring, the idempotent-generation mechanism, and the
   reconciliation-on-edit logic all at once, and none of it is safely
   splittable without leaving Trip half-real. Backend-only, matching
   Phase 1's own "backend now, screens next slice" precedent for
   `Business`.
4. **`apps/scheduling` frontend** (Schedule list/create/edit, Trip list
   with filters, inline status-transition + assignment). Split from
   slice 3 deliberately, mirroring Phase 2 Slice 1's own
   "backend proven first" ordering, and because this is also where the
   `ListStore` `TQuery` filter UI and the days-of-week/date-input
   widgets actually get exercised — worth its own review pass.

Each slice gets its own stop-and-review, per the working agreement —
this is a proposed order, not a request to build all four in one pass.
