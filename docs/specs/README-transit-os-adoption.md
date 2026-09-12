# Transit OS adoption — gap analysis and spec roadmap (specs 13–21)

Written 2026-08-30. This is the index for the arc of specs 13 through
21, and the record of the gap analysis and decisions behind them.

## Where this came from

Two documents were supplied as feature briefs:

- **`transit_os_architecture_updated.md`** — a Transit OS frontend
  architecture brief describing a two-app ABT platform (customer +
  admin).
- **`transit-admin-app-prompt.md`** — a client-admin operations-console
  feature brief.

"Greenfield app" in the second document refers to **this application**
under its original name. Both are briefs for this codebase, not for a
rebuild.

Both documents instruct the reader to build against mock data and to
simulate live updates with RxJS timers. **That instruction is dropped**
by explicit decision: every feature in this arc gets a real backend.
That is where most of the work in specs 16, 17 and 20 actually is.

Both documents are also lightly mangled by a bad find-replace
("keep **vehicleiness** logic out of components", "a **rovehiclet**
form", vehicle management listed twice). The intended rule — keep
business logic out of components — is already this repo's convention.

## Gap analysis

### Already built, and past what the briefs describe

Route / stop / vehicle-type / vehicle / driver / schedule / trip CRUD,
seat map, bookings list, fares plus the fare-matrix grid, payments
list, ledger overview, wallet lookup, staff and invitations, KYC/KYB,
white-label, pay-as-you-go journeys — all permission-gated in
`client-admin-app`'s routes.

Shared primitives the admin brief lists as deliverables all exist:
`ui-table`, `ui-paginator`, `ui-status-pill`, `ui-stat`,
`ui-empty-state`, `ui-confirm-dialog`, `ui-select`, `ui-text-field`,
`ui-toggle`, `ui-alert`, `ui-icon`, `ui-button`, plus `ListStore` /
`findByIdPaged`, the `NavShell` sidebar, `permissionGuard`,
`*appHasPermission` and a notification bell.

Two the brief treats as new and which already exist: **driver
reassignment** (an inline select per row in `trip-list.html`) and
**trip cancellation** (a status dialog with a required reason, same
file). Neither should be rebuilt.

### Partial

| Area | Gap | Spec |
|---|---|---|
| `Route` | No distance, duration, status lifecycle, detail view or duplicate | 19 |
| Trip statuses | Four exist; the brief names five. "In transit" and "live" are the same thing here — mapped, not added | 16 |
| `PaymentIntent` | No payment method/channel; Paystack returns it and it is discarded | 16 |
| Filters | Per-screen and ad-hoc; no reusable filter bar | 14 |
| `home` | Static links, not a dashboard | 16 |

### Missing entirely, backend included

Dashboard aggregates, revenue reporting, transactions metrics,
trip manifest, trip performance, incidents, CSV export, staff booking,
live vehicle tracking, charts. Also, on the passenger side: Senior
Mode, a reservation countdown, an activity feed and vehicle tracking.

### Five structural findings

1. **No auth middleware.** `Authorization` is attached by hand at **89
   call sites across 69 files**. `provideApiClient` accepts no
   middleware even though the `createApiClient` it wraps does. Spec 13.
2. **No live-update mechanism at all** — not one `setInterval` or
   `interval(` in the entire frontend. Spec 20.
3. **No design token layer.** All four `styles.css` files contain
   exactly `@import "tailwindcss";` — no `@theme`, no brand colour, no
   type scale, no elevation. `@shared-ui` components hard-code utility
   classes in variant bindings. There is nothing for the briefs'
   Tailwind Design Direction to attach to. Spec 14.
4. **White-labeling does not white-label anything.** `WhiteLabelConfig`
   stores `logo`, `primary_color` and `secondary_color`; the only code
   that reads them is the form that edits them. `GET /white-label/resolve/`
   **already returns all of them** and `WhiteLabelResolverService`
   discards everything but `client_id`. A live product defect on a
   platform whose premise is white-labeled tenants — and fixable with
   no backend change. Spec 14.
5. **Six list screens render record status as a write toggle inside a
   read table** (`route`, `stop`, `vehicle`, `vehicle-type`, `driver`,
   `schedule`) — one mis-tap from deactivating a vehicle, unlabelled
   beyond its colour, no confirmation. Against both the briefs' "badge
   systems for statuses" and this repo's own "colour is not the only
   status indicator" bar. Spec 14.

### The visual gap, stated plainly

The other specs in this arc adopted the briefs' UX Requirements and
Tailwind Design Direction as binding, but each applied them only to the
screens it adds. That would have left ~20 new screens built in the
language being replaced, and the ~58 existing screens untouched.
"Don't regenerate what's already built" was right about functionality
and wrong about presentation.
**Spec 14 owns the visual half for the whole workspace**,
and is sequenced second so the later specs build into a finished
language rather than adding to the old one.

## Decisions taken before speccing

**Rulings:**

- Fares stay as built — the versioned `FareRule` / `FareSegmentRule`
  timeline. No route-level base fare, no route-level class multipliers.
  Class pricing arrives as a dimension on the existing rules (spec 15).
- Vehicles stay assigned to Trips, not Routes. No route-vehicle
  assignment screen.
- Routes are never deleted (`PROTECT`-ed by Schedule, Trip and both
  fare models). **Archive** instead (spec 19).
- Wallet balance stays derived from the ledger. Doc 1's
  `Wallet { balance }` column is not adopted — it is what ADR-0006
  rejected.

**Answers to the open questions:**

1. **Telemetry** — a device or driver app will report position
   eventually; until then data is seeded and simulated, through the
   real model and the real ingest endpoint, never faked in components.
   Every row records whether it came from a device or a simulator, and
   the UI says so (spec 20).
2. **Trip classes — in.** Premium / Exclusive / Standard / Mini
   (spec 15).
3. **Charting — a library.** Chart.js via `ng2-charts`, behind one
   `ui-chart` component (spec 16).
4. **Session expiry — fixed.** `ACCESS_TOKEN_LIFETIME` 15 → 60 minutes
   and a real refresh implementation (spec 13).
5. **UI rebuild — full, all four apps** (spec 14), not a re-skin: token
   layer, component library, and every one of the 58 screens
   restructured to the briefs' patterns.
6. **Visual identity — defined in the spec**, proposed as a document
   for review before it exists as code, with tenant white-label colours
   overriding the default at runtime.

## Binding brief sections

These sections of `transit-admin-app-prompt.md` are binding on every
spec in the arc: Technical Stack, Non-Negotiable Architecture Rules,
App Responsibilities, State Management, UX Requirements, Tailwind
Design Direction, Functional Expectations, Code Quality Constraints.

Most already match this repo (standalone components, `OnPush`, typed
models, fat services / thin views, feature-first folders, readonly
signal exposure, no raw state mutation in components, accessibility).
The genuinely new adoptions, each landing in the first spec with a real
consumer rather than as a primitives-only slice:

- A design token layer and a visual identity, applied across all four
  apps, with tenant white-label theming wired (spec 14).
- ~~`ngx-toastr` for transient action feedback.~~ **Not adopted.**
  Slice 4 was the first spec with a real consumer and the decision went
  the other way: feedback is inline, through `ui-alert variant="success"`.
  The rule that a toasted failure must *also* render inline meant the
  inline path had to exist regardless, and a toast disappears — it may
  never reach a screen-reader user at all. `ui-alert` keeps page-owned
  state: validation, confirmations, empty results, warnings.
- Top-bar quick actions, detail drawers, action menus, sticky table
  headers, table density.
- New `@shared-ui` primitives: `ui-page-header`, `ui-filter-bar`,
  `ui-action-menu`, `ui-drawer`, `ui-skeleton`, `ui-tabs`,
  `ui-form-section`, `ui-toolbar`, `ui-density-toggle`,
  `ui-export-button` (all spec 14), plus `ui-chart` (16), `ui-map` (20)
  and `ui-countdown` (21), each owned by the spec that consumes it and
  built to spec 14's tokens and conventions.

The briefs' named stores (`AdminDashboardStore`, `RevenueReportsStore`,
`TransactionsStore`, `IncidentsStore`, `LiveTripsStore`,
`TripPerformanceStore`, `ExportStore`) are adopted by name and
contract, implemented as `ListStore` subclasses where paginated rather
than as a parallel facade layer. The briefs' "repositories" are
`@api-client`. The brief's README deliverable maps to
`docs/architecture.md`.

## The specs

**Numeric order is build order.** Work through them in sequence.

| Spec | Title | Depends on | Slices |
|---|---|---|---|
| [13](13-session-resilience.md) | Session resilience — token lifetime, silent refresh, centralised auth | — | 2 — **done** |
| [14](14-design-system-and-ui-rebuild.md) | Visual identity, token layer, and UI rebuild | — | 6 (3 split into 3a/3b, plus an unplanned responsive-tables slice) — **complete — all six slices** (identity/tokens/theming; the ten primitives plus `ui-textarea`/`ui-radio-group`/`ui-checkbox`; client-admin's shell, **all** its lists and **all** its forms and console screens; every table in all three apps fitting 390px; **all of `customer-app`**, including its login, the booking-flow step indicator, and the first consumer of the tenant `logo`/`name`; **`@layout`** — `NavShell`/`NotificationBell`/`ForbiddenPage`, which no slice had owned and which are the chrome on every console screen — and **all eight `super-admin-app` console screens**). Slice 6 was split on survey into 6a and 6b, and **6b is done — this spec is complete**: `validator-app` (3 screens, flipped to `data-surface="consumer"` as this spec's own text requires, its board/alight switch now a real segmented radio group), the **six** auth screens (the roadmap previously said three — it counted logins and missed `register` and the two invite-accepts), and client-admin's `staff-invite`/`file-upload-field`. **No `slate-*` colour literals remain anywhere in the workspace** |
| [15](15-trip-classes.md) | Trip classes across fleet, scheduling and fares | — | 3 — **slice 1 (model, fares, service rules) done**: the `TripClass` enumeration on `Business`, five columns, both GiST exclusion constraints rebuilt with `trip_class` in the key, class-aware `get_fare()` precedence (exact class beats the `""` wildcard), the class-scoped fare matrix behind a **required** `?trip_class=`, and the three service rules — route allow-list, immutability once sold, vehicle-class match. Two departures from the spec, both recorded in its own implementation note: class edits got their own `POST /trips/{id}/class/` rather than riding the clear-on-omit assignment PATCH, and the migration is a single `AddField` per column rather than add-nullable/backfill/enforce. **Slice 2 (operator UI) is also done**: a class control on the vehicle-type, schedule, trip and fare forms (the schedule and trip ones narrowed to the chosen route's allow-list), the allow-list itself as a checkbox group on `route-form`, a class column on four lists plus a `?trip_class=` filter and a `POST /trips/{id}/class/` row action on `trip-list`, and the class-scoped fare grid — whose inherited cells show the Any-class price as a muted italic **placeholder**, so it is visible, replaceable by typing, and never submitted. One backend edit, type-only: `RouteSerializer.available_trip_classes` declared explicitly, since an inferred `JSONField` generated as `unknown`. **Slice 3 (passenger UI) is also done — this spec is complete**: the class on every trip-search result card, a `?trip_class=` filter narrowed to the chosen route's allow-list (cleared on route change rather than reconciled — a route change is the only thing that narrows it, unlike slice 2's forms), and the class carried through seat-picker and booking-confirm into `my-bookings` and the ticket view. Two additive read-only backend fields, agreed before building: `trip_class` on `BookingTripSerializer` and on `TicketSerializer` — neither screen had any other source, since there is no `GET /bookings/{id}/` and the ticket screen is deep-linkable by design. The e2e fixture gained a Premium half on the *same* route as the Standard one, priced 1250 against the wildcard's 750, so "the quoted fare is the class's, not the wildcard's" is a real assertion |
| [16](16-operational-analytics.md) | Dashboard, revenue, transactions, performance, export | 14, 15 | 4 — **slice 1 (enabling fields) done**: `PaymentIntent.channel` captured from the `charge.success` webhook body (free text, not `choices` — it is a value Paystack controls), `Trip.actual_departure_at`/`actual_arrival_at` stamped by `transition_trip_status`, eight composite indexes matched to the spec's documented filter set, and the `analytics.view` codename seeded and granted to Owner/Manager but **not** Staff. All three columns are exposed read-only on the existing `PaymentIntentSerializer`/`TripSerializer`, so the slice is verifiable over real HTTP rather than only in psql. Shipped separately because **neither field can be backfilled** — every day it is not deployed is a day of analytics data that does not exist later. 811/811 backend tests. **Slice 2 (aggregation endpoints) is also done**: a new `apps/analytics` with no models (the `apps/wallet` shape), one shared filter module that `GET /payments/` now uses too — so the metrics strip and the table beneath it cannot describe different rows — and four read-only endpoints (`/analytics/dashboard/`, `/analytics/revenue/`, `/analytics/payments/summary/`, `/analytics/trips/{id}/performance/`). Money is reported net *and* gross, grouped by currency and never summed across it; gross is derived from each entry's debit side rather than by reading the platform commission account, which ordinary Business staff cannot see. Two real defects found: the channel breakdown excluded wallet top-ups while the total beside it included them (caught by asserting the invariant that the slices sum to the total, not by checking example values), and `analytics.view` had reached **4 of 307** Owner roles because a seed migration only affects roles created after it — fixed by `identity/0019`, whose own first version silently did nothing because `Role`'s RLS policy fails closed inside a migration. 860/860 backend tests. **Slice 3 (`ui-chart` + dashboard) is also done**: `ui-chart` renders **SVG with no charting dependency** — `chart.js` was named by the spec, but a canvas `fillStyle` cannot hold `var(--color-brand-600)` and would need re-resolving whenever `BrandThemeService` changes a tenant's ramp, while the drawing itself is decorative given the accessible data table every chart already has to render. `client-admin-app`'s `home` is replaced by a real dashboard at the same path, gated on `client-admin:access` rather than `analytics.view` (it is where Staff lands after signing in, and the component asks for the codename itself). Three more real bugs found by building it: every money field on all four analytics endpoints shipped as a **JSON float** while the generated `schema.ts` said `string`, so `formatMoney` rendered `NGN 2850` for `2850.0`; every 400 these endpoints answer is **field-keyed**, not `{"detail": …}`, so the store's first error extractor flattened a message naming the exact fix into "failed to load"; and two overlapping requests could leave a *successful* older dashboard on screen under newer filters, fixed with a monotonic request id. 861/861 backend tests, 1272 frontend unit tests, three visual iterations. **Slice 4 (revenue, transactions, performance, export) is also done — this closes spec 16.** Three `client-admin-app` screens plus `GET /exports/{resource}/`, seven resources, the first non-JSON response this backend returns and the first file download this frontend performs. It is **not** a `StreamingHttpResponse`, deliberately: `TenancyMiddleware` commits its transaction and resets the tenancy contextvars the moment the view returns, so a lazily-iterated body would run every query with no tenancy context and hand the operator a silently empty CSV reporting `200 OK` — the rows are materialised inside the view, and three of the four guards against reintroducing laziness fail at build time. `GET /bookings/` migrated onto the shared filter module (with a separate `booking_status` dimension, since one field validated against two enums cannot validate either) so "export current view" is true rather than aspirational. Four real bugs found, three of them already shipped: **`GET /payments/` had been silently truncated to 30 days since slice 2** — a support screen that could not find a two-month-old payment, fixed by separating record lists (bounded by pagination) from aggregates (always bounded); every export **500'd in local development while every test passed**, because `local.py` replaced `DEFAULT_THROTTLE_RATES` instead of merging it; and two analytics tests passed every morning and failed every evening, one of them slice 2's. 920/920 backend tests, 1313 frontend unit tests, all four e2e projects green, two more visual iterations. |
| [17](17-incidents.md) | Operational incidents and passenger issue reporting | 14 | **Done** — all three slices: `apps/incidents` (`Incident`/`IncidentActivity`, RLS on both), the lifecycle enforced in one service function with an explicit transition table, all eight endpoints, and both codenames granted to **all three** presets including Staff — frontline staff are exactly who notices a broken reader. Three corrections to the spec, each documented rather than silent: no `deleted_at` condition on the reference constraint (no such conditioned constraint exists anywhere in this codebase), `assigned_to` filtered on `client` **explicitly** because `identity.User` is not a `BaseModel` and the spec's "the tenant-scoped manager handles it" is simply false for it, and `IncidentActivity.kind` as a `TextChoices` so the generated type is switchable. One behavioural departure: notifications fire on `high`/`critical` creates and escalation to `critical`, not on every create — fan-out is one row *per staff user* and hardware faults are the highest-volume category, the flood risk the spec's own Failure Modes section names but does not address. The three analytics slots this spec had been leaving at zero were filled here rather than in slice 2, since they are backend changes. **The permission backfill (`identity/0021`) found roughly 40% of every Client's roles unable to reach three shipped features** — `ledger.view` at 201/331 roles, `notifications.view` 192/331, `ticketing.validate` 194/331, all now 331/331; safe to write additively only because no API path in this system edits a Role's permissions, which was checked rather than assumed. Two real defects found: `resolved -> closed` was clearing `resolved_at` (closing is not un-resolving, and it is the only record of when the fault was fixed), and the generated enum was a **hash of its own choice set**, so adding a status later would silently rename the type `schema.ts` exports. 1015/1015 backend tests. **Slice 2 (operator UI) is also done**: the queue, a create/edit form and a detail screen with the activity trail and lifecycle controls, plus a nav entry, a quick action and the dashboard's recent-incidents strip. Two backend defects found *before* writing any frontend code: the assignee control had **no reachable data source** — `GET /staff/` is gated on `staff.manage`, an Owner-only codename, so the dropdown would have 403'd for every Manager and Staff user, which is exactly who triages incidents (fixed with a narrow `GET /incidents/assignable-users/`, verified live across all three presets); and five write fields shipped as **required** in the generated `schema.ts` because slice 1 used `required=False` *with* `default=""`, the precise trap CLAUDE.md already records. One deliberate divergence from a standing rule: this is the first domain with a real single-record endpoint, and it is the only source of the activity trail, so the detail and edit screens call it directly rather than using `findByIdPaged` — one request instead of up to fifty. The queue opens narrowed to open incidents **and renders that as a removable chip**, and clearing it drops the parameter rather than sending `open_only=false`. A real defect in the shared visual harness was also found and fixed: `selectBusinessByName` **silently returned** on a failed response, leaving a whole capture pass photographing the wrong Business as merely-empty screens — the same silent-fallback failure its own docstring exists to prevent. 1022/1022 backend tests, 1384 frontend unit tests, 9 new axe-clean e2e tests. **Slice 3 (reporter UI) closes the spec**: `customer-app` report form and history, `validator-app` report screen. Needed **no backend change**, verified before planning rather than discovered after — both passenger endpoints had shipped in slice 1 with zero frontend callers, which is the whole reason the queue could only ever contain what operators typed into it themselves. The passenger form has two entry modes: from a booking (trip, operator and a human label all taken off it, nothing to pick) or standalone (operator from `/routes/browse/`, the picker `wallet.ts` already derives). Location is opt-in through an injectable wrapper, rounded to the six decimal places the column holds, and a refusal is stated in plain text rather than raised as an error — the spec's own position that a report with no location is normal, not degraded. Severity is asked of the conductor and **not** of the passenger, because the serializer does not accept it: a passenger able to declare their own report critical is a one-tap way to ring every operator's bell. The validator files through `POST /incidents/` as an operator and **never attaches the driver** — naming a person on every hardware fault turns "this reader is dead" into a record about whoever happened to be driving. The visual pass found six defects including **two layout regressions this slice caused**, both measured rather than guessed: the validator header grew to four rows at 390px (its nav's `w-full` had always resolved against a nested `flex-1` wrapper — 193px, not 358 — so two links never fitted either), and the passenger nav wrapped at 1200px on the seventh link. It also found the reports list rendering the backend's derived title "Passenger report: Hardware" beside a Category column reading "Hardware", now replaced by the passenger's own words. 1446 frontend unit tests, all four Playwright projects green (113 / 23 / 19 / 12) |
| [18](18-manifest-and-staff-booking.md) | Trip manifest and counter booking | 14, 15 | 2 — **slice 1 (manifest) done**: `GET /trips/{id}/manifest/`, a `manifest` CSV export, and the `client-admin-app` screen. This spec was written against a data model that did not exist, and three of its statements were wrong — checked before planning rather than discovered during it. **`Booking.reference` and `Ticket.reference` did not exist at all**: both models were identified by UUID alone and no screen in any of the four apps showed an identifier for either, so a passenger had nothing to quote and a manifest had nothing to print. `Booking.reference` was added (Crockford base32, unique per Business, two migrations so the backfill precedes the constraint — 584 rows backfilled live, zero duplicates); `Ticket` deliberately keeps the signed QR as its only identity. There is **no trip detail screen** to hang the manifest off, so it is a row link gated on `booking.view` rather than an action-menu item — that menu is wrapped in `scheduling.manage` in its entirety and would have hidden it from exactly the Staff who read a list at the bus door, the same defect spec 17 slice 2 caught with `GET /staff/`. And the spec's non-goal that the existing CSV export covers this is **false for pay-as-you-go**: such a trip has no `Booking` rows, so a bookings export of one is a blank file. `kind` therefore branches the query, not just the label. The endpoint's own test caught the recorded `Decimal` trap — a plain-dict response renders a float while `schema.ts` promises a string — before any consumer saw it, and `results` is a discriminated union rather than the untyped bag `ListField(child=DictField())` generated. Adding the export gave `ExportSpec` a declarative `required_filters`, so the registry-driven export tests supply what a resource needs instead of excluding it and silently losing its coverage. 1052/1052 backend tests, 1470 frontend unit tests, client-admin e2e 113 → 118. **Slice 2 (staff booking) done**: `booking.manage` (Owner and Manager only, granted to 758/758 existing roles), `GET /passengers/lookup/`, `POST /bookings/staff/` with its wallet option, and the counter-booking screen. The spec named a `?phone=` lookup for a field `identity.User` does not have — email only, recorded rather than papered over. The lookup accepts `wallet.view` as well as `booking.manage`, because it is the capability `client-admin-app`'s wallet-lookup screen has documented as missing since spec 5, and Staff hold the former and deliberately not the latter. Slice 2 also exposed a **slice 1 defect**: the manifest was built over `Ticket`, and a ticket is issued at payment, so an unpaid booking had no row — which the module's own "`pending_payment` is deliberately not excluded" rule claimed otherwise. Invisible until now, and ordinary from slice 2 on: with no cash account in the ledger, an unpaid counter booking is the normal outcome of selling at a desk. `prepaid_rows` now merges tickets with held-but-unticketed bookings. 1081/1081 backend tests, 1506 frontend unit tests, client-admin e2e 118 → 121 |
| [19](19-route-lifecycle.md) | Route depth, status lifecycle, archive, duplicate | 14 | 2 — **complete, both slices.** Slice 1 (model and services): `distance_km`/`estimated_duration_minutes`, the `draft`/`active`/`inactive`/`archived` status replacing `is_active`, `set_route_status()`'s three guards, `duplicate_route()`, and the three new endpoints (`GET`/`POST .../status/`/`POST .../duplicate/`). Migration 4 (dropping the old column) is committed but not run anywhere but a test database, pending explicit approval per the standing rule. Two real bugs found only by running against a live database, neither caught by any test: a dashboard read site the spec's own sweep didn't name (`apps.analytics.services.dashboard()`) 500'd until fixed, and — more seriously — the additive migration left `is_active` `NOT NULL` while application code stopped writing it, so every new Route insert failed `IntegrityError` on any database that had the new migrations but not the drop; invisible in `pytest` because `--create-db` always includes the drop. 1116/1116 backend tests. **Slice 2 (UI)**: a status filter and row-menu actions (activate/deactivate/archive/restore/duplicate, each confirmed) replacing the old Active/Inactive toggle on `route-list`, the two depth fields on `route-form` (which also disables itself with a restore-first message for an archived route), and a new `route-detail` screen reading the real single-record GET. `takesOutOfService(from, to)` exists because `archived -> inactive` (Restore) and `active -> inactive` (Deactivate) target the same status but only one takes the route out of service — computed once in `shared/route-labels.ts`, read by both screens. 1539 frontend unit tests. Full account in the spec's own two Implementation notes |
| [20](20-live-operations.md) | Vehicle telemetry, live monitoring, tracking, ETA | 14 | 4 — **slice 1 (telemetry backbone) done**: `apps/telemetry` (`TelemetryDevice`/`VehiclePosition`/`VehicleLiveState`, all RLS), device issue/revoke/reassign on `fleet.manage`, batch ingest with its `(device, recorded_at)` idempotency constraint and the live-state advance guard, `POST /internal/tasks/prune-telemetry/`, and `manage.py simulate_vehicle_positions` (through the same `record_positions()` the ingest endpoint calls). No UI, per the spec's own slicing. `POST /telemetry/positions/` is excluded from the generated schema, same reason `PaystackWebhookView` is. Two infrastructure traps hit and fixed: DRF silently downgrades `AuthenticationFailed` to 403 when `authentication_classes` is empty (fixed with a real `DeviceTokenAuthentication`, which also gave the per-device rate throttle a proper key), and `settings.SETTINGS_MODULE` reads `None` under any active settings override — including this repo's own autouse test fixture — so the production-guard check reads `os.environ["DJANGO_SETTINGS_MODULE"]` instead. `openapi.yaml` had gone stale since spec 19; regenerating it here carries a large but confirmed-cosmetic catch-up diff, not telemetry drift. 1142/1142 backend tests. **Slice 2 (live read API) done**: `GET /trips/live/` and `GET /trips/{id}/live/` in a new `apps/telemetry/live.py`, registered under `apps.telemetry.urls` even though the paths are `trips/...` (the app that owns the data owns the endpoint, matching `apps.booking`'s own `trips/{id}/manifest/` precedent). Both gated on `scheduling.view`; the detail endpoint also accepts a ticket- or fare-journey-holding passenger. `ETag` short-circuits a quiet poll before any per-trip envelope is built; `?since=` then narrows a real response to the trips that moved. Two data-model gaps labelled `ASSUMPTION:` rather than guessed silently: progress is "constrained to move forward only" via a 24-hour cache of the furthest stop index reached (no stop-index column exists to persist it in), and ETA is a uniform per-segment split of `Route.estimated_duration_minutes` offset by observed delay (no per-stop schedule exists at all). A dedicated test caught what inspection alone would have missed: a vehicle reused for a later trip must not leak that trip's live position onto an earlier, completed one. Reused rather than duplicated: `apps.booking.manifest.trip_summary()`/`apps.analytics.services.seats_sold_and_total()`; deliberately not reused: `manifest.totals()`'s own `boarded` count, too expensive to build fleet-wide every poll. 1161/1161 backend tests. **Slice 3 (operator live monitoring) done**: `ui-map` (`@shared-ui`, Leaflet loaded dynamically, custom token-coloured markers) and `client-admin-app`'s `live-operations` screen — trip list, map panel, selected-trip detail — backed by a new `LiveOperationsStore` and a new, independently-tested `Poller` (`@shared-data`) slice 4 will reuse for passenger tracking and the activity feed. Found a real slice-2 gap building the first consumer: `?since=` was never declared to drf-spectacular, so the typed client could never send it — fixed. 1571 frontend unit tests, 1161/1161 backend tests (+1 assertion). **Slice 4 (passenger tracking and activity feed) done — this closes spec 20, all four slices.** A new `apps/activity` (no models) composes `PaymentIntent`/`Ticket`/`FareJourney` into `GET /activity/mine/`; `customer-app` gained `trip-tracking` (reusing slice 2's detail endpoint) and `activity-feed`, both on the `Poller` slice 3 built. Two spec claims corrected against the model rather than guessed: a PAYG fare posts no ledger entry today, so `fare_deducted` carries no wallet balance; "ticket issued and boarded" folds into `booking_paid` plus its own `ticket_boarded`. 1596 frontend unit tests, 1171/1171 backend tests. Full account in the spec's own four Implementation notes |
| [21](21-passenger-experience.md) | Senior Mode, hold countdown, mobile navigation | 14 | 3 — **slice 1 (responsive navigation) done**: `customer-app`'s `AppShell` moves its nav to a fixed bottom tab bar below Tailwind's own `sm` breakpoint (640px), closing the standing 390px nav-overflow defect. One real 320px finding from the new `e2e/responsive-nav.ts` harness: a flex item's default `min-width: auto` held one two-word tab to 28px wide (under the 44px touch-target minimum) while its one-word neighbours kept their wider intrinsic size — fixed with `min-w-0` plus `break-words`. Running the rest of `customer-app`'s own Playwright suite (not just the new spec) surfaced two further pre-existing, unrelated bugs never actually run to green before: a fixture helper calling a staff-gated endpoint with a passenger token, and `ui-map`'s zoom/attribution/marker elements staying keyboard-focusable inside its own `aria-hidden` container. Both fixed; a third, orthogonal contrast bug in the same component's marker popup was left open for this spec's own slice 3 or spec 20's follow-up. 257 customer-app unit tests changed, 728 client-admin-app unit tests re-confirmed green (no change), no backend change. **Slice 2 (hold countdown) done**: `hold_expires_at`/`hold_expires_in_seconds` added to `BookingSerializer`, computed from the earliest `HELD` `SeatReservation`'s `held_until` (so an already-paid booking gets `null` for free, without a separate check); a new `ui-countdown` (`@shared-ui`) driven by a shared `CountdownClock` (`@shared-data`, one `setInterval` for every mounted countdown, not one each); and both consumers spec 21 named, `booking-confirm` and `my-bookings`. A second spec claim corrected against the model: quick-book bookings hold a real seat (`create_reservation` runs for them exactly as it does for a manually-picked seat) and get a real countdown, unlike open seating, which the spec's own edge case had wrongly generalised to both. `booking-confirm` no longer auto-navigates on submit — it now shows a held/confirmed panel with the countdown first, since the spec's own stated reason for the new POST fields ("so the confirm screen can start counting down without a second request") requires somewhere to show it; "Continue to My Bookings" replaces the automatic redirect. 7 new backend tests (1178/1178), 1617 frontend unit tests (up from 1598, +7/+8/+4 across customer-app/shared-ui/shared-data). **Slice 3 (Senior Mode) done — spec 21 and the roadmap now complete**: `SeniorModeStore` + a `theme.css` token block behind `data-senior="true"`; `html[data-senior='true'] { font-size: 175% }` scales the whole `rem`-based type/control/spacing system from one rule; contrast raised to measured AAA (7:1); header toggle; larger QR treatment. The visual pass found two real bugs and fixed them (`ui-page-header` silently clipping an overflowing title instead of wrapping — missing `min-w-0` on its own flex wrappers; an `sr-only` countdown announcement escaping `ui-table`'s scroll wrapper and inflating page scrollWidth — the wrapper needed `position: relative` to contain it), named one Playwright screenshot-capture artifact as not a real bug, and left one gap accepted rather than fixed: `ui-table`'s deliberately frozen console-density columns (a three-times-hardened prior decision) can wrap mid-word under Senior Mode's larger type, which a root-level `rem` scale cannot selectively avoid — real, but spec 14 territory. 1633 frontend unit tests (up from 1617), no backend change. Full account in the spec's own Implementation note |

**Why 14 is second.** Every spec from 16 onward adds screens. Building
them in the current visual language and re-skinning them afterwards is
double work; building them into a finished language is not. 13 stays
first because it is small, independent, and every long-lived screen
below is worse without it.

The dependencies on 14 are **soft** — each of 15–21 can be built before
it and re-skinned during spec 14's own slices, at the cost of that
rework. The hard dependencies are 16 and 18 on 15, which need a field
that does not otherwise exist.

Two coordination points where a component is shared:

- **Spec 14 owns the console UI kit**; spec 16 consumes it and keeps
  only `ui-chart`.
- **Spec 14 owns `customer-app`'s visual rebuild**; spec 21 owns the
  mobile navigation behaviour and its breakpoint tests. Whichever lands
  first, the other consumes it.

Implementation of each spec is a separate go-ahead, one phase at a
time, sliced backend-then-frontend with a stop for review between
slices.

## Things deliberately not adopted

- Route-level base fare and class multipliers — would break the price
  snapshot historical `SeatReservation`s depend on.
- Route-vehicle assignment — vehicles attach to Trips.
- Route delete — `PROTECT`-ed.
- `Wallet { balance }` — ADR-0006.
- A fifth Trip status.
- Mock data, and RxJS-timer-simulated live updates.
- A component library (Material, PrimeNG). Tailwind plus CDK, as the
  briefs specify and this workspace already does (spec 14).
- Dark mode. The token layer makes it tractable later; it doubles the
  review surface now.
- Doc 1 as an architecture source. It describes a two-app system and is
  silent on multi-tenancy, RLS, white-labeling, KYC/KYB and settlement
  — the load-bearing half of what exists. Feature source only.

## Destructive steps in this arc

One, and it requires explicit approval before it is run:

- **Spec 19, migration step 4** — `RemoveField(Route, is_active)` after
  the `status` backfill. Steps 1–3 leave the system fully working with
  both columns present, so it need not run in the same deployment.

Spec 15 rebuilds two GiST exclusion constraints, which takes an
`ACCESS EXCLUSIVE` lock but destroys nothing.

## New ADRs

None required. Judged per spec:

- Spec 15's wildcard-sentinel fare dimension sits inside the pattern
  ADR-0004 already established. If a later phase adds per-seat class —
  which would reopen ADR-0004's constraint shape — that needs an ADR
  first.
- Spec 20's polling-over-WebSockets choice is deployment-constrained and
  reversible without data migration. If a persistent-process deployment
  and a broker arrive, that is an ADR.
