# 9-notifications: In-App Notifications

Deferred from live-testing triage (2026-08-19), spec'd per this repo's
"spec before code" rule. Unlike the wallet and seat-map-generation
specs, this one closes no existing UI-sweep gap — there is no
half-built notification infrastructure anywhere in this codebase to
extend. This is a genuinely new cross-cutting domain, the largest of
the three deferred enhancements, touching all 4 frontend apps plus a
new backend app.

`ASSUMPTION:` **in-app only** — no email/SMS/push delivery. The
original request framed this explicitly as "in-app notifications," and
no email/SMS provider is integrated anywhere in this codebase today
(a real, separate integration this spec doesn't take on). Flagged
here, not silently assumed, per this repo's rule 4.

## Scope and non-goals

**In scope**: a `Notification` model (recipient, type, read/unread), a
bell-icon-style unread list in each of the 4 frontends (via
`@layout`), and two trigger shapes matching the two examples the
original request named:

1. **A scheduled sweep** — "notify the client about license
   expiring." A Celery Beat job, same shape as every other periodic
   job in this codebase (`scheduling.tasks`/`seating.tasks`), scanning
   for state that's about to become a problem and hasn't been notified
   about yet.
2. **Event-driven** — "notify customers to use their tickets." Fired
   at the moment a specific domain event happens (a `Ticket` is
   issued, a Trip's departure is approaching and the ticket is still
   `issued` not `boarded`), not on a fixed schedule.

**Non-goals** (deliberate):
- **Email/SMS/push delivery.** § above.
- **A user-configurable notification-preferences screen** (mute this
  type, change frequency). v1 ships with one fixed rule set per
  notification type; every eligible recipient gets it.
- **Cross-tenant/platform-wide announcements** (e.g. Integra
  broadcasting a maintenance-window notice to every Client). This
  spec's model is scoped to one recipient at a time, matching every
  existing per-user domain concept in this codebase (`AuditLog`,
  `IdempotencyKey` excepted, since those aren't user-facing) — a
  broadcast mechanism is a distinct, later feature.
- **Real-time delivery** (WebSocket/SSE push the moment a notification
  is created). v1 is poll-on-load plus a manual refresh, matching this
  frontend's existing `ListStore` polling-free precedent — nothing in
  this workspace currently holds an open connection to the backend.
- **Retroactively notifying about state that already existed before
  this ships** (a Driver whose license already expired last month).
  The scheduled sweep only evaluates state going forward from
  deployment; a backfill sweep is a one-time operational task, not
  part of this spec's steady-state behavor.

## Two concrete trigger examples this spec builds, grounded in real fields

Named explicitly so this isn't a generic notification-engine spec with
no real consumer — these are the two the original request named, and
both map to fields that already exist:

- **License/compliance expiring** (`client-admin-app`, scheduled):
  `apps.fleet.models.Driver.license_expires_at`,
  `Vehicle.insurance_expires_at`, `Vehicle.roadworthiness_expires_at`.
  `apps.fleet.services.compliance_warnings_for()` already computes an
  *already-expired* warning today, but only as a pull-on-GET signal
  (rendered on the Driver/Vehicle serializer response, seen only if a
  client-admin happens to load that screen) — never a push, and never
  before the expiry date, only after. This spec's sweep runs daily,
  fires a notification **N days before** `*_expires_at` (a configurable
  threshold, § Data model), and once more on/after actual expiry —
  turning an already-computed-but-silent signal into something a
  client-admin actually gets told about without having to go looking.
- **Unused ticket reminder** (`customer-app`, event-driven, sweep-
  triggered): `apps.ticketing.models.Ticket.status == ISSUED` (not yet
  `BOARDED`) and `trip.scheduled_departure_at` is within N hours.
  Same sweep-job shape as the license case, different query and
  recipient.

## Data model changes

New app: `apps/notifications`. `Notification` is a `BaseModel`
subclass (tenant-owned — `client` is always set, matching every
recipient this spec targets being a Client-scoped staff user or a
passenger tied to a Client via their bookings).

| Field | Type | Notes |
|---|---|---|
| `recipient` | FK → `identity.User`, PROTECT, `related_name="+"` | Matches this codebase's universal no-reverse-accessor convention on RLS-protected models. |
| `notification_type` | `CharField`, choices — `license_expiring` / `insurance_expiring` / `roadworthiness_expiring` / `ticket_unused_reminder`, extensible | Fixed enum, additive over time — same "fixed taxonomy, extend by migration" precedent `LedgerAccount.account_type` already established. |
| `title` / `body` | `CharField` / `TextField` | Rendered text, generated server-side at creation time (not a client-side i18n lookup by type+params) — simplest correct choice for a first version with one locale. |
| `related_object_type` / `related_object_id` | `CharField(64)` / `UUIDField`, nullable | A loose pointer (Driver, Vehicle, Ticket) — not a real FK, deliberately: a notification about an expired Driver must survive the Driver later being deactivated or the notification being read long after, and a generic `ContentType`-style FK adds real complexity for a field only ever used to build a "view this" link. `ASSUMPTION`: frontend resolves this into a route by `related_object_type`, a small fixed switch, not a generic polymorphic viewer. |
| `read_at` | `DateTimeField`, nullable | `NULL` = unread. |
| `created_at` | inherited from `BaseModel` | |

```python
constraints = [
    models.UniqueConstraint(
        fields=["recipient", "notification_type", "related_object_type", "related_object_id"],
        name="unique_notification_per_recipient_type_target",
    ),
]
```

This constraint is the sweep's own idempotency mechanism — re-running
the daily sweep against a Driver whose license already triggered a
notification does not create a duplicate; the sweep's write is a plain
`get_or_create()`, same discipline every other "always attempt the
write, let Postgres decide" invariant in this codebase already uses.

**New settings**: `LICENSE_EXPIRY_WARNING_DAYS` (default `30`),
`TICKET_UNUSED_REMINDER_HOURS_BEFORE_DEPARTURE` (default `2`) — plain
`config()`-backed ints in `config/settings/base.py`, matching
`CLIENT_ADMIN_APP_URL`'s existing shape, not hardcoded magic numbers.

## API surface

New codenames: `notifications.view` (staff-facing list, though most
consumers here are the recipient's own), granted to every Role preset
by default — a notification is inherently personal, gating by Role
would be backwards (Owner/Manager/Staff all need to see their own).

- `GET /notifications/mine/?unread_only=` — the authenticated user's
  own notifications, `IsAuthenticated` only (matches
  `GET /bookings/mine/`'s passenger-reachable shape — a passenger has
  no Role, per ADR-0003, and still needs this for the ticket-reminder
  case).
- `POST /notifications/{id}/read/` — marks one notification read.
  `IsAuthenticated`, scoped to the caller's own rows only (a 404, not
  a 403, for another user's notification id — matches
  `GET /bookings/mine/`'s existing not-found-not-forbidden precedent
  for owned resources).
- `POST /notifications/read-all/` — marks every unread notification
  for the caller read, for a "mark all read" UI action.

No staff-facing cross-recipient list endpoint this pass — each app
only ever needs "my own notifications," and a support-lookup screen
(client-admin viewing a specific passenger's notifications) isn't
named in the original request.

## Frontend surface (all 4 apps)

A shared `@layout` addition — a bell icon with an unread-count badge
in each app's existing top bar/`NavShell`, opening a dropdown/panel
listing recent `Notification`s, clicking one marks it read and
navigates via `related_object_type`. Built once in `@layout` (or
`shared-ui`, if not shell-specific), consumed by all 4 apps, following
`ui-select`'s own "one shared component every app pulls in, not four
copies" precedent. `validator-app`'s bespoke, nav-less `AppShell`
(itself only recently gained two plain text links — see
`docs/specs/4b-tap-and-go.md`'s implementation note) is the one app
where this needs its own placement decision, not a drop-in — flagged
so it isn't assumed identical to the other three.

## Edge cases

1. **A Driver/Vehicle's expiry date is edited to move it further out
   after a notification already fired.** The notification already
   sent stays as-is (notifications are not retracted) — this spec
   doesn't build an "un-notify" path. A later license-expiring
   notification will still fire again once the new date approaches
   the threshold, since the uniqueness constraint keys on
   `(recipient, type, target)`, not on the expiry date itself — if the
   same target re-enters the warning window after being pushed out and
   back in, `ASSUMPTION:` this re-fires once the row's own `read_at`
   plus a "re-eligible" check is added; **named as a real gap this v1
   does not handle** (a get_or_create keyed only on `(recipient, type,
   target)` fires once ever per target, not once per warning window) —
   worth resolving before build, not silently shipped as a surprise.
2. **A passenger's ticket is boarded before the reminder sweep runs.**
   The sweep's query filters `status == ISSUED` at scan time — a
   boarded ticket is simply not selected, no notification fires. No
   race concern (the sweep runs on its own schedule, doesn't need to
   coordinate with `validate_ticket()`).
3. **A Driver/Vehicle is deactivated (`is_active=False`) while still
   inside the expiry warning window.** `ASSUMPTION:` the sweep still
   fires — deactivation doesn't imply the compliance issue is
   resolved, and silently suppressing the warning could hide a
   still-real problem if the record is reactivated later without the
   underlying license actually being renewed.
4. **Multiple client-admin staff at the same Business.** Every
   Staff/Manager/Owner user at the Business gets their own
   `Notification` row (the `recipient` is a specific `User`, not the
   Business) — matches `StaffInvitation`'s own per-user, not
   per-Business, addressing.

## Failure modes

- **Sweep job failure mid-run.** Each sweep iterates targets and
  writes independently (`get_or_create` per target) — a failure
  partway through leaves some targets notified and others not, picked
  up cleanly on the next scheduled run (idempotent by construction, §
  Data model's uniqueness constraint) rather than needing its own
  retry/resume logic.
- **Duplicate sweep runs** (e.g. both a stale process and a fresh one
  overlap during a deploy). DB-enforced no-op for any target already
  notified — same "always attempt the write, let Postgres decide"
  discipline as every other concurrency-sensitive write in this
  codebase.

## Test plan

**Backend**:
- License-expiring sweep: fires within the threshold window, doesn't
  fire outside it, doesn't duplicate on a second run (idempotency).
- Unused-ticket sweep: fires for an `ISSUED` ticket within the
  reminder window, not for a `BOARDED`/`EXPIRED`/`REVOKED` one.
- `GET /notifications/mine/`, `POST /notifications/{id}/read/`: cross-
  user isolation — a user cannot read or mark-read another user's
  notification (404, not 403).
- RLS coverage: confirm the registry-driven test
  (`apps/core/tests/test_row_level_security.py`) picks up
  `Notification` automatically.
- Internal task endpoint: mirrors `apps/core/urls.py`'s existing
  `internal/tasks/generate-trips/`/`expire-seat-holds/` shared-secret
  pattern (this deployment's GitHub Actions cron replacement for
  Celery Beat under Vercel — see `docs/deployment.md`) — a new
  `internal/tasks/notification-sweep/` entry needed in both the
  Celery Beat schedule (Docker) and the GitHub Actions cron config
  (Vercel), named explicitly so it isn't missed the way a purely
  Celery-Beat-only job would be under the serverless deployment.

**Frontend**: unread-badge rendering, mark-read interaction, per-type
routing via `related_object_type`, across all 4 apps' shell
integration.

**E2E**: one flow proving a seeded near-expiry Driver produces a
visible client-admin-app notification after the sweep runs (calling
the internal sweep endpoint directly in test setup, the same way
`seed_e2e_users` seeds other fixture state, rather than waiting on a
real Celery Beat schedule).

## Migration impact

**Purely additive.** New app, one new model, two new settings, no
change to any existing model.

## Open questions

- Exact `LICENSE_EXPIRY_WARNING_DAYS`/reminder-hours defaults — `30`
  days / `2` hours above are starting-point guesses, not confirmed
  operator input. Cheap to change (plain settings), not blocking.
- Whether the re-fire behavior in Edge case 1 (a target re-entering
  the warning window) needs solving before this ships, or is an
  acceptable v1 gap — needs the user's call before implementation
  starts, not assumed either way here.
- Whether platform staff (`super-admin-app`) need their own
  notification types at all in v1 (e.g. a new KYB submission waiting
  on their queue) — the original request only named client-admin and
  customer-facing examples; `super-admin-app` isn't excluded by this
  spec's model, just not scoped with a concrete trigger yet.

## Implementation note (Slice A — backend, done)

Built 2026-08-20, resolving both open questions above before writing
any code (per this repo's own "never guess on ambiguity" rule) —
**both resolutions changed the data model from what this spec
originally drafted**:

**1. Weekly re-nag, not fire-once-ever.** Confirmed with the user: the
license-expiring trigger's whole value is recurring, since compliance
documents renew on a roughly annual cycle — firing exactly once per
Driver/Vehicle, ever, would make the feature useless after a driver's
first renewal. Resolved as: warn once when a compliance date enters
the danger window, then re-nag every `LICENSE_EXPIRY_RENOTIFY_DAYS`
(7) days as long as it's unresolved, and a renewal (the expiry date
actually changing) starts a fresh cycle immediately regardless of the
renotify interval. This needed two fields this spec's original draft
didn't have — `Notification.expiry_snapshot` (the exact `*_expires_at`
value a given row is about, so the sweep can tell "still the same
unresolved problem" apart from "renewed, then re-entered the window")
and `Notification.notified_for_date` (the calendar day a row was
created, the real dedup key) — and the uniqueness constraint changed
from `(recipient, type, target)` to `(recipient, type, target,
notified_for_date)`. The ticket-unused-reminder trigger deliberately
keeps the *original* fire-once-ever design unchanged — a Ticket's own
status naturally resolves it (moves to `boarded`/`expired`/`revoked`
and stops matching the sweep's filter), so there's no renewal concept
to re-nag about.

Named, not silently absorbed: this design has one real, narrow gap —
if the sweep were ever triggered twice on the same calendar day (it
isn't, under this deployment's daily cron/beat cadence — see §"Celery
Beat + internal task HTTP endpoints" below), a same-day renewal
wouldn't get its own row until the following day, since
`notified_for_date` is a same-day dedup key that doesn't also account
for the value changing within that one day. Caught by, and worked
around in, this slice's own test for the renewal scenario
(`test_compliance_sweep_starts_a_fresh_cycle_immediately_when_the_expiry_date_changes`
backdates the prior notification by a day rather than testing two
literal same-day sweep runs) — not fixed, since it isn't reachable
under the real deployment's cadence.

**2. A `super-admin-app` trigger, added to v1**: `kyc_document_submitted`
/`kyb_document_submitted`, event-driven (not swept) — every
platform-staff user gets notified the moment
`apps.clients.services.submit_kyc_document`/
`apps.businesses.services.submit_kyb_document` create a document. This
surfaced a real modeling gap in this spec's original "`client` is
always set, matching every recipient being a Client-scoped staff user
or a passenger" framing: **platform staff have no Client of their own**
(ADR-0003 — `identity.User.client` is nullable for them), so a KYC/KYB
notification's `recipient` and its `client` now deliberately point at
different parties — `client` is the **submitting** Client (the one
that genuinely owns the underlying event), not the recipient's own.
`Notification.client` itself stays non-nullable throughout (no new
exception to "every `BaseModel` row has a Client," unlike `identity.User`
or the one deliberate `LedgerAccount.account_type="integra_commission"`
row) — only the *relationship* between `client` and `recipient` is
different for these two types.

That decision has one real, load-bearing consequence on the read side:
`GET /notifications/mine/`/`POST /notifications/{id}/read/` both
branch on `request.user.is_platform_staff`, reading through
`Notification.objects` (ordinary RLS-scoped) for a client-scoped
recipient or `Notification.all_objects` for a platform-staff one — the
latter's own notifications can span several different Clients, so
`.objects` (single-session-client scoping) would silently return
nothing for them. Verified this is actually safe, not assumed: RLS's
own policy is `client_id = session_client OR is_platform_staff = true`
(`apps.core.migration_operations`), and `TenancyMiddleware` sets the
`is_platform_staff` GUC directly from the JWT for every authenticated
platform-staff request — so `.all_objects` here relies on exactly the
same DB-level boundary every other `IsPlatformStaff`-reachable
cross-client read in this codebase already trusts (e.g.
`BusinessSuperAdminListView`), not a new access shape invented for
this slice. `mark_all_notifications_read()` carries the identical
branch. A concrete regression test
(`test_platform_staff_sees_their_own_notifications_spanning_multiple_clients`)
seeds two `Notification`s under two different Clients for one
platform-staff recipient and confirms both come back in one `GET`.

**A real, independent bug found while wiring this up**: `identity.User`
is not a `BaseModel` subclass (no `all_objects`, no RLS policy — see
ADR-0003), so the sweep's own `_eligible_client_staff()`/
`_notify_platform_staff()` helpers originally reached for
`User.all_objects` out of habit, matching every other model touched
inside `platform_staff_bypass()` — `mypy` caught it immediately
(`"type[User]" has no attribute "all_objects"`), not a live bug, but
worth naming since it's the same "which manager does this actually
need" question every RLS-related bug in this codebase's history has
turned on. Fixed to plain `User.objects` (already unscoped — User
carries no tenancy filtering of any kind, exactly why `TenancyMiddleware`
itself can look a user up before any tenancy context exists).

**Everything else built exactly as spec'd**: `apps/notifications`
(`Notification`, RLS-protected, auto-picked-up by the registry-driven
test with zero extra work), `sweep_expiring_compliance()`/
`sweep_unused_tickets()` (both under `platform_staff_bypass()`, both
using `.all_objects` throughout for every RLS-protected model), the
two Celery Beat tasks + their data-migration-seeded daily schedules
(03:00/03:15 UTC), two internal-task HTTP endpoints mirroring
`GenerateTripsView`/`ExpireSeatHoldsView`'s exact shape plus two new
GitHub Actions cron workflows (`docs/deployment.md` §1.1 updated), the
`notifications.view` codename (seeded, granted to every Role preset,
not actually gating any v1 endpoint — all three are `IsAuthenticated` +
own-row-scoped, matching `BookingMineView`'s shape), and `GET
/notifications/mine/`'s `unread_only` filter.

One correction to this spec's own Edge case 4 wording ("every
Staff/Manager/Owner user at the Business"): there is no per-Business
staff assignment anywhere in this codebase (`identity.User.client` is
the only scoping FK) — recipients are resolved at the **Client** level,
not the Business level, for every Driver/Vehicle regardless of which
Business owns it.

540/540 backend tests before this slice, 565/565 after (25 new tests
in `apps/notifications/tests/test_notifications.py`, covering both
sweeps' full renotify/fresh-cycle/window-exit behavior, the KYC/KYB
event triggers, and the platform-staff cross-client read branch).
Adding `notifications.view` to Manager/Staff's default permission list
surfaced two pre-existing exhaustive-permission-list assertions in
`apps/identity/tests/` — updated, not a regression, the same class of
"real, expected exhaustiveness catch" this codebase has hit before.
`ruff`/`mypy` clean, `openapi.yaml` regenerated and drift-checked
clean, no pending migrations beyond `apps/notifications`'s own two.

**Not yet built** (Slice B, next): the shared bell-icon UI in
`@layout`/`shared-ui` and its wiring into all 4 frontend apps —
`client-admin-app`/`super-admin-app` via `NavShell` (a new top-of-sidebar
slot, since `NavShell` currently exposes no content-projection point),
`customer-app` via its own bespoke top bar, and `validator-app` via its
bespoke nav-less header (its own placement decision, per this spec's
own note — not a drop-in like the other three).

## Implementation note (Slice B — frontend, done)

Built 2026-08-20, closing Phase 9 entirely.

Two research passes before writing any code found **three real routing
gaps** this spec's original "frontend resolves `related_object_type`
into a route, a small fixed switch" framing had glossed over — each
resolved, not discovered mid-build:

1. **`customer-app` / Ticket**: the only ticket-viewing route,
   `my-bookings/:id/tickets`, is keyed by **Booking** id, not the
   **Ticket** id a `ticket_unused_reminder` Notification actually
   carries — no route or endpoint is reachable from a Ticket's own id
   alone. Resolved without any backend change: clicking navigates to
   `/my-bookings` (the general list), not a deep link to the specific
   ticket.
2. **`super-admin-app` / KycDocument, KybDocument**: `kyc-queue` and
   `kyb-queue` are flat lists with no id-based route param at all.
   Same resolution — navigates to `/kyc-queue`/`/kyb-queue` generally.
3. **`validator-app`**: signs in via the client-admin JWT audience, so
   could legitimately receive a Driver/Vehicle compliance notification
   — but has no Driver/Vehicle screens at all. Passes no route
   resolver at all, so every notification there is mark-read-only —
   also the general fallback for any unmapped type/app combination
   (no dead links anywhere).

**Built**: `NotificationBell` (`@layout`, not `shared-ui` — it does
real data-fetching via `API_CLIENT`/`AuthStore`, the same class of
component `NavShell` already is). Dropdown mechanics deliberately
reuse `NavShell`'s own profile-menu pattern exactly (a plain
`menuOpen` signal, document-level click-outside + Escape listeners) —
confirmed via research that no CDK Overlay/Menu exists anywhere in
this workspace, so this doesn't introduce a second dropdown mechanism.
Fetches the recent list (`limit=20`) plus a cheap second call
(`unread_only=true&limit=1`, reading just `.count`) on init and again
every time the panel opens — this slice's "manual refresh," matching
the spec's own no-real-time-push non-goal. A `resolveRoute` input
(`(type, id) => string[] | null`, defaulting to always-`null`) is the
per-app customization point described above. `NavShell` gained a
passthrough `resolveNotificationRoute` input and renders the bell
itself in its existing header row, since it has no content-projection
slot; `customer-app`/`validator-app` embed the bell directly in their
own bespoke headers. New `bell` icon added to `shared-ui`'s `IconName`.

**A real bug found and fixed via live verification, not a unit
test**: the dropdown panel (`w-80`, anchored `right-0`) rendered fully
off the left edge of the browser viewport inside `NavShell`'s narrow,
left-docked sidebar — a right-anchored panel growing leftward from a
bell near the sidebar's own right edge (≈240px from the true left edge
of the screen) pushed the panel's left edge to a negative x-coordinate.
Invisible to the component's own unit tests (jsdom has no real
viewport-overflow concept) and invisible in `customer-app`/`validator-app`
(wide headers where the bell sits near the *actual* right edge of the
viewport, so growing leftward stays on-screen) — only visible by
actually opening it in a browser inside the sidebar context, which is
exactly how it was caught, screenshotted, fixed, and re-verified.
Fixed with a new `align: 'left' | 'right'` input (default `'right'`,
correct for the two bespoke-header apps); `NavShell` passes
`align="left"` for its own placement. Locked in with a new component
test asserting the class toggle, not just fixed and left to the
browser check alone.

**Verification**: 565/565 backend tests unaffected (only a cosmetic
body-text formatting fix landed here — the ticket-reminder
notification's departure timestamp was a raw
`datetime.isoformat()` with microseconds, e.g.
`2026-08-20T14:22:38.766357+00:00`; now `2026-08-20 14:22 UTC`, caught
by actually reading it in the browser during verification, not by any
test). `ruff`/`mypy` clean. 39/39 `layout`, 50/50 `shared-ui`,
278/278 `client-admin-app`, 67/67 `super-admin-app`, 118/118
`customer-app`, and 31/31 `validator-app` Karma tests passing (all
either unaffected or with the expected `API_CLIENT`-provider additions
where `NotificationBell` now renders as a child). `ng lint` clean on
all 6 touched projects, `ng build` clean on all 4 apps,
`openapi:check` clean (no backend schema change this slice).

Live-verified end to end against the real backend, one full round
trip per notification type: seeded a real near-expiry Driver in
`client-admin-app` (`sweep_expiring_compliance()`), a real paid
booking with a near-departure Trip in `customer-app`
(`sweep_unused_tickets()`), and a real KYC submission for a real
platform-staff user in `super-admin-app`
(`notify_kyc_submitted()`) — for each, confirmed the unread badge
count, the dropdown list contents, mark-read-on-click, and the
click-navigation landing exactly where each app's resolver said it
should (`/drivers/{id}/edit`, `/my-bookings`, `/kyc-queue`
respectively), including a screenshot of each confirming the panel
renders fully on-screen. The three demo Clients and one platform-staff
User created for this verification could not be cleanly deleted
afterward (`ProtectedError` — the seeded `Notification` rows
themselves protect the demo User; the demo Clients' own Business/Route/
Trip chains protect them) — left in the dev database rather than
force-cascading, the same posture Phase 8's own verification pass and
`prune_e2e_test_data` already established.

**This closes Phase 9 (Notifications) entirely** — both slices built,
tested, and verified.
