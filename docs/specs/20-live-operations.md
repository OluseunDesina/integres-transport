# 20-Live-Operations: Vehicle telemetry, live monitoring, tracking and ETA

Eighth spec of the Transit OS adoption arc, and the one that adds a
genuinely new kind of data to this system.

## Scope and non-goals

Both briefs require live operations. `transit-admin-app-prompt.md`
wants a monitoring view showing in-transit trips with current location,
route progress, occupancy, delay and a map-like panel.
`transit_os_architecture_updated.md` wants passenger-facing vehicle
tracking with estimated arrival, plus a real-time activity feed.

None of it is possible today. There is **no telemetry model, no ingest
endpoint, and no live-update mechanism of any kind** — not one
`setInterval` or `interval(` exists anywhere in the frontend.

### The data-source decision

A device or driver application will eventually report position. Until
then, **positions are seeded and simulated** — but through the real
ingest path, not faked in the browser.

That distinction is the spine of this spec. The brief's own suggestion
("simulate live updates using RxJS streams and timers") would put
invented vehicle positions inside components, which means the day a
real device arrives every screen is rewritten, and in the meantime an
operations team is looking at fiction with nothing marking it as such.
Instead: a real model, a real authenticated ingest endpoint, and a
management command that drives it. The frontend cannot tell the
difference, and **every row records whether it came from a device or a
simulator** so the UI can say so plainly.

### In scope

- `TelemetryDevice`, `VehiclePosition`, `VehicleLiveState`.
- An authenticated batch ingest endpoint.
- A position simulator, dev/CI only.
- Live read endpoints for operators and for passengers on their own
  trip.
- Route progress and a stated-method ETA.
- The admin live-monitoring screen, passenger tracking, and a polled
  passenger activity feed.
- Retention/pruning.

### Non-goals

- **No WebSockets.** See the delivery decision below.
- **No traffic, road-network or routing engine.** ETA is computed from
  scheduled segment timing and straight-line progress. It is an
  estimate with a documented method, labelled as such, not a prediction.
- **No historical playback or breadcrumb replay UI.** Positions are
  retained for a bounded window for operational and dispute purposes;
  rendering a journey trace is a later feature.
- **No geofencing, automatic stop arrival detection, or automatic trip
  status transitions.** A Trip still moves status because a person or
  an existing service moves it. Inferring "departed" from GPS is a
  tempting follow-up and a good way to mark a trip departed because a
  vehicle moved in the depot.
- **No driver-facing application.** This spec defines the contract a
  device must satisfy; it does not build the device.
- **No device *health* dashboard.** Spec 17 deferred hardware health
  here; what lands here is device liveness (last seen, stale, revoked),
  which is what telemetry can actually answer. Battery, printer state
  and reader faults remain incident reports.

## Data model changes

New app `apps/telemetry`. All three models are `BaseModel` subclasses
with `EnableRowLevelSecurity` in their migrations.

### `TelemetryDevice`

Reuses `tapngo.TapCredential`'s established shape exactly — an opaque,
revocable, hashed token — rather than inventing a second device-auth
scheme:

```python
class TelemetryDevice(BaseModel):
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    label = models.CharField(max_length=100)
    token_hash = models.CharField(max_length=64, unique=True)
    vehicle = models.ForeignKey(Vehicle, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    is_active = models.BooleanField(default=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)
```

The raw token is returned **once**, at issue, and never persisted —
the same rule `issue_credential()` already follows, and the same reason
`seed_e2e_users` has to seed a known fixed token for e2e rather than
minting one through the real flow.

`vehicle` is nullable and `SET_NULL`: a device is hardware that gets
moved between vehicles, and a swap must not destroy its history.

### `VehiclePosition` — append-only history

```python
class VehiclePosition(BaseModel):
    class Source(models.TextChoices):
        DEVICE = "device", "Device"
        SIMULATED = "simulated", "Simulated"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    vehicle = models.ForeignKey(Vehicle, on_delete=models.PROTECT, related_name="+")
    trip = models.ForeignKey(Trip, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    device = models.ForeignKey(TelemetryDevice, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    source = models.CharField(max_length=16, choices=Source.choices)
    latitude = models.DecimalField(max_digits=9, decimal_places=6)
    longitude = models.DecimalField(max_digits=9, decimal_places=6)
    speed_kph = models.DecimalField(max_digits=6, decimal_places=2, null=True, blank=True)
    heading_degrees = models.PositiveSmallIntegerField(null=True, blank=True)
    recorded_at = models.DateTimeField()      # device clock
    received_at = models.DateTimeField()      # server clock

    class Meta:
        ordering = ["-recorded_at"]
        indexes = [models.Index(fields=["vehicle", "-recorded_at"])]
```

Coordinate precision matches `network.Stop` exactly rather than
introducing a second convention.

**Two timestamps, deliberately.** A device buffering offline and
uploading an hour later has accurate `recorded_at` values and a late
`received_at`; conflating them makes a backfilled batch look like a
vehicle teleporting in real time.

### `VehicleLiveState` — current position, one row per vehicle

```python
class VehicleLiveState(BaseModel):
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    vehicle = models.OneToOneField(Vehicle, on_delete=models.CASCADE, related_name="+")
    trip = models.ForeignKey(Trip, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    source = models.CharField(max_length=16)
    latitude / longitude / speed_kph / heading_degrees      # as above
    recorded_at = models.DateTimeField()
    updated_at inherited from BaseModel
```

Upserted on ingest. It exists so the live screen reads **one row per
vehicle** instead of a `DISTINCT ON` or a correlated subquery over an
ever-growing ping table. Without it, the cost of the live view grows
with history, which is the wrong thing for it to grow with.

Only ever advanced: a batch arriving out of order does **not** move
live state backwards. Guarded by `recorded_at > current.recorded_at`.

### High-volume table, and RLS

`VehiclePosition` is by far the highest-write table this system will
have. It is still a `BaseModel` with RLS — the rule is absolute and the
registry-driven test at `apps/core/tests/test_row_level_security.py`
has no allowlist. The cost is accepted and mitigated by retention, not
by exempting the table.

**Retention**: positions older than `TELEMETRY_RETENTION_DAYS`
(default 30) are deleted by a pruning task, exposed the same way every
other periodic job in this deployment is — as an internal task
endpoint (`POST /internal/tasks/prune-telemetry/`) alongside the
existing `generate-trips`, `expire-seat-holds` and notification sweeps,
because the target hosting has no cron. `VehicleLiveState` is never
pruned; it is bounded by the fleet size.

## API surface

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/telemetry/positions/` | device token | Batch ingest |
| `GET`/`POST` | `/telemetry/devices/` | `fleet.manage` | Issue and list devices; raw token returned once |
| `PATCH` | `/telemetry/devices/{id}/` | `fleet.manage` | Revoke / reassign vehicle |
| `GET` | `/trips/live/` | `scheduling.view` | Every in-progress trip with live state |
| `GET` | `/trips/{id}/live/` | `scheduling.view` **or** a passenger holding a ticket on it | One trip's live detail |
| `GET` | `/activity/mine/` | authenticated passenger | Recent fare/ticket/wallet events |
| `POST` | `/internal/tasks/prune-telemetry/` | internal task auth | Retention sweep |

No new permission codenames: device management is fleet management, and
live monitoring is scheduling visibility.

### Ingest

```jsonc
POST /telemetry/positions/
Authorization: Device <raw-token>
{
  "positions": [
    { "latitude": 6.5244, "longitude": 3.3792, "speed_kph": 34.5,
      "heading_degrees": 118, "recorded_at": "2026-09-01T08:14:02Z" }
  ]
}
```

- **Batch, not single.** A device on an intermittent connection buffers
  and uploads; a one-ping-per-request API guarantees data loss.
- Vehicle and Business come from the device registration, never from the
  request body. A device cannot report on another vehicle's behalf.
- Trip is resolved server-side: the vehicle's currently `in_progress`
  Trip, or null. A device does not know about trips.
- Idempotent on `(device, recorded_at)` — a retried batch after a
  timeout must not double-write. Enforced by a unique constraint and an
  ignore-conflicts bulk insert, not by a read-then-write race.
- Returns `202` with counts accepted and ignored. Never fails the whole
  batch for one bad row; malformed rows are reported and skipped, so a
  single bad reading cannot block a device forever.
- Rate-limited per device.

### Live read

`GET /trips/live/` returns an envelope per trip:

```jsonc
{
  "trip": { "id": "…", "route": "Ikeja → CMS", "trip_class": "premium",
            "vehicle": "LAG-221-XY", "driver": "A. Bello", "status": "in_progress" },
  "position": { "latitude": …, "longitude": …, "recorded_at": "…",
                "source": "simulated", "staleness_seconds": 12 },
  "progress": { "last_stop": "Ojota", "next_stop": "Maryland",
                "stops_completed": 3, "stops_total": 8, "method": "nearest_stop" },
  "eta": { "next_stop_at": "…", "final_stop_at": "…", "method": "scheduled_segment",
           "confidence": "low" },
  "punctuality": { "delay_minutes": 12 },
  "occupancy": { "boarded": 31, "capacity": 44 },
  "incidents_open": 1
}
```

`position` is `null` — not a zero coordinate — when a trip has no
telemetry, and the screen must render that as "no signal" rather than
placing the vehicle at the equator. `staleness_seconds` lets the UI
distinguish "moving" from "last heard from 40 minutes ago", which is
the single most operationally important thing on this screen.

### Progress and ETA: stated method, no pretence

- **Progress** — nearest `RouteStop` by haversine distance to the
  current position, constrained to move forward only. Requires stop
  coordinates; `Stop.latitude`/`longitude` are **nullable**, so a route
  with uncoordinated stops returns `progress: null` with
  `method: "unavailable"`.
- **ETA** — remaining scheduled segment time from the current progress
  point, offset by the observed departure delay. No traffic model, no
  historical learning. `confidence` is `low` throughout and the UI says
  "estimated".

Both carry an explicit `method` field so the client never has to guess
how a number was produced, and so a better method can be introduced
later without a silent change of meaning.

### Delivery: polling, not WebSockets

**Decision: short-interval polling with a cursor.**

The recorded target hosting has no long-lived connection story — a
30-second function timeout and a serverless request model. A WebSocket
layer would need a separate always-on process, a message broker, and
sticky routing; that is a deployment change, not a feature. Polling
`GET /trips/live/` every 10–15 seconds costs one cheap indexed read
per client and works on the platform as it exists today.

Mitigations that make polling acceptable rather than merely possible:

- `?since=` cursor on `updated_at`, so a poll returns only vehicles
  that moved.
- `ETag` / `If-None-Match`, so an unchanged fleet returns `304` with no
  body.
- Poll interval delivered by the server in the response, so it can be
  widened without a client deploy.
- Polling stops when the tab is hidden (`visibilitychange`) and on
  screen teardown. A live screen left open on a forgotten tab all
  weekend is otherwise a self-inflicted load test.

Revisit if and when a persistent-process deployment exists. Recorded
here rather than in an ADR because it is a deployment-constrained
implementation choice, reversible without data migration; if a
subsequent phase adds a broker, that is an ADR.

### Passenger activity feed

`GET /activity/mine/` composes the passenger's recent events — fare
deducted (from `FareJourney` and ledger lines), ticket issued and
boarded, booking paid, wallet topped up — into one reverse-chronological
list, each with a type, amount, resulting wallet balance and timestamp.
Polled on the same mechanism.

This is doc 1's "real-time activity feed" honestly implemented: it is
near-real-time, its latency is the poll interval, and it is not
described to the user as instantaneous.

## The simulator

`python manage.py simulate_vehicle_positions` — dev/CI only, guarded
the same way `prune_e2e_test_data` is, and refusing to run under
production settings.

- Walks each `in_progress` Trip's vehicle along its route's ordered stop
  coordinates at a plausible speed, emitting positions at a configurable
  interval, **through `apps.telemetry.services.record_positions()`** —
  the same function the ingest endpoint calls. The simulator exercises
  the real contract, including the idempotency constraint and the live-
  state advance guard.
- Writes `source="simulated"` on every row. Nothing downstream has to
  know it was simulated, but everything downstream *can* tell.
- Skips routes whose stops lack coordinates, and reports how many it
  skipped rather than silently doing nothing — the `prune_e2e_test_data`
  lesson, where a command that quietly skipped protected rows left the
  operator believing the queue had been cleared.
- Runs either as a one-shot batch or in a loop with `--interval`.

**Every UI surface fed by a simulated position shows it**: a persistent
`ui-alert variant="warning"` on the live screen when any visible vehicle
has `source: "simulated"`, and a per-vehicle marker treatment. Not a
subtle badge. An operations console that cannot be trusted to say
whether its data is real is worse than no console.

## Edge cases

| Case | Expected behaviour |
|---|---|
| Trip in progress, no device | `position: null`, `"no signal"` state — never a default coordinate |
| Device reporting for an unassigned vehicle | Accepted and stored; `trip: null`. Depot movement is real data |
| Batch arrives out of order | All rows stored; live state advances only on a newer `recorded_at` |
| Duplicate batch replay | Ignored by the `(device, recorded_at)` constraint; response reports the ignored count |
| Device clock badly skewed | Stored as sent, with `received_at` alongside. A `recorded_at` more than N hours from server time is flagged in the response and excluded from live state |
| Revoked device | `401`; positions rejected |
| Device reassigned mid-trip | New rows carry the new vehicle; history stays with the old |
| Route with uncoordinated stops | `progress: null`, `method: "unavailable"`; the map still shows the vehicle |
| Trip completed | Disappears from `/trips/live/`; its positions remain until pruned |
| Passenger requests `/trips/{id}/live/` without a ticket on that trip | `404`, not `403` — existence of another passenger's trip is not confirmed |
| Passenger requests a completed trip | Last known position with staleness, not an error |
| Poll with `?since=` and nothing moved | `304` |
| Fleet with zero live vehicles | Empty envelope with an explicit empty state, distinct from an error |
| Simulated and real data both present | Both shown; the warning names how many are simulated |

## Failure modes

- **Table growth.** At a 10-second cadence, one vehicle produces ~8 600
  rows a day. A hundred vehicles is ~26 million rows a month. Retention
  is therefore not optional and is part of Slice 1, not a follow-up.
  The 30-day default and the ingest cadence are both settings, and the
  arithmetic is written here so the next person changing either sees the
  consequence.
- **Pruning without a scheduler.** The internal-task endpoint exists
  because the target hosting has no cron. If nothing calls it, the table
  grows without bound. The endpoint reports the row count it deleted and
  the oldest remaining row, so a monitoring check can tell whether it is
  actually running — a silent no-op is the failure mode of every
  retention job ever written.
- **Position spoofing.** A leaked device token can report arbitrary
  positions for its vehicle. Bounded by revocation, by rate limiting,
  and by the vehicle binding being server-side. Not solvable further
  without device attestation, which is out of scope; named rather than
  implied to be handled.
- **Passenger location privacy.** This spec tracks *vehicles*, never
  passengers. The passenger endpoint returns the vehicle's position on a
  trip they hold a ticket for, and nothing else. Worth stating because
  the obvious next feature request is the opposite.
- **Simulated data escaping into a real decision.** Mitigated by the
  `source` column, the mandatory UI warning, and the command refusing to
  run under production settings. Accepted residual risk in dev and
  staging, which is where it belongs.
- **Polling load.** Bounded by `304`s, the cursor, the hidden-tab stop,
  and the server-controlled interval. If it still bites, the interval
  widens without a client deploy — which is why the interval is in the
  response.

## Test plan

### Backend

- Device issue: raw token returned once and not persisted; revocation
  rejects ingest; reassignment moves future rows only.
- Ingest: batch accepted; vehicle/business taken from the device and not
  the body; trip resolved server-side; malformed rows skipped and
  counted; duplicate batch ignored via the constraint; rate limit.
- **Live-state advance guard**: an out-of-order batch does not move live
  state backwards. Asserted directly, since this is the bug that makes a
  map jitter backwards in front of an operator.
- Clock skew: an implausible `recorded_at` is stored, flagged, and
  excluded from live state.
- Progress and ETA: computed for a coordinated route; `null` with
  `method: "unavailable"` for an uncoordinated one; progress never moves
  backwards.
- Live read: `?since=` cursor, `304` on `If-None-Match`, empty-fleet
  envelope distinct from an error, `position: null` for a signal-less
  trip.
- Passenger access: ticket-holder allowed; non-holder `404`; completed
  trip returns last known.
- Activity feed composition and ordering.
- Pruning: deletes beyond the window, retains inside it, never touches
  `VehicleLiveState`, and reports counts.
- Simulator: writes `source="simulated"`, goes through
  `record_positions()`, skips and reports uncoordinated routes, refuses
  to run under production settings.
- **Cross-client isolation** (mandatory set): another Client's devices,
  positions and live state are invisible on every endpoint; a device
  token cannot report against another Client's vehicle.
- **RLS registry test** passes for all three new models.

### Frontend

`client-admin-app` `live-operations`: trip list, selected-trip detail,
map panel, progress and staleness rendering, the simulated-data warning,
the no-signal state, and polling that **stops on teardown and on tab
hide** — asserted, because a leaked interval is invisible until it is a
production problem.

`customer-app` `trip-tracking` and `activity-feed`, same polling
discipline.

`ui-map` (`@shared-ui`) is this spec's own component, built to spec
21's tokens and component conventions like every other `@shared-ui`
primitive — marker, route and status colours come from the token layer,
so a white-labelled tenant's map matches their brand. Every other
primitive these screens use (page header, filter bar, action menu,
drawer, skeleton) comes from spec 14.

`ui-map`: renders markers, and exposes a
**non-map textual equivalent** — vehicle, last stop, next stop, ETA,
staleness — because a map is opaque to assistive technology, the same
rule spec 16 applies to `ui-chart`.

### E2E

Per-project. Seed a trip, run the simulator once, assert the live screen
shows the vehicle, the progress line, and the simulated-data warning;
assert the passenger tracking screen shows the same vehicle for a
ticket-holder. Axe pass on both.

## Migration impact

Purely additive: one new app, three new tables, three
`EnableRowLevelSecurity` operations, one unique constraint, two
indexes. No existing table is altered. Nothing destructive.

New settings: `TELEMETRY_RETENTION_DAYS`, ingest rate limits, default
poll interval, and the skew threshold. Following the trap recorded in
spec 6's Slice 1 note, each gets a real default in `base.py` rather than
a bare `config()` that would crash settings import in CI, where no
`.env` exists.

### Mapping library

`ASSUMPTION:` **Leaflet with OpenStreetMap tiles**, not Mapbox or
Google Maps as doc 1 suggests. Neither of those works without an
account and an API key, which is a procurement decision, not an
implementation one. Leaflet needs neither, and is wrapped behind
`ui-map` so swapping in a keyed provider later touches one component.

**Before production**: OSM's tile usage policy prohibits heavy
commercial use, so a self-hosted or commercial tile source is required
at real volume. Flagged, not solved — the same treatment production S3
storage and reverse-proxy topology already have.

## Suggested implementation slicing

Four slices, stop for review between.

**Slice 1 — telemetry backbone.** The three models, device management,
batch ingest with its idempotency and advance guards, retention task,
and the simulator. Fully testable with no UI at all.

**Slice 2 — live read API.** `/trips/live/`, `/trips/{id}/live/`,
progress and ETA, the cursor and `ETag` machinery.

**Slice 3 — operator live monitoring.** `ui-map`, the live screen, the
polling service, the simulated-data warning.

**Slice 4 — passenger tracking and activity feed.** `customer-app`
tracking screen and `/activity/mine/`.

## Implementation note — slice 1 (2026-09-07)

Backend only, as planned, and fully additive: new `apps/telemetry` (three
models, all RLS-enabled), device issue/revoke/reassign
(`GET`/`POST /telemetry/devices/`, `PATCH /telemetry/devices/{id}/`,
both gated on `fleet.manage` per the spec's own API table — no new
permission codenames), the batch ingest endpoint with its
`(device, recorded_at)` idempotency constraint and the
`VehicleLiveState` advance guard, `POST
/internal/tasks/prune-telemetry/` (added next to the other periodic-task
stand-ins in `apps.core.views`/`urls`, matching where those already
live rather than in `apps.telemetry` itself), and
`manage.py simulate_vehicle_positions`. 1142/1142 backend tests
(+26 in `apps/telemetry/tests/`); ruff/mypy clean; OpenAPI and
`schema.ts` regenerated — `POST /telemetry/positions/` is excluded from
the generated schema, the same reason `PaystackWebhookView` is (no
Angular client ever calls it, and drf-spectacular has no
`OpenApiAuthenticationExtension` for a device-token scheme). One new
`ENUM_NAME_OVERRIDES` entry (`TelemetrySourceEnum` — `source` collided
with `apps.incidents.Incident.source`'s own, different choice set).

`docs/backend-patterns.md` §11 was already right about *why* to
regenerate `openapi.yaml` together with `schema.ts`; what this slice adds
is a reminder of the *cost* of skipping it even once: the committed
`openapi.yaml` had gone stale as far back as spec 19 (never regenerated
after that slice landed), so this slice's regeneration carries a ~5,600
line diff that is almost entirely spec-19 catch-up, not telemetry —
confirmed by diffing path-by-path rather than trusting the line count,
since alphabetical resorting makes an unrelated no-op change look like a
mass deletion+re-add under a naive line diff. No functional drift found;
still, from here on, regenerate at the end of *every* slice, not just
ones that touch serializers.

Three real bugs, all caught before this note was written and all fixed
in place — recorded because none of them would have been caught by
reading the spec text alone:

- **`AuthenticationFailed` with an empty `authentication_classes` list
  silently downgrades to 403.** DRF's `APIView.handle_exception` only
  keeps a 401 when some authenticator on the view returns a truthy
  `authenticate_header()`; with `authentication_classes = []` (the
  first cut, doing the header parsing by hand in `initial()`), a
  revoked or unknown device token came back as 403, contradicting the
  spec's own edge-case table ("Revoked device: 401"). Fixed by writing
  a real `DeviceTokenAuthentication(BaseAuthentication)` with a
  non-empty `authenticate_header()`, which also let `DeviceRateThrottle`
  key on `request.auth` instead of a hand-stashed request attribute —
  simpler, and it's the idiomatic DRF slot for exactly this.
- **`settings.SETTINGS_MODULE` reads `None` the instant *any*
  `override_settings`-style override is active anywhere in the same
  test process — including this repo's own autouse `settings` fixture
  (`conftest.py`, on every single test).** Django's `UserSettingsHolder`
  — what `settings._wrapped` becomes under any override — hardcodes
  `SETTINGS_MODULE = None` as a class attribute ("doesn't make much
  sense in the manually configured case"), which shadows the real value
  for the rest of the test process, not just the deliberately-overridden
  setting. `simulate_vehicle_positions`'s production guard read
  `settings.SETTINGS_MODULE` and crashed with `TypeError: argument of
  type 'NoneType' is not iterable` on every single test in this suite,
  not just ones using `override_settings` directly. Fixed by reading
  `os.environ["DJANGO_SETTINGS_MODULE"]` instead — the same env var
  `ManagementUtility` itself resolves the settings module from, and
  untouched by settings-wrapping. Worth a `docs/traps.md` entry: any
  future dev/CI-only command guard should read the env var, never
  `settings.SETTINGS_MODULE`, in this codebase.
- **A `transaction=True`-style flush earlier in a run empties
  migration-seeded Permission rows for every test after it, if that run
  is later reused via a bare `pytest` invocation with no `--create-db`.**
  Already named in `docs/backend-patterns.md`'s own trap table; hit
  live during this slice anyway (six device-management tests failed
  with 403 after a full-suite `--create-db` run, gone the moment the
  next `apps/telemetry` run added `--create-db` back). Recorded here
  only to confirm the existing trap entry is still accurate, not to add
  a new one.

`RouteStopFactory`/`StopFactory` needed no changes; the simulator's own
walk is a deterministic step-count-modulo-interpolated-points scheme
(not real physics) specifically so two successive invocations in a test
are guaranteed to disagree on position without asserting on wall-clock
timing.

## Implementation note — slice 2 (2026-09-07)

Backend only, as planned. `GET /trips/live/` and `GET /trips/{id}/live/`
in a new `apps/telemetry/live.py` — a module of its own, not
`services.py`, for the same reason `apps.booking.manifest` is one:
this composes across `scheduling`, `network`, `booking`/`ticketing`/
`tapngo` (occupancy) and `incidents` (open count). Registered under
`apps.telemetry.urls` even though every path is `trips/...`, matching
how `apps.booking` owns `trips/{id}/manifest/` — the app that owns the
data owns the endpoint. Both gated on `scheduling.view` (the detail
endpoint also accepts a passenger holding a ticket or, on a
pay-as-you-go trip, a `FareJourney`, checked by hand since neither
`HasPermission` nor `HasAnyPermission` can express "this codename, or
ownership"). `ETag`/`If-None-Match` is checked before any per-trip
envelope is built, so a quiet poll costs one cheap query; `?since=`
then narrows a real `200` to the trips that actually moved. 1161/1161
backend tests (+19); ruff/mypy clean; OpenAPI/`schema.ts` regenerated,
zero drift.

Two data-model gaps the spec doesn't fully resolve on its own, both
labelled `ASSUMPTION:` in `live.py` rather than guessed silently:

- **"Constrained to move forward only" has no natural home in the
  slice-1 schema.** `VehicleLiveState` holds only the current position,
  not a stop index, so nothing persists "how far this trip has already
  reached" between polls. Implemented as a short-lived
  (`telemetry:progress:{trip_id}`, 24h) cache of the furthest
  nearest-stop index seen, so GPS jitter or a route looping back near
  its own start can't make a live trip's progress visibly regress. A
  soft guarantee — cache eviction only ever lets one stale poll compute
  a lower raw index, never *report* one — which is the right strength
  for an operational display backing nothing financial.
- **"Remaining scheduled segment time" has no per-stop schedule to read
  from.** This system has only `Route.estimated_duration_minutes`
  (spec 19) for the whole route, so ETA is a uniform split of that total
  across segments, offset by the observed departure delay. `eta: null`
  whenever the route carries no estimated duration at all, the same
  "no basis to compute from" reasoning `progress: null` already uses
  for an uncoordinated route.

One correctness case worth naming because it would have shipped wrong
without a dedicated test: **a vehicle reused for a later trip must not
leak that trip's live position onto an earlier, completed one.**
`VehicleLiveState` is keyed by vehicle, not trip, and a vehicle is
reused across departures — reading it for a *completed* trip would
silently show whatever the vehicle is doing now, on a different trip.
`current_position_for` branches on `trip.status`: `VehicleLiveState`
for a trip still `in_progress`, the trip's own last `VehiclePosition`
(genuinely trip-stamped at ingest time) otherwise.

Reused rather than duplicated: `apps.booking.manifest.trip_summary()`
for the `trip` envelope field (identical shape,
`LiveTripSerializer` is its own small per-app copy per the established
convention, not a cross-app import) and
`apps.analytics.services.seats_sold_and_total()` for `occupancy
.capacity`. **Not** reused: `apps.booking.manifest.totals()`'s own
`boarded` count — that builds a full manifest row list for a screen
opened once, and this endpoint is polled every 10-15 seconds across a
whole fleet, so `occupancy.boarded` is its own single `COUNT` query
instead.

One `drf-spectacular` correction made mechanically, not guessed: a
class-level `@extend_schema(operation_id=...)` on a plain `APIView`
prints "using @extend_schema on viewset class ... will most likely
result in a broken schema" — both live views needed
`@extend_schema_view(get=extend_schema(operation_id=...))` instead,
matching the pattern the device-management views already used. Without
an explicit id, `/trips/live/` and `/trips/{id}/live/` collided on the
same auto-derived `trips_live_retrieve`.

## Implementation note — slice 3 (2026-09-08)

`ui-map` (`@shared-ui`), the `live-operations` screen in
`client-admin-app`, and a small backend correction slice 2 shipped with
a real gap: `?since=` was read by `TripsLiveView` and covered by
backend tests, but no `OpenApiParameter` declared it, so `schema.ts`
typed the endpoint as taking no query at all — the typed frontend
client could never have sent it. Fixed with `_SINCE_PARAM`; see
`docs/traps.md`.

**`ui-map` is Leaflet, loaded dynamically, drawing custom `L.divIcon`
markers instead of Leaflet's own raster pins** — both so a marker's
tone tracks `BrandThemeService`'s runtime brand override the way every
other token-driven primitive does, and to sidestep Leaflet's default
marker-image path resolution, which breaks under most bundlers for
assets this component never needed anyway. The dynamic `import()`
resolves to a *different* module shape under Karma's build target than
under an app's production build (`docs/traps.md`); `loadLeaflet()`
unwraps both defensively. Every marker doubles as a row in a
visually-hidden accessible table (vehicle, last stop, next stop, ETA,
staleness, data source) — the same treatment `ui-chart` gives its own
plot, and for the same reason: a map is opaque to assistive technology.

**Polling lives in a new, independently-tested `Poller`
(`@shared-data`)**, not in the screen itself, because slice 4's
passenger tracking and activity feed need the identical discipline: one
poll in flight at a time, an immediate tick on `start()` and on
resuming from a hidden tab, a full stop on `ngOnDestroy()`, and a
server-controlled interval applied without restarting the poller. Its
own spec asserts the teardown/tab-hide behaviour directly — "a leaked
interval is invisible until it is a production problem" is the spec's
own phrase for why that couldn't be left to eyeballing.

**`LiveOperationsStore` decides for itself how `?since=` and `ETag`
compose**, since the spec left that to "slice 3 to decide": every poll
sends the previous `ETag` as `If-None-Match`; a `304` leaves the board
untouched, `since` included, since a provably-unchanged board cannot
need a wider cursor. A `200` merges its rows into an id-keyed `Map`
rather than replacing the list, so a delta response — which only ever
adds or updates trips — cannot make a scanning operator watch rows
reshuffle for no reason. `ASSUMPTION:` because merging alone can never
*remove* a completed trip, every 6th poll runs full (no `?since=`) and
replaces the map outright, so a finished trip still disappears within
roughly a minute at the default interval. The `since` cursor itself is
the server's own clock — a new `server_time` field on the response body
— rather than `Date.now()` or the `Date` response header: the header
is not exposed cross-origin by default (fixed here, `CORS_EXPOSE_HEADERS`)
and the browser's own clock is exactly the skew this cursor exists to
be immune to.

**The map only ever plots a trip that has a position.** "No signal" is
a fact the trip list states in words; inventing a marker at `(0, 0)`
for it is the one thing the spec's edge-case table forbids outright.

**Reused rather than duplicated:** `StatusPillTone`'s four colours name
a marker's tone the same way they name a pill's, off the same
`--color-success`/`--color-warning`/`--color-danger` tokens `ui-chart`
already draws from. **Not** shared: the punctuality/occupancy/ETA
label formatting is this screen's own — `ui-map`'s inputs take
pre-formatted strings, the same division of labour `ui-chart`'s
`valueFormatter` already established, so the primitive stays ignorant
of locale and this codebase's specific "Unknown"/"No signal" wording.

**One fixture gap closed, not carried:** every `seed_e2e_users` route
had `Stop.latitude`/`longitude` both `None`, so
`simulate_vehicle_positions` skipped all of them and the
live-operations e2e spec would have had nothing to find. Real Lagos
coordinates now anchor "Yaba → Lekki" (`OPEN_SEATING_STOP_COORDINATES`,
self-healing like its sibling fields), making it the fixture suite's
one coordinated route — see `docs/traps.md`.

Verified against a real running stack, not only unit tests: a local
backend, the client-admin-app dev server, a fresh in-progress Trip
seeded through the real API, and one real run of
`simulate_vehicle_positions` — confirmed the ingest → live-read →
frontend chain end to end (screenshot-verified progress line, ETA
"Unknown" for a route with no `estimated_duration_minutes`, the
simulated-data warning, and real OpenStreetMap tiles rendering). One
unrelated pre-existing dev-database row (a stray position at
`(100, 100)` on an unconnected fixture, predating this slice) briefly
made `ui-map`'s first-paint `fitBounds` frame the whole world instead
of Lagos — not a code defect, since the ingest endpoint itself
rejects an out-of-range coordinate; named here only so it isn't
mistaken for one if seen again.

1571 frontend unit tests across all nine projects (339/339 `shared-ui`
including +9 `ui-map`; 728/728 `client-admin-app` including +9
`LiveOperations` and +9 `LiveOperationsStore`; 18/18 `shared-data`
including +6 `Poller`), `ng lint` clean across every touched project,
1161/1161 backend tests (+1 assertion on `server_time`), ruff/mypy
clean, OpenAPI/`schema.ts` regenerated with zero drift.

**Next: spec 20 slice 4 — passenger tracking and activity feed**
(`customer-app`'s `trip-tracking` screen and `GET /activity/mine/`),
the spec's own closing slice.

## Implementation note — slice 4 (2026-09-08)

This closes spec 20. `GET /activity/mine/` in a new `apps/activity` —
no models of its own, the `apps.wallet`/`apps.analytics` read-layer
shape — plus `customer-app`'s `trip-tracking` (reusing `GET
/trips/{id}/live/` from slice 2) and `activity-feed` screens, each
backed by its own small store and a `Poller` (`@shared-data`, built in
slice 3 anticipating exactly this reuse).

**The spec's own wording didn't survive contact with the model, twice,
both checked rather than guessed** (`apps.activity.services`'s own
docstring carries the full reasoning):

- **"Fare deducted (from FareJourney and ledger lines)"** assumes a
  PAYG fare posts a ledger entry against the passenger's wallet.
  Traced the actual code path
  (`apps.tapngo.services._record_alight`) and confirmed it does not: a
  closed `FareJourney` only stamps `amount`/`currency`, and nothing
  ever calls `post_journal_entry` for it. `fare_deducted` entries are
  sourced from `FareJourney` alone and always carry
  `wallet_balance: null` — an honest account of what the system
  actually does today, a real, separate gap from this slice's own
  scope, not something to silently paper over by inventing a ledger
  line that was never posted.
- **"Ticket issued and boarded"** names two events; folded into one.
  A `Ticket` is issued at the same instant its `Booking` is paid, so a
  `booking_paid` entry already exists for that moment — a second
  "N tickets issued" row per booking (one per seat) would repeat the
  same purchase as noise. `ticket_boarded` stays its own entry: it
  happens later, at scan time, and is genuinely new information.

**"Resulting wallet balance" has no column to read** (ADR-0006: a
balance is always derived, `SUM(JournalLine.amount)`, never stored per
transaction) — recomputed as a running sum over each relevant wallet
account's full `JournalLine` history in Python, acceptable here only
because it is bounded by one passenger's own transaction count, the
same reasoning that would be wrong for a fleet-wide read. Set to `null`
whenever an entry's own payment genuinely never touched the wallet — a
card-paid booking's `journal_entry` has no wallet-account line at all,
and showing a balance beside it would misattribute a change that never
happened to that row.

**`trip-tracking` deliberately omits occupancy and open-incidents**,
both present in the shared `TripLiveEnvelope` slice 2 already returns:
neither answers a question a passenger riding their own trip is
asking. **The map only ever plots a trip with a position** — "no
signal" is stated as text, never an invented `(0, 0)` marker, the same
rule slice 3's board follows, enforced here by the same `ui-map`
component with no changes needed to it.

**`activity-feed` has no nav-bar link.** `app-shell.ts`'s own comment
already records the passenger nav at its measured 1200px width budget
("the six original links came to 556px... a seventh took it to 656px
and wrapped"); an eighth risks the same regression for a screen a
`home` quick-link card reaches exactly as well.

One backend-only correction, not a frontend gap: `GET
/trips/{id}/live/`'s envelope carries no `poll_interval_seconds` of its
own (it is also embedded, unlabelled, in every row of `GET
/trips/live/`'s `results` — adding one would mean repeating it on every
row there too). `trip-tracking.store.ts` uses a fixed, wider-than-the-
fleet-board client-side interval instead, named as a deliberate choice
in its own comment rather than a "TODO" implying a body field is
coming.

**Verified against a real running stack, the same discipline slice 3
established**: a local backend, the customer-app dev server, and the
fixture suite's own `seed_e2e_users` "boardable ticket" trip
(`_seed_boardable_open_seating_ticket`) — the one deterministically
**paid** trip a fixture passenger holds — transitioned to `in_progress`
and driven through `simulate_vehicle_positions`. Screenshot-confirmed
the whole chain: `my-bookings`' new "Track this trip" row action, the
tracking screen's progress line and simulated-data warning, and the
activity feed rendering real, accumulated historical entries (a mix of
all four types) from the shared dev database in the correct
reverse-chronological order.

**One genuinely new UI surface, one small backend addition to
support it**: `my-bookings.ts` gained a `canTrack`/`track` row action
(`paid` or `completed` bookings only — a booking that never paid or
was cancelled never had a real departure), and `home.ts` gained an
"Activity" quick-link card.

**E2E**: `customer-app/trip-tracking.spec.ts` reuses the fixture
passenger's own guaranteed-paid trip rather than creating a fresh one —
transitioning it to `in_progress` is idempotent across repeated runs
(`TripStatusSerializer.validate` treats "already at this status" as a
no-op success), which matters because this fixture, unlike slice 3's
freshly-created one, is shared with other specs and cannot simply be
recreated each run. `customer-app/activity-feed.spec.ts` asserts the
screen's two valid settled states (populated or genuinely empty) render
cleanly rather than asserting a specific row: seeding a *fresh* activity
entry from Playwright would need a completed Paystack charge, which no
e2e spec can drive, and what has accumulated from other specs' own
seeded flows varies run to run — the same load-sensitivity
`kyc-status.spec.ts`'s own axe check already accepts.

1596 frontend unit tests across all nine projects (up from 1571: +25 in
`customer-app` — 4 new stores' specs, `TripTracking`, `ActivityFeed`,
and `my-bookings.ts`'s two new tests), `ng lint` clean, 1171/1171
backend tests (up from 1161: +10 in the new `apps/activity`), ruff/mypy
clean, OpenAPI/`schema.ts` regenerated with zero drift, all four apps
build clean (`customer-app` and `client-admin-app` now carry
`allowedCommonJsDependencies: ["leaflet"]`, silencing the same cosmetic
CJS warning slice 3 left unaddressed for the two apps that don't use
`ui-map`).

**Spec 20 is complete, all four slices.** Spec 21 (passenger
experience) is next — see `docs/specs/README-transit-os-adoption.md`.
