# 19-Route-Lifecycle: Route depth, status lifecycle, archive and duplicate

Seventh spec of the Transit OS adoption arc. Small and self-contained.

## Scope and non-goals

`transit-admin-app-prompt.md` describes a route as carrying distance,
estimated duration, and a four-state status (`active`, `inactive`,
`draft`, `archived`), with actions to duplicate, archive, restore and
change status, plus a route detail view.

`network.Route` today has `name`, `code`, `description` and a bare
`is_active` boolean. There is no detail route in `client-admin-app` —
only `/routes/new` and `/routes/:id/edit`.

**Route delete is not in scope and never will be**: `Route` is
`PROTECT`-ed by `Schedule`, `Trip` and both fare rule models. Archive
is the mechanism, per the ruling taken for this arc.

### In scope

- `distance_km` and `estimated_duration_minutes` on `Route`.
- A four-state `status` replacing `is_active`, with guarded transitions.
- Duplicate-as-draft.
- A `/routes/:id` detail screen.

### Non-goals

- **No status lifecycle for `Stop`, `Vehicle`, `VehicleType` or
  `Driver`.** They keep their `is_active` booleans. Only `Route` is
  described this way in the brief, and converting five models to a
  four-state lifecycle nobody asked for is scope invention. The
  resulting inconsistency is real and is accepted knowingly.
- **Duplicate does not copy fares.** See the reasoning below.
- **No geographic route shape.** `distance_km` is an operator-entered
  number, not computed from stop coordinates, and there is no polyline
  or map geometry. Route drawing belongs with spec 20's mapping work,
  if at all.
- **No scheduled-arrival time.** `estimated_duration_minutes` is
  descriptive; it does not generate an arrival time on `Trip` and spec
  15's punctuality metric still measures departure only.
- No route versioning. Editing a route edits it; unlike fares, there is
  no historical snapshot requirement.

## Data model changes

### Additive fields

```python
distance_km = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
estimated_duration_minutes = models.PositiveIntegerField(null=True, blank=True)
```

Both nullable — every existing route has neither, and a route is
perfectly operable without them. `Decimal` for distance per the
standing money-and-measurement convention; minutes as an integer rather
than a `DurationField`, matching `Business.seat_hold_minutes`'s existing
precedent and keeping the OpenAPI schema simple.

### `status` replaces `is_active`

```python
class Status(models.TextChoices):
    DRAFT = "draft", "Draft"
    ACTIVE = "active", "Active"
    INACTIVE = "inactive", "Inactive"
    ARCHIVED = "archived", "Archived"

status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
```

Meaning, precisely:

| Status | Bookable | Schedulable | In operator lists | Editable |
|---|---|---|---|---|
| `draft` | no | no | yes (filtered) | yes |
| `active` | yes | yes | yes | yes |
| `inactive` | no | no — existing Trips continue | yes | yes |
| `archived` | no | no | only with `?status=archived` | no |

`default=DRAFT` applies to newly-created routes. **Every existing row
backfills to `active` or `inactive`** from its current `is_active`
value, so no live route is silently taken out of service by this
migration.

`inactive` and `archived` differ in intent, not just in listing:
`inactive` is "paused, will likely return"; `archived` is "done with,
keep for history". Only `archived` is hidden by default and locked
against editing.

### Transitions

Owned by `apps.network.services.set_route_status()`, the sole write
path for the field — not the serializer.

```
draft     → active | archived
active    → inactive | archived
inactive  → active | archived
archived  → inactive          (restore; never straight back to active)
```

**Restore goes to `inactive`, not `active`.** A route archived six
months ago may have stale stops, no current fares and no vehicles.
Bringing it back paused, requiring a deliberate second step to sell on
it, is the safe default.

### Guards

- **`draft → active` requires an effective fare.** Flat-mode Businesses
  need a currently-effective `FareRule`; per-segment Businesses need at
  least one currently-effective `FareSegmentRule`. Activating a route
  nobody can be quoted a price on produces a `FareNotConfigured` 404 at
  the moment a passenger tries to book — a failure discovered by the
  customer, not the operator.
- **`draft → active` requires at least two `RouteStop`s.** A route with
  fewer has no journey to sell.
- **`* → archived` is refused while future non-cancelled Trips exist**
  on the route. A `409` naming the count, and the operator either lets
  them run or cancels them. Archiving out from under a passenger
  holding a paid booking is the failure this prevents.
- Past trips never block archiving; that is what archiving is for.

### `is_active` is dropped — **this step is destructive**

Per the repo's standing rule, a destructive migration step requires
explicit approval before it is run. Dropping `network_route.is_active`
after the backfill is that step, and it is called out again under
Migration impact.

Read sites to update: `Route.is_active` is consulted by the browse and
trip-search endpoints and by `client-admin-app`'s route list and form.
Each becomes a `status` check. `GET /routes/browse/` and
`GET /trips/search/` — both passenger-facing — must filter to
`status=active` specifically, **not** "anything that is not archived",
or a draft route becomes bookable.

### Duplicate

`apps.network.services.duplicate_route()` copies the `Route` and its
ordered `RouteStop` rows. The copy is always `draft`, its name suffixed
`(copy)`, its `code` cleared (codes are meant to be unique in practice
and a duplicated code is a data-entry landmine).

**Fares are not copied.** They are versioned on a half-open timeline
with a GiST exclusion constraint; a copy would have to invent
`effective_from` values, and spec 12 already established that anything
touching fare amounts outside `apps.fares.services` silently destroys
the price snapshot historical `SeatReservation`s depend on. The
duplicate is a draft, and the `draft → active` guard above forces the
operator to price it before it can sell. That guard is what makes not
copying fares safe rather than merely convenient.

Schedules, Trips and vehicle assignments are likewise not copied.

`duplicate_route()` uses `Route.all_objects` for the stop copy when
called under `platform_staff_bypass()`, per the trap that has now bitten
this codebase twice — `set_route_stops` and
`replace_vehicle_type_seats` both shipped using `.objects` inside a
bypass block, where the Python tenancy contextvar is unset and the
manager silently matches zero rows.

## API surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| `GET` | `/routes/` | `network.view` | `?status=` filter; excludes `archived` unless asked |
| `GET` | `/routes/{id}/` | `network.view` | **New.** Detail, with stop count, schedule count, and current fare summary |
| `POST` | `/routes/{id}/status/` | `network.manage` | `{ status }` — the only way status moves |
| `POST` | `/routes/{id}/duplicate/` | `network.manage` | Returns the new draft route |
| `PATCH` | `/routes/{id}/` | `network.manage` | Gains `distance_km`, `estimated_duration_minutes`; **rejects** `status` |

`POST /routes/{id}/status/` mirrors the existing
`POST /trips/{id}/status/` shape exactly, including its cancellation-
reason-style payload discipline, so operators and code meet the same
pattern twice rather than two different ones.

No new permission codenames.

## Edge cases

| Case | Expected behaviour |
|---|---|
| Activating a draft with no fare | `409` naming the missing fare configuration |
| Activating a draft with one stop | `409` |
| Archiving with future scheduled Trips | `409` naming the count |
| Archiving with only past/cancelled Trips | Allowed |
| Archiving a route with live fare rules | Allowed — the rules stay, unreferenced. Closing them is `close_fare_segment_rule()`'s job and a separate decision |
| Editing an archived route | `400`; restore first |
| Restoring | Lands on `inactive`, never `active` |
| `PATCH` attempting `status` | `400` naming the status endpoint |
| Duplicating an archived route | Allowed — resurrecting an old route as a new draft is a real workflow |
| Duplicating a route with no stops | Allowed; the copy is a draft and cannot activate |
| Passenger browse/search | Sees `active` only. A draft, inactive or archived route is invisible, not merely unbookable |
| Existing Trips on a route moved to `inactive` | Continue to run and remain bookable — the Trip is already sold on its own terms. Only *new* scheduling is blocked |
| `distance_km` / duration left blank | Fine everywhere; displayed as `—` |

That "existing Trips continue" row is the one genuinely debatable
choice. The alternative — deactivating a route immediately withdraws
its future trips — would cancel bookings as a side effect of an
administrative edit. Explicitly rejected.

## Failure modes

- **The destructive column drop.** If the backfill and the drop are in
  one migration and the backfill is wrong, the original data is gone.
  They are therefore **separate migrations**, and the drop is a distinct,
  separately-approved step run only after the backfill is verified in
  the target environment.
- **A read site missed during the `is_active` → `status` sweep.** A
  missed passenger-facing site is the dangerous direction: it would
  either hide active routes or expose drafts. The sweep is verified by
  grep *and* by a test asserting that browse/search return `active`
  routes only, with a draft and an archived fixture present to prove
  the exclusion.
- **Tenancy contextvar inside `platform_staff_bypass()`.** Named above;
  this is the third place in this codebase where the same mistake is
  available, so `duplicate_route()` gets a regression test that calls it
  directly under a bypass with no `tenant_context` active — the shape
  the `replace_vehicle_type_seats` fix already established.
- **Archive as a soft delete.** `BaseModel` already has `deleted_at`.
  `archived` is a *product* state, visible and restorable in the UI;
  `deleted_at` remains an infrastructure concern. They are not merged,
  and archiving never sets `deleted_at`.

## Test plan

### Backend

- Migration: `is_active=True` → `active`, `False` → `inactive`, across a
  fixture of both; no route lands on `draft`.
- Full transition matrix, legal and illegal, including restore landing
  on `inactive`.
- Activation guards: no fare (both pricing modes), fewer than two stops,
  and the success path.
- Archive guard: blocked with a future scheduled Trip, allowed with only
  past or cancelled ones, message names the count.
- `PATCH` cannot move status; the status endpoint can.
- Duplicate: copies stops in order, forces `draft`, clears `code`,
  suffixes the name, copies no fares/schedules/trips.
- **`duplicate_route()` called directly under `platform_staff_bypass()`
  with no tenancy contextvar** copies the stops rather than silently
  copying none.
- Passenger-facing exclusion: browse and search return `active` only,
  asserted with `draft`, `inactive` and `archived` fixtures present.
- New `GET /routes/{id}/` detail shape; `404` cross-client.
- **Cross-client isolation** (mandatory set) on every new endpoint.
- Permission gating on the status and duplicate endpoints.

### Frontend

`client-admin-app`: `route-list` gains a status filter and status pill
(label, not colour alone) and archive/restore/duplicate actions behind
`ui-confirm-dialog`; `route-form` gains the two new fields;
`route-detail` is new — stops, schedules, current fare summary, status
actions.

`route-detail` resolves its record through `ListStore.findByIdPaged`
with an **explicitly passed** scope. This is the eighth detail screen in
this app and the rule exists because the previous seven each
re-derived a bounded-page lookup, one of which (`seat-map`) went
further wrong by reading shared root-store `items()` in a bare
`computed()`, so another screen paginating that store made this one's
record silently `null` mid-session.

Forms asserted on **rendered** validation output.

### E2E

Per-project, `client-admin-app`: create a route as draft, fail to
activate it without fares, price it, activate it, duplicate it, archive
it, restore it and confirm it lands `inactive`. Assert a draft route is
absent from `customer-app`'s route browse. Axe pass on the detail
screen.

## Migration impact

Four migrations, deliberately separate:

1. **Additive** — `distance_km`, `estimated_duration_minutes`, and
   `status` with `default="draft"`, all nullable/defaulted. Safe.
2. **Backfill** — `status` from `is_active` (`True → active`,
   `False → inactive`), run under the RLS-bypass `set_config` pattern
   the fares migrations already establish. Safe and reversible.
3. **Enforce** `NOT NULL` on `status`. Safe.
4. **Destructive** — `RemoveField(route, is_active)`.

**Step 4 is destructive and must not be run without explicit
approval**, per this repo's standing rule. Steps 1–3 leave the system
fully working with both columns present, so there is no pressure to run
step 4 in the same deployment as the rest. The code sweep from
`is_active` to `status` lands with step 1–3 and does not depend on
step 4 having run.

## Suggested implementation slicing

Two slices, stop for review between.

**Slice 1 — model and services.** Migrations 1–3, the transition
service with its guards, `duplicate_route()`, the new and changed
endpoints, the `is_active` read-site sweep, full tests. Migration 4 is
prepared but held for approval.

**Slice 2 — UI.** Route list filter and actions, form fields, and the
new detail screen.

## Implementation note — slice 1 (2026-09-07)

Backend only, as planned. `distance_km`, `estimated_duration_minutes`
and `status` (migrations 1–3: additive, backfill, enforce `NOT NULL`),
`set_route_status()` with its three guards, `duplicate_route()`, the new
`GET`/`POST .../status/`/`POST .../duplicate/` endpoints, and the
`is_active` → `status` read-site sweep. 1116/1116 backend tests
(+35 net: 32 new in `test_route_lifecycle.py`, 3 rewritten in
`test_network.py`/`test_route_browse.py`); ruff/mypy clean; OpenAPI and
`schema.ts` regenerated with no drift.

**Migration 4 (`RemoveField(route, is_active)`) is prepared and
committed but has not been run against any real database.** Per this
repo's standing rule on destructive migrations, that needs explicit
approval — ask before `manage.py migrate`ing it anywhere but a
throwaway test database (which applies it automatically on every
`--create-db` run; that's expected and not itself an approval).

Three findings, one of them outside this spec's own files:

- **The sweep's own worry — a missed passenger-facing site — didn't
  happen; a missed *dashboard* site did.**
  `apps.analytics.services.dashboard()` still read `routes.filter(
  is_active=True)`, 500ing `GET /analytics/dashboard/` the moment the
  field was gone. Not caught by grep (the spec's own verification
  method targets read sites, and this repo doesn't grep before removing
  a field) — caught by the full suite. Fixed by mapping the dashboard's
  existing two-bucket shape onto `status=active` / `status=inactive`
  rather than redesigning it to four buckets — that widening is spec
  16's call, not this one's, and no test asserts `active + inactive`
  sums to every route for a business. It no longer does, on purpose:
  a draft or archived route counts in neither bucket now, recorded in a
  comment at the call site rather than left to be rediscovered.
- **The `-> active` guard applies to the transition, not the state it
  is framed around in prose.** The spec text and edge-case table only
  narrate `draft -> active`; `set_route_status` checks any transition
  landing on `active`, so `inactive -> active` gets the same fare/stop
  check. Nothing in the test plan asked for this either way — it is the
  smaller, more defensible surface (one guard clause, not two), not a
  behavior the spec ruled out.
- **"Editing an archived route: 400; restore first" wasn't free.** The
  edge-case table states it plainly, but nothing upstream of writing the
  test enforced it — `RouteSerializer.validate()` needed an explicit
  check against `self.instance.status`, alongside the `status`-via-PATCH
  rejection the API surface table does call out by name. Both live in
  the same `validate()`, not split across two mechanisms.

Two new `ENUM_NAME_OVERRIDES` entries, the standing rule for any newly
colliding `status`-named enum: `RouteStatusEnum` (a hash collision:
`Route.status` joined the already-crowded `status` field-name group) and
`FarePricingModeEnum` (a naming split: `RouteFareSummarySerializer
.pricing_mode`, new in this slice, reuses `Business.FarePricingMode`
under a field name that had never been used for it before).

`RouteFactory`'s own default is `status=Route.Status.ACTIVE`, not the
model's `draft` — declared once in the factory with the reasoning
inline, because dozens of tests across `fares`/`seating`/`booking`/
`scheduling`/`payments`/`ticketing`/`analytics` build a Route via
`RouteFactory()` with no override and expect an ordinarily-usable one,
exactly what `is_active`'s own default (`True`) always gave them.

## Implementation note — slice 2 (2026-09-07)

`route-list` gains a status filter (`ListFilters` extras, the same
mechanism `trip-list` already uses for its own `?status=`) and a status
pill carrying its label as text; the old Active/Inactive toggle and its
confirm dialog are replaced by one row menu built from
`nextStatuses(route.status)`, each item labelled by `transitionLabel`
and confirmed through the same `ui-confirm-dialog` pattern the toggle
already used, plus a `Duplicate` action offered from every status
including `archived`. `route-form` gains the two depth fields
(`inputMode="decimal"`/`"numeric"` `ui-text-field`s, not `type="number"`
— that type isn't offered, for the reasons `seat-hold.ts`'s own control
already records) and disables itself entirely with a restore-first
alert when the loaded route is archived, since the backend's 400 for
that case only fires on submit and a filled-in form nobody can save is
a worse failure than not offering the fields at all. `route-detail` is
new: depth, ordered stops, schedule count, the fare summary, and the
same status actions as the list, reading `GET /routes/{id}/` directly
(a real single-record GET, so no `findByIdPaged`) and reusing the
identical confirm-dialog logic a third time.

`shared/route-labels.ts` is the one place `statusLabel`/`statusTone`/
`nextStatuses`/`transitionLabel` live, read by both screens — mirrors
`incident-labels.ts`'s shape and its own admission that mirroring
`ROUTE_TRANSITIONS` client-side is a duplicate no test can keep in sync,
acceptable only because the backend is authoritative and every 409/400
it answers is rendered inline rather than trusted away.

**`takesOutOfService(from, to)` exists because `to` alone is not
enough.** `archived -> inactive` (Restore) and `active -> inactive`
(Deactivate) target the same status, but only one of them takes the
route further from being sold — a menu icon or a dialog's danger tone
keyed on `to` alone would have painted a Restore button red. Computed
once, shared by the row menu, the confirm dialog and the detail
screen's own buttons, rather than re-derived three times with three
chances to get the one case wrong.

1539/1539 frontend unit tests (up from 1506: 16 net across `route.store`,
`route-list` and `route-form`, plus 17 new in `route-detail`), all nine
projects lint clean, `ng build` clean for all four apps.

**A real bug found only by live verification, not by any test.**
Running the golden path against the actual dev database —
`create → add stops → price → activate → duplicate → archive → restore`
— failed at the very first `POST /routes/` with
`IntegrityError: null value in column "is_active" violates not-null
constraint`. Migration 0006 made `status`/`distance_km`/
`estimated_duration_minutes` nullable-or-defaulted but left `is_active`
untouched, reasoning that it was "a separate, later, explicitly-approved
step" (migration 0009) with "no pressure to run in the same
deployment." That claim was false the moment application code stopped
writing the field: `Route.objects.create()` never sets `is_active` any
more, and the column was still `NOT NULL` from migration 0001. Every
`pytest` run stayed green throughout, because `--create-db` builds the
test database from *every* migration including 0009's drop — the column
enforcing the constraint never exists there to violate. Fixed by adding
`AlterField(is_active, null=True)` to migration 0006 itself, so a
database that has applied 0006–0008 but not yet 0009 can still insert a
Route with nobody setting the field. This is why `docs/self-check.md`
requires a real running stack, and it is the reason recorded here rather
than only in the migration file: an additive-then-later-drop migration
plan must relax the old column's constraints in the *additive* step, not
merely leave the column present — "present" and "insertable" are not
the same claim.
