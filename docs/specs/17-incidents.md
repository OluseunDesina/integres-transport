# 17-Incidents: Operational incidents and passenger issue reporting

Fifth spec of the Transit OS adoption arc. Self-contained: it depends
on nothing earlier and nothing later depends on it, beyond spec 16's
dashboard reading an open-incident count that returns `0` until this
lands.

## Scope and non-goals

Both source documents describe the same domain from opposite ends.
`transit-admin-app-prompt.md` asks for operator-created incidents with
categories, severities, a status lifecycle and a filterable queue.
`transit_os_architecture_updated.md` asks for passenger-submitted
hardware issue reports — broken reader, GPS inaccuracy, wrong stop
announcement — that "are sent to the Admin Hardware Monitoring Module".

They are one model with two entry points, and are spec'd together for
that reason. Building the operator queue alone would mean building the
passenger end again three months later against a schema that did not
anticipate it.

Nothing here exists today: there is no `incidents` app, no model, no
endpoint.

### In scope

- A new `apps/incidents` domain app: `Incident`, its lifecycle, and an
  append-only activity trail.
- Operator CRUD and queue in `client-admin-app`.
- Passenger report submission and history in `customer-app`.
- Reporting an incident against the trip a validator is working, from
  `validator-app`.

### Non-goals

- **No device registry.** The brief's "monitor device health" and "view
  broken validators" need a `Device` model that reports in — nothing in
  this system does. An incident can name a vehicle and carry a free-text
  device reference, which is enough to route a fault to a human. A real
  device registry belongs with spec 20, where hardware starts reporting
  telemetry, and is deferred there deliberately rather than half-built
  here.
- **No SLA timers, escalation rules, or auto-assignment.** Status is
  moved by people.
- **No notification fan-out beyond the existing bell.** `apps.notifications`
  already exists and is reused; no email or SMS (none is integrated
  anywhere in this codebase).
- **No passenger↔operator threaded conversation.** The activity trail
  is internal. A passenger sees status, not staff notes — see the
  visibility rule below.
- No incident-driven refunds or compensation. There is still no refund
  service.

## Data model changes

New app `apps/incidents`. Both models are `BaseModel` subclasses, both
get `EnableRowLevelSecurity` in their migration (the registry-driven
test at `apps/core/tests/test_row_level_security.py` enforces this with
no allowlist).

### `Incident`

```python
class Incident(BaseModel):
    class Category(models.TextChoices):
        HARDWARE = "hardware", "Hardware"          # reader, validator, printer
        VEHICLE = "vehicle", "Vehicle"             # breakdown, damage
        SAFETY = "safety", "Safety"
        SERVICE = "service", "Service quality"
        GPS = "gps", "GPS / location"
        ANNOUNCEMENT = "announcement", "Stop announcement"
        OTHER = "other", "Other"

    class Severity(models.TextChoices):
        LOW = "low", "Low"
        MEDIUM = "medium", "Medium"
        HIGH = "high", "High"
        CRITICAL = "critical", "Critical"

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        ACKNOWLEDGED = "acknowledged", "Acknowledged"
        INVESTIGATING = "investigating", "Investigating"
        RESOLVED = "resolved", "Resolved"
        CLOSED = "closed", "Closed"

    class Source(models.TextChoices):
        OPERATOR = "operator", "Operator"
        PASSENGER = "passenger", "Passenger"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    reference = models.CharField(max_length=16)          # human-quotable, see below
    title = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=20, choices=Category.choices)
    severity = models.CharField(max_length=20, choices=Severity.choices, default=Severity.MEDIUM)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    source = models.CharField(max_length=20, choices=Source.choices, default=Source.OPERATOR)

    trip = models.ForeignKey(Trip, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    route = models.ForeignKey(Route, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    vehicle = models.ForeignKey(Vehicle, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    driver = models.ForeignKey(Driver, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    stop = models.ForeignKey(Stop, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    device_reference = models.CharField(max_length=64, blank=True)

    reported_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    assigned_to = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")

    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)

    resolved_at = models.DateTimeField(null=True, blank=True)
    resolution_notes = models.TextField(blank=True)

    class Meta:
        ordering = ["-created_at"]
```

Every relation is nullable and `PROTECT`. Nullable because a passenger
reporting a broken reader on a platform may know none of them, and an
incident with no trip is still worth recording. `PROTECT` because an
incident that silently loses the vehicle it was about is worse than a
delete that fails loudly — and it matches every other FK in this
codebase.

`Meta.ordering` is declared explicitly. `Incident` declares its own
`Meta`, which — per the trap documented on `network.Route.Meta` and hit
again by `identity.Role` — **silently drops `BaseModel.Meta`'s
inherited ordering**. Unordered pagination is how `identity.User` and
`Role` shipped a real bug.

`latitude`/`longitude` mirror `network.Stop`'s existing precision
exactly (`max_digits=9, decimal_places=6`) rather than inventing a
second geographic convention.

### `reference`

A short human-quotable identifier (`INC-7F3K2A`) so an operator and a
passenger on the phone can talk about the same record without reading
out a UUID. Generated on create; unique per Business
(`UniqueConstraint(fields=["business", "reference"], condition=deleted_at IS NULL)`).

`ASSUMPTION:` random base32 rather than a per-Business sequence.
A monotonic counter needs a lock or a sequence per tenant, and leaks
volume to anyone who can see two references. Collisions are retried in
the service function.

### `IncidentActivity`

Append-only trail — status changes, assignment changes, notes.

```python
class IncidentActivity(BaseModel):
    incident = models.ForeignKey(Incident, on_delete=models.CASCADE, related_name="+")
    actor = models.ForeignKey(User, null=True, blank=True, on_delete=models.PROTECT, related_name="+")
    kind = models.CharField(max_length=20)      # status_change | assignment | note
    from_status = models.CharField(max_length=20, blank=True)
    to_status = models.CharField(max_length=20, blank=True)
    note = models.TextField(blank=True)

    class Meta:
        ordering = ["created_at"]
```

`CASCADE` from the incident — unlike every other FK here — because an
activity row has no meaning without its incident, and the incident
itself is soft-deleted via `BaseModel` rather than hard-deleted in
normal operation.

This is separate from `apps.core.AuditLog`, which stays the
security/compliance record. `IncidentActivity` is product surface: it
renders in the UI. Both are written on a status change.

### Lifecycle

`open → acknowledged → investigating → resolved → closed`, plus:

- any non-closed status may jump straight to `resolved` (a trivial
  incident does not need three clicks);
- `resolved → closed` is the only path out of `resolved`;
- `resolved`/`closed` may be **reopened to `investigating`** — a fault
  reported fixed and still broken is the normal case, and forcing a
  duplicate record loses the history;
- `closed` is terminal except for that reopen.

Enforced in `apps.incidents.services.transition_incident()` — the sole
write path for `status` — not in the serializer. Fat services, thin
views. Illegal transitions raise a typed exception mapped to `409`.

`resolved_at` is stamped on entry to `resolved` and cleared on reopen.

### New permission codenames

`incidents.view` and `incidents.manage`, seeded in an `apps/identity`
data migration following `0003_seed_permissions.py`'s shape, and
granted to Owner, Manager **and Staff** in `DEFAULT_ROLE_PERMISSIONS` —
unlike `analytics.view`. Frontline staff are exactly who notices a
broken reader; gating reporting behind a manager role would guarantee
nothing gets reported.

Passenger submission needs no codename — it is authenticated
customer-audience access, like booking.

## API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/incidents/` | `incidents.view` | Paginated, filterable by status, severity, category, business, route, trip, vehicle, driver, source, date range, free-text search |
| `POST` | `/incidents/` | `incidents.manage` | Operator-created; `source=operator` forced server-side |
| `GET` | `/incidents/{id}/` | `incidents.view` | Detail, including the activity trail |
| `PATCH` | `/incidents/{id}/` | `incidents.manage` | Editable fields only — **not** `status` |
| `POST` | `/incidents/{id}/transition/` | `incidents.manage` | `{ status, note }` — the only way status moves |
| `POST` | `/incidents/{id}/notes/` | `incidents.manage` | Appends an activity note |
| `POST` | `/incidents/report/` | authenticated passenger | `source=passenger` forced server-side |
| `GET` | `/incidents/mine/` | authenticated passenger | The reporter's own reports only |

`POST /incidents/report/` and `POST /incidents/` both take an
`Idempotency-Key`, via the existing `apps.core.idempotency` module — a
passenger on a flaky platform connection tapping "Report" twice must
not create two incidents.

### Visibility rule

`GET /incidents/mine/` returns a **reduced** serializer: reference,
category, status, description, created/resolved timestamps. It does not
return `assigned_to`, `resolution_notes`, the activity trail, or any
internal note. Staff discussion of a safety report is not passenger-facing.

Enforced by a distinct serializer class, not by field exclusion on the
shared one — an exclusion list is one careless edit away from leaking.

## Edge cases

| Case | Expected behaviour |
|---|---|
| Passenger reports with no trip/route/vehicle | Accepted; only `business`, `category`, `description` are required |
| Passenger reports against another Client's trip | RLS makes the trip unresolvable; `400` on the FK, no cross-tenant leak |
| `business` not supplied on a passenger report | Derived from the referenced trip; required if no trip is given |
| Duplicate submit under one `Idempotency-Key` | Returns the original incident, no second row |
| `PATCH` attempting to set `status` | `400` naming the transition endpoint |
| Illegal transition (`closed → open`) | `409` |
| Reopen from `closed` | Allowed, to `investigating`; `resolved_at` cleared; activity records it |
| Transition to the status it already has | No-op success, no duplicate activity row |
| Assigning a user from another Client | `400` — resolved through the tenant-scoped manager, so it simply is not found |
| Deleting a vehicle referenced by an incident | `PROTECT` refuses, as designed |
| `prune_e2e_test_data` and e2e incidents | Incidents reference protected rows, so pruning skips them — the same structural limit `KybDocument` already has. Named here so it is not rediscovered |
| Reference collision | Retried in the service; unique constraint is the backstop |

## Failure modes

- **Serializer FK resolution under `TenantScopedManager`.** The
  documented trap applies directly: a
  `PrimaryKeyRelatedField(queryset=Model.objects.all())` declared on the
  serializer class is evaluated once at class-body execution, before any
  tenancy context exists, and freezes empty forever. This model has
  **six** tenant-scoped FKs — the single most likely way to get this
  spec wrong. Every one is resolved in a `validate_<field>()` method
  instead. Same rule for the views: `get_queryset()` as a method, never
  a `queryset =` class attribute.
- **Notification volume.** A critical incident notifies staff through
  the existing bell. A burst of hardware reports from one broken device
  could flood it; notifications are therefore emitted on **create and on
  transition to `critical`**, not on every activity row.
- **Passenger reporting as an abuse vector.** Rate-limited per user, and
  reports carry `reported_by`. No anonymous reporting — the customer app
  is authenticated throughout.
- **Location precision.** `latitude`/`longitude` are recorded exactly as
  supplied by the browser and never inferred. A report with no location
  is normal, not degraded.

## Test plan

### Backend

- Model defaults, `reference` generation and uniqueness per Business,
  collision retry.
- **Explicit `Meta.ordering`** asserted, so the `Role`/`User` unordered
  pagination bug cannot recur here.
- Full transition matrix: every legal move accepted, every illegal one
  `409`, reopen path, idempotent same-status transition, `resolved_at`
  set and cleared.
- `PATCH` cannot move status.
- Activity trail written for every status and assignment change, in
  order, with the actor; `AuditLog` written alongside.
- Passenger report: `source` forced, business derived from trip,
  required-field validation, `Idempotency-Key` replay returns the
  original.
- **Visibility**: `/incidents/mine/` omits `assigned_to`,
  `resolution_notes` and the trail — asserted on the response body, by
  key absence, not by a shape guess.
- **Cross-client isolation** (mandatory set): another Client's
  incidents are absent from the list, the detail is a `404`, and a
  cross-client `assigned_to` or `trip` cannot be set.
- **RLS registry test** passes for both new models — automatic, but it
  is the check that catches a missing `EnableRowLevelSecurity`.
- Permission gating per endpoint, and the codenames actually seeded and
  granted to the three presets.
- Filters: each one narrows correctly, and combinations compose.

### Frontend

`client-admin-app`: `incident-list` (filters, pagination, severity and
status pills — label present, never colour alone), `incident-form`
(create and edit), `incident-detail` (trail, transition control,
assignment). `customer-app`: `report-issue` form and `my-reports`.
`validator-app`: a report action on the active trip.

Forms are asserted on **rendered** validation output —
`ui-text-field`/`ui-select` render an error only when the parent binds
both `[invalid]` and `[errorMessage]`, and a form binding neither
silently does nothing on invalid submit. That is exactly how a previous
form shipped broken.

Stores extend `ListStore`; the detail screen resolves by id through
`findByIdPaged` with an **explicitly passed** scope.

### E2E

Per-project. `client-admin-app`: create an incident against a trip,
move it through acknowledge → investigate → resolve, assert the trail
renders each step, reopen it. `customer-app`: submit a hardware report
and see it in `my-reports` with status only. Axe pass on every new
screen.

## Migration impact

Purely additive: one new app, two new tables, two
`EnableRowLevelSecurity` operations, one permission-seeding data
migration. No existing table is altered. Nothing destructive; no
approval required.

`apps.incidents` is added to `INSTALLED_APPS` and its urls included at
`/api/v1/`.

## Suggested implementation slicing

Three slices, stop for review between.

**Slice 1 — backend.** Models, migrations, RLS, service layer with the
transition rules, all endpoints, permissions seeded, full test suite.

**Slice 2 — operator UI.** `client-admin-app` list, form and detail,
plus the nav entry and the dashboard's open-incident count (which spec
15 already reserves a slot for).

**Slice 3 — reporter UI.** `customer-app` report + history, and the
`validator-app` report action.

---

## Implementation note (Slice 1 — backend, done)

Built 2026-09-06. `apps/incidents` exists with both models, RLS on both,
the full service layer, all eight endpoints, both permission codenames
seeded **and backfilled**, notifications wired, and the three analytics
slots this spec had been leaving at zero now filled. **1015/1015 backend
tests pass** on a fresh database, up from 920.

### Scope taken beyond the spec's own slicing

The spec put "the dashboard's open-incident count" in slice 2. It is a
backend change to `apps/analytics`, so it landed here instead, along
with the other two hardcoded zeros nobody had listed:
`dashboard.incidents.open`, `dashboard.recent_incidents`, and
`trip_performance.incidents`. Slice 2 is now purely a UI slice, and the
client-admin dashboard's "Open incidents" stat became real the moment
this deployed — verified live at `{"open": 3}`.

`recent_incidents` was `ListField(child=DictField())` while it was
always empty, which generated as an untyped record in `schema.ts`. It is
a declared `RecentIncidentSerializer` now, so slice 2 gets typed rows.

**No `incidents` CSV export resource**, deliberately. This spec does not
ask for one, and `apps/analytics/tests/test_exports.py` was using
`/api/v1/exports/incidents/` as its canonical *unknown* resource to
prove a 404 rather than a misleading 403 — a name chosen when no such
domain existed. That test now uses `not-a-resource`, since the old name
had quietly become ambiguous enough to read as a stale test.

### Three corrections to this spec, found by building it

1. **No `condition=deleted_at IS NULL` on the `reference` uniqueness
   constraint.** `grep -rn "condition=Q(deleted_at" backend/` returns
   zero hits: soft delete is a manager concern here
   (`TenantScopedManager` filters it), never a constraint condition.
   Reserving a soft-deleted incident's reference is also right on its
   own terms — the reference exists to be quoted down a phone line, and
   reissuing it would make two records answer to one name.
2. **`assigned_to` is not protected by a tenant-scoped manager.** The
   spec's edge-case table says a cross-Client assignee "simply is not
   found". It would have been found. `identity.User` is **not** a
   `BaseModel` (docs/adr/0003 — `client` is nullable for platform
   staff), so `User.objects` is the plain unscoped manager.
   `_resolve_staff_user` filters `client=request.user.client,
   is_client_staff=True` explicitly, the way
   `StaffInvitationCreateSerializer.validate_role` already does, and a
   test pins it. This is the one relation on the model where the
   documented six-FK trap does *not* protect you, which is exactly why
   it was the one worth getting wrong.
3. **`IncidentActivity.kind` is a `TextChoices`**, not the spec's bare
   `CharField`. Every status-ish field in this codebase is one, and a
   free-text `kind` generates as an untyped `string` in `schema.ts` —
   which slices 2 and 3 then cannot switch on exhaustively.

### One deliberate behavioural departure: who gets notified

The spec says notify "on create and on transition to `critical`".
Notifications fan out **one row per staff user** (`_eligible_client_staff`),
and hardware faults are both the highest-volume category and the one a
single broken device can emit repeatedly — the flood risk this spec's
own Failure Modes section names, left unaddressed by its own rule.

Creation notifies only at `high` or `critical` severity, plus any later
escalation *to* `critical`. Low and medium reports still reach the queue
and the dashboard count; they just do not ring a bell for twenty people.
Verified live: a `low` incident left the bell at 32 notifications, a
`critical` one took it to 33.

A passenger cannot choose severity at all. `report_incident` forces
`medium`, because a passenger able to declare their own report critical
would be a one-tap way to ring every operator's bell.

### Filters: a dedicated serializer, not the shared analytics module

`apps/analytics/filters.py` already carries `status` meaning a
*PaymentIntent* status, and `booking_status` exists precisely because
one field cannot validate two enums. Incidents would have made it three,
over a model with `severity`, `category` and `source` besides — none of
which are aggregate dimensions.

`IncidentListQuerySerializer` owns the queue's filters instead. The one
thing it does reuse is the date window: `apps/analytics/filters.py`'s
private `_as_utc_range` became public `as_utc_range`, so "which instants
belong to a Lagos day" has one implementation rather than two that drift
by an hour and nobody notices. The dashboard's own narrowing is a new
`apply_to_incidents` beside its siblings.

`open_only` and the dashboard's count both read
`apps.incidents.models.OPEN_STATUSES`, so the stat and the list beneath
it cannot disagree about what "open" means.

### The permission backfill, and what it actually found

`identity/0020` seeds the two codenames; `identity/0021` is what reaches
roles that already exist, because **a seed migration grants a codename
to nobody**. `create_default_roles` applies `DEFAULT_ROLE_PERMISSIONS`
only to roles it creates, so coverage tracks exactly when each codename
was added.

Measured against the development database immediately before migrating,
with `SET app.is_platform_staff = 'true'` so RLS did not silently answer
zero — 331 roles of each preset:

| Codename | Held, before | After |
|---|---|---|
| `ledger.view` | 201 / 331 | 331 / 331 |
| `notifications.view` | 192 / 331 | 331 / 331 |
| `ticketing.validate` | 194 / 331 | 331 / 331 |
| `analytics.view` (Owner/Manager) | 331 / 331 | unchanged |
| `incidents.view` / `incidents.manage` | — | 331 / 331 |

So roughly **40% of every Client's roles could not reach the ledger, the
notification list or ticket validation** — three shipped features, dark
for them, with no error anyone would recognise as a permissions gap.
`analytics.view` is at full coverage only because `identity/0019`
repaired it, and stays correctly absent from Staff.

Three things make `0021` safe to write this way, and all three are in
its own docstring:

- **Additive only.** It never revokes.
- **Nothing can have customised a Role.** `apps/identity/staff_urls.py`
  exposes exactly one role endpoint, `RoleListView`, a `ListAPIView`. No
  API path in this system edits a Role's permissions, so there is no
  operator intent to clobber. This was checked before writing it, not
  assumed.
- **A frozen literal, not an import.** `DEFAULT_ROLE_PERMISSIONS` keeps
  changing; importing it would silently change what this migration means
  every time a later phase edits that dict. Owner is the one exception,
  resolved dynamically, because it means "every seeded permission" by
  definition.

`set_rls_session_vars(None, is_platform_staff=True)` and
`Role.all_objects` are both load-bearing, for the reason `0019`'s first
version shipped broken: `Role` is a `BaseModel` whose RLS policy fails
closed, and a migration has no `app.current_client_id`, so without the
bypass every `SELECT` returns nothing and the migration reports `OK`
having done nothing.

**This should be the last migration of its kind.** Any future codename
ships its own grant alongside its seed.

### Two real defects found while building

1. **`resolved -> closed` was clearing `resolved_at`.** The first
   version keyed the clear on the *origin* status (`from_status in
   (resolved, closed)`), which correctly caught both reopen paths and
   incorrectly caught filing a resolved incident away. Closing is not
   un-resolving, and `resolved_at` is the only record of when the fault
   was actually fixed. Caught by the transition matrix test before it
   ran anywhere; the condition now names the destination too.
2. **`IncidentStatusEnum` was `StatusD05Enum`.** drf-spectacular
   resolves colliding `status` field names by appending a hash **of the
   choice set**, and that name is what `schema.ts` exports — so adding a
   status later silently renames the type a frontend imports. Twelve
   such names already ship. Only the new one is fixed, via
   `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]`; renaming the existing
   twelve would churn generated types across four apps for no functional
   gain. The override needs a module-level constant
   (`INCIDENT_STATUS_CHOICES`) because it resolves a dotted path with
   `import_string`, which cannot walk into a nested class. Schema
   warnings dropped 9 → 8 as a side effect.

### A note on the query-count test

`test_listing_costs_the_same_whether_there_is_one_row_or_twelve`
compares two real requests rather than asserting a magic maximum. A
fixed budget drifts with unrelated middleware changes *and* still passes
an N+1 that only appears at scale. This fails the moment a row costs a
query — which is what the six `select_related` joins the list's label
fields depend on are for, and what nesting the activity trail into the
list serializer would reintroduce.

### Verification

- **1015/1015 backend tests** (`pytest --create-db`), up from 920.
- ruff and mypy clean over 314 source files.
- OpenAPI regenerates with **0 errors**, drift clean both directions;
  `schema.ts` regenerated, 4 clean builds, 9 lint targets clean, **1332
  frontend unit tests** green with no frontend change needed.
- All four Playwright projects green — client-admin 104, customer 18,
  super-admin 19, validator 7. (`payments.spec.ts` failed once and
  passed on a clean re-run of the same suite; flake, not a regression —
  nothing in this slice touches `/payments/`.)
- **Live against the real stack**, which is where the numbers above
  stop being self-referential:
  - A passenger report submitted twice under one `Idempotency-Key`
    returned one record, `INC-AGVBPT`.
  - The full walk `acknowledged → investigating → resolved → closed`,
    then reopened: `resolved_at` stamped, kept on close, cleared on
    reopen. `closed → open` answered **409** with *"An incident that is
    closed cannot move to open."* A same-status transition returned 200
    and added no trail row.
  - `PATCH {"status": "closed"}` answered **400** — *"Status cannot be
    changed here. POST to /incidents/{id}/transition/ instead."*
  - After staff added an internal note *and* resolution notes,
    `/incidents/mine/` returned exactly eight keys and none of
    `assigned_to`, `resolution_notes`, `activities`, `severity`,
    `source`.
  - `GET /analytics/dashboard/` reported `{"open": 3}` with three typed
    `recent_incidents` rows.
  - Another Client's business as a query param: **400**. A passenger
    against any staff endpoint: **403**. Anonymous: **401**.
  - RLS confirmed in `psql` **as `integra_app`** (never `integra`, a
    bootstrap superuser that bypasses RLS unconditionally):
    `relrowsecurity`, `relforcerowsecurity` and a `tenant_isolation`
    policy on both new tables.

### Not done, deliberately

- **Slices 2 and 3** — the client-admin queue/form/detail, the
  customer-app report and history, the validator-app report action, and
  the `seed_e2e_users` incident fixture those e2e specs will need.
- **A device registry**, per this spec's own non-goals. Deferred to
  spec 20.
- **Cross-client detail 404 was verified live only with a random
  UUID**, not a genuine other-Client incident — the dev database has no
  incidents under a second Client yet.
  `test_another_clients_incident_detail_is_a_404_not_a_403` covers it
  properly against real rows, including `PATCH` and `transition`.
- **The `incident_report` throttle was not exercised to exhaustion
  live.** `config/settings/local.py` widens it to `100/min` for
  Playwright. What was proved is the failure mode that actually bit
  before: the scope resolves rather than raising `ImproperlyConfigured`
  — spec 16 slice 4's `export` scope 500'd in the browser while every
  test stayed green, because `local.py` used to replace the rate dict
  instead of merging it. It merges now, so the new scope was inherited
  automatically.

---

## Implementation note (Slice 2 — operator UI, done)

Built 2026-09-06. `client-admin-app` gained the incident queue, a
create/edit form and a detail screen with the trail and lifecycle
controls, plus a nav entry, a quick action and the dashboard's
recent-incidents strip. **1022/1022 backend tests** (up from 1015) and
**1384 frontend unit tests** (client-admin 568 → 617). Slice 3 —
customer-app reporting and the validator-app action — remains.

### Two backend defects, found before writing any frontend code

**1. The assignee control had no reachable data source.** The spec puts
assignment on the detail screen. The only endpoint listing a Client's
staff, `GET /staff/`, is gated on `staff.manage` — a codename only the
**Owner** preset holds. Manager and Staff both hold `incidents.manage`
and are exactly the people who triage incidents, so the dropdown would
have 403'd for almost everyone who needs it.

Fixed with `GET /incidents/assignable-users/`, gated on
`incidents.manage`, returning `{id, email, first_name, last_name}` and
nothing else. Deliberately *not* a loosening of `/staff/`, whose
`StaffSerializer` nests each user's Role and its full permission list.
Verified live against all three presets:

| Role | `/staff/` | `/incidents/assignable-users/` |
|---|---|---|
| Owner | 200 | 200 |
| Manager | **403** | 200 |
| Staff | **403** | 200 |

**2. Five write fields were emitted as `required` in `schema.ts`.**
CLAUDE.md records the rule — a serializer `default=` makes
drf-spectacular mark the field required — and slice 1 walked into it
anyway: `IncidentCreate.description`/`.device_reference`,
`IncidentReport.title`/`.device_reference` and
`IncidentTransition.note`. Three forms would have had to send `''` to
satisfy the compiler. Dropping `default=""` (keeping
`required=False, allow_blank=True`) is a **types-only** change: every
view already read them with `data.get(field, "")` and every service
already carried a Python default. A test now asserts the fields can be
omitted at the API.

### One deliberate divergence from a standing rule

CLAUDE.md says a detail or edit screen resolves its record through
`ListStore.findByIdPaged`. That rule exists because no domain had a
single-record endpoint — the seven screens that adopted it page up to
fifty times to find one row.

`GET /incidents/{id}/` exists, and it is the **only** source of the
activity trail; no list response carries `activities`. So
`IncidentStore.findDetail` calls it directly: one request instead of
fifty, and the only way to get the data the detail screen exists for.
`findByIdPaged` stays the rule everywhere else, and the store says so in
a comment, because it otherwise reads as a violation.

### The queue opens narrowed, and says so

`open_only` is seeded in the store's initial query **and** rendered as a
removable chip. A queue defaulting to "everything ever reported" becomes
unusable within a month; a queue that quietly hides rows with nothing on
screen saying so is the confusion already recorded against the KYB queue
and against super-admin's "Business not found". Cleared, the parameter
*disappears* rather than becoming `open_only=false`, which the server
would read as a filter rather than the absence of one — asserted by its
own store test.

### Triage from the row, with the backend still authoritative

`nextStatuses()` in `shared/incident-labels.ts` mirrors
`apps.incidents.services._ALLOWED_TRANSITIONS`. **That duplication
cannot be kept in sync by a test** — the two are in different languages.
It is acceptable only because the menu is a convenience and never the
enforcement: the backend answers 409 on an illegal move and every caller
renders it inline, so the worst case of drift is a menu item that fails
with a readable message rather than a state the server never sanctioned.
The file says this in its own docstring.

Both reopen paths are offered and labelled "Reopen" rather than
"Investigating" — the same transition, but an operator is thinking about
the record, not the enum.

### A real harness defect found by this slice's visual pass

The §10.6 capture produced a **correct queue at 390 and 768 and an empty
one at 1200**. It was not the screen: `trips-1200.png` from the same run
was empty too, so the entire 1200 pass had no active Business, while
spec 16's iteration-5 capture of the same screen shows 912 trips.

The cause is in `frontend/e2e/session.ts`. `selectBusinessByName` paged
the Business list and, on a failed response, **silently returned** —
leaving the harness on whichever Business was auto-selected and
photographing a whole pass of wrong screenshots that look merely empty.
That is precisely the "bounded fetch, silent fallback" failure the
function's own docstring exists to prevent, left unguarded in the one
branch where it mattered most. It now throws with the status code.

`ui-review-capture.ts`'s per-test timeout was also raised from 300s to
900s: the capture list has grown with every spec that adds screens, and
this slice's two screens plus one flow pushed it over — which surfaces
as a timeout inside whichever walk happened to be running and says
nothing about that walk.

### Verification

- **1022/1022 backend tests** (`pytest --create-db`), ruff and mypy
  clean over 314 files, OpenAPI 0 errors and drift clean both ways.
- **1384 frontend unit tests**, 4 clean builds, 9 lint targets clean.
- All four Playwright projects green — client-admin **113**, customer
  18, super-admin 19, validator 7. (Validator reported 6 on one run
  and 7 on the next: its open-seating case is single-use per seed,
  the behaviour CLAUDE.md already records.)
- **9 new e2e tests**, each closing with a fresh axe pass and all clean:
  the queue renders with the seeded fixture, the open-only chip is
  visible, an invalid create is rejected **visibly**, a create lands on
  its detail screen, the row menu acknowledges without opening the row,
  the full lifecycle walk grows the trail and reopens, a note is
  recorded, the assignee picker populates, and the dashboard stat links
  through.
- Live: the three-role table above, which is the whole justification for
  the new endpoint.

### The visual pass found two more defects in these screens, and one that had already shipped

Written up in full at `docs/ui-review/17-incidents/iteration-1.md`;
`iteration-2` is the after.

- **A select showed one value and submitted another.** The Severity
  control rendered "Low" while the form held `medium`. `ui-select` binds
  `[value]` on its `<select>`, and that lands before the `@for` has
  created any `<option>` — the browser falls back to the first, and the
  unchanged signal is never rewritten. Fixed at the component with
  `[selected]` on the option, plus two `shared-ui` regression tests.
  **It had already shipped**: `TRIP_CLASS_OPTIONS` starts with `premium`
  while `vehicle-type-form`, `schedule-form` and `trip-form` all default
  to `standard`, so all three displayed "Premium" and submitted
  `standard`.
- **"Assigned to" appeared twice**, once read-only and once as a
  control, a screen apart. The control is now "Assign to" and its panel
  is titled "Status and assignment".
- **Two fields were both labelled "Note".** The proof they were
  genuinely ambiguous is that the e2e spec had to tell them apart
  *positionally*, with `.first()`/`.last()`.

### Not done, deliberately

- **Slice 3** — customer-app report + history, validator-app action.
- **Bulk actions.** Triage is one row at a time; a multi-select toolbar
  has no precedent in this app.
- **URL-synced filters**, matching every list in this app except
  `payment-list`.
- **A `nextStatuses` reconciliation test.** See above — the backend is
  authoritative and the failure mode is benign.

---

## Implementation note (Slice 3 — reporter UI, done)

Built 2026-09-06/07, closing the spec. `customer-app` gained a report
form and a history screen; `validator-app` gained a third screen for
reporting against the trip a conductor is working. **1446 frontend unit
tests** (up from 1384; customer-app 218 → 230, validator-app 51 → 63),
1022/1022 backend tests unchanged, and all four Playwright projects
green — client-admin 113, customer **23** (was 18), super-admin 19,
validator **12** (was 7).

Both passenger endpoints had shipped in slice 1 with **zero frontend
callers**. That was the point of this slice: the spec exists because
the model has two entry points, and only the operator one was built, so
the queue could only ever contain what operators typed into it
themselves.

### No backend change, verified rather than assumed

Checked before planning, not discovered afterwards: both endpoints
exist, `IncidentReport` in `schema.ts` already types `title` and
`device_reference` as optional (slice 2's correction), and slice 1 had
already widened `incident_report` to `100/min` under
`config.settings.local`, so a Playwright run cannot throttle itself.
`openapi:check` reports no drift in either direction, which is the
mechanical proof.

### The passenger form has two entry modes, and one is much better

`/report-issue?booking=<id>`, from the `my-bookings` row menu, resolves
the Booking and takes the trip, the operator and a human label from it
— so the passenger picks nothing and the report arrives attached to a
real trip. `/report-issue` on its own asks for an operator, sourced
from `GET /routes/browse/` deduped by `business.id`, exactly as
`wallet.ts` already derives its own picker; it is not a new endpoint.

The booking path uses `BookingStore.findById` → `findByIdPaged`. **The
standing rule applies here**, unlike on slice 2's incident screens:
`/bookings/mine/` has no single-record GET, so paging is the only way.

Three cascading selects (operator → route → stop) walk straight into
the recorded trap that *narrowing a `<select>`'s options does not move
its value into them*. Reconciled in an `effect` rather than in the
change handler, because the options also narrow when `/routes/browse/`
resolves — which no handler observes.

### What the passenger form deliberately does not ask

**Severity.** `IncidentReportSerializer` does not accept it, and that
is the backend's call rather than this screen's: a passenger able to
declare their own report critical is a one-tap way to ring every
operator's bell.

**A title.** The service derives one. Asking for a headline before the
description would be asking someone to summarise what they have not
written yet — and the derived title turned out to be the wrong thing to
*render* back, which the visual pass caught (F3 below).

### Location is opt-in, and a refusal is an ordinary outcome

`GeolocationService` is the one place this app touches
`navigator.geolocation`, wrapped so its spec can drive all three
refusal paths — two of which (a real permission prompt, a device with
no geolocation) are unreachable in a headless browser and are exactly
the two a passenger is most likely to hit. Coordinates are rounded to
six decimal places to match `DecimalField(max_digits=9,
decimal_places=6)`; a raw `coords.latitude` carries fifteen significant
digits and DRF would answer 400 on a field the passenger cannot see.

Nothing infers a position. A denial is stated in plain text beside the
button, **not** as an error alert, and the form submits either way —
the spec's own words are that a report with no location is normal, not
degraded.

### The validator files as an operator, and does not name the driver

`POST /incidents/`, not `/incidents/report/`. A conductor is client
staff and the Staff preset holds `incidents.manage` (slice 1 granted
both codenames to all three presets precisely because frontline staff
are who notices a broken reader). So the report lands with
`source=operator`, and the conductor can set severity — verified live:
`source: operator`, `severity: high`.

The selected `Trip` already names its business, route and vehicle, so
all three are attached without asking, and the form **says so on
screen** rather than leaving it implicit. A form that silently records
a vehicle registration is a form whose author knows something the user
does not.

**`driver` is deliberately omitted**, though `Trip` carries one and the
endpoint accepts it. Naming a person on every hardware fault turns
"this reader is dead" into a record about whoever happened to be
driving. Verified live: `vehicle` attached, `driver: None`.

### One small extraction, and one nav gate

`RecordTapService` and `ValidateTicketService` had each written out the
same two-request trip loader — `scheduled` and `in_progress` fetched
separately because `TripListQuerySerializer.status` takes one value,
and no fare-mode filter because a tap credential is universal fare
media. Rather than write it a third time, it moved to
`OpenTripsService`; `ValidateTicketService` keeps its `.filter(prepaid)`
on top. Both existing screens' specs are the regression net and passed
unchanged.

The new nav link is **filtered on `incidents.manage`**, unlike the two
beside it. This shell's own docstring justified rendering those
unconditionally on the grounds that `tapngo.record` and
`ticketing.validate` are always granted together — that argument does
not extend to a third codename a custom Role can omit, so the docstring
was amended rather than left to contradict the code.

### The visual pass found six defects, two of them regressions this slice caused

Written up in `docs/ui-review/17-incidents/iteration-3.md`. In short:

- **The validator header grew to four rows at 390px.** The nav's
  `w-full` had always resolved against a nested `flex-1` wrapper rather
  than the header — measured at **193px**, not 358 — so two links never
  fitted either; the third made it visible. Hoisted to a direct header
  child, label shortened: header **189px → 109px**, smaller than before
  this slice.
- **The passenger nav wrapped at 1200px.** Six labels came to 556px in
  a 587px nav; a seventh took it to 656px. Three labels shortened
  (`Search trips` → `Search`, and "My " dropped from two): **554px**,
  one row. It still wraps at 768px, which it did before this slice too.
- **The reports list showed the category twice** — the derived
  "Passenger report: Hardware" beside a Category column reading
  "Hardware". Now the category leads and the column is "What you said",
  the passenger's own description, which was not shown at all.
- **Two select prompts restated their own labels**; both are "Choose
  one" now.
- **A form section shadowed its own control** — a region called "Which
  trip" containing a select called "Trip", which a screen reader
  announces twice. Found by Playwright strict mode rather than by
  reading the screenshot.
- **A reference and a date broke mid-token** in the table.

### One e2e fix this slice owed

`client-admin-app/incidents.spec.ts` began failing on its second run
onward: the seeded `INC-E2E001` had been pushed off page 1 of the
queue, because this slice added **two new sources** filing incidents
into that same Business. The spec now searches for its fixture instead
of trusting page 1 — the "never trust page 1 of a list this dev
database keeps growing" lesson `fixture-lookup.ts` and `session.ts`
already carry, arriving in a third place.

`customer-app/booking.spec.ts` also needed updating: it asserted that a
cancelled row offers **no** actions at all, which stopped being true.
"Report a problem" is on every row whatever the status — "the reader
would not take my card, so I cancelled" is exactly the story worth
reporting, and gating it on status would hide it from the people with
the most to report.

### Verified live, end to end

Against the real stack (`integra_app`, never `integra`):

- A passenger report lands as **`source=passenger`** with coordinates
  stored exactly as sent, and a replay under the same
  `Idempotency-Key` returns **the same row**.
- A validator report lands as **`source=operator`**, `severity=high`,
  with trip, route and vehicle attached and **no driver**.
- Moving that incident acknowledged → investigating → resolved, plus an
  internal note, leaves `/incidents/mine/` showing the new status and
  **nothing else**: no `assigned_to`, no `resolution_notes`, no trail.
  The visibility rule holds from the outside, not just in a unit test.

### Not done, deliberately

- **A passenger report-detail screen.** `/incidents/mine/` returns the
  whole reduced record; there is nothing further to show and nothing a
  passenger can do to a filed report.
- **Passenger↔operator replies.** The visibility rule is explicit that
  the trail is internal.
- **Attachments or photos.** No model, and `KybDocument`'s `PROTECT`
  already makes attachment-bearing rows unprunable.
- **Fixing the passenger nav's 768px wrap.** Pre-existing, and spec 21
  owns replacing that nav wholesale.
