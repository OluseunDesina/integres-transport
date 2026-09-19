# ADR-0009: Marketplace cross-tenant read access

Status: Accepted

## Context

Every `BaseModel` row is scoped to one Client two ways at once: the ORM
(`TenantScopedManager`, driven by a Python contextvar) and Postgres RLS
(session GUCs `app.current_client_id`/`app.is_platform_staff`), both set
from the requesting user's JWT `client_id` claim by `TenancyMiddleware`
(ADR-0002). A passenger today only ever reads their own Client's rows.

`docs/specs/22-marketplace.md` introduces a genuine cross-operator
marketplace app: a passenger searches and books trips belonging to
**any** Client on the platform, not their own — the same shape Wakanow
gives a flight search across unrelated airlines. Every read in that flow
now routinely needs a row whose `client_id` differs from the requester's
own JWT claim. Under today's RLS that isn't a permission error, it's
silence: the row simply isn't there.

Checked directly, not assumed, before deciding: `apps.seating.views
.TripAvailabilityView` resolves its Trip via `Trip.objects` and does not
independently check `trip.status == SCHEDULED` — it relies entirely on
tenant scoping already having narrowed things correctly.
`apps.network.services.create_route`'s own docstring states
`business.kyb_status == approved` is enforced only at **write time**
(`RouteCreateSerializer.validate_business()`), never re-checked on read.
`apps.booking.services.create_booking` already sets `Booking.client =
trip.client`, **independent of `passenger.client`** — nothing today
asserts they match. So the data model already tolerates a passenger and
the Trip they're booking belonging to different Clients; only the *read*
layer assumes otherwise, and only because RLS was silently providing
"same Client" as an incidental safety net everywhere a real one was never
written.

## Decision

Cross-tenant marketplace reads go through `Model.all_objects` plus
explicit, first-class predicates written fresh for this purpose — **not**
a change to the shared RLS policy, and not a new "marketplace mode" flag
threaded through the existing tenant-scoped views. Two distinct shapes,
never conflated:

1. **Resolving not-yet-owned, public/bookable data** — browse/search, and
   resolving one specific Trip for seat availability or booking creation.
   `all_objects`, filtered by *every one* of: `route.status == ACTIVE`,
   `business.kyb_status == APPROVED`, `trip.status == SCHEDULED`,
   `fare_collection_mode == PREPAID`. Lives in one shared resolution
   helper per resource (one for the Route/Stop match, one for a single
   Trip), never copy-pasted per call site — the predicate list is the
   *only* safety net once RLS's incidental one is bypassed, so it must be
   asserted in exactly one place.
2. **A passenger reading back their own already-created records** — their
   bookings, tickets, payment status, notifications. `all_objects`,
   keeping (or adding, where not already present) the existing
   `passenger=request.user` / `booking__passenger=request.user` /
   `recipient=request.user` filter as the *sole* authorization check,
   replacing RLS's Client-match. Every converted queryset also gets an
   explicit `deleted_at__isnull=True` — `AllObjectsManager` never calls
   `excluding_soft_deleted()`, unlike `TenantScopedManager`, so bypassing
   RLS also silently bypasses soft-delete unless stated.

**`all_objects` alone does not reach a foreign Client's rows — confirmed
live, not assumed.** RLS is a database-level policy; it applies
regardless of which Django manager issues the query. Both shapes above
also need `apps.core.rls.platform_staff_bypass()` wrapped around the
actual query execution, or the row is invisible at the Postgres level no
matter what the ORM asked for. This is the first ordinary,
passenger-facing use of that bypass — every prior call site is
system/platform-staff code (see its own docstring's list) — justified
specifically because shape 1's four predicates, or shape 2's
`passenger=request.user`, are exactly the "caller has already established
authorization some other way" that docstring asks for.

3. **A third shape, discovered building this, not anticipated when this
   ADR was first drafted**: once shape 1 has resolved one specific Trip,
   everything downstream of it — fare lookup (`apps.fares.services
   .get_fare`), seat availability, `apps.booking.services.create_booking`,
   `apps.payments.services`'s intent creation — is existing,
   **unmodified** code that reads/writes through `.objects`, the
   contextvar-driven manager. `platform_staff_bypass()` only flips the
   Postgres GUCs; per its own docstring it deliberately never touches the
   Python contextvar `TenantScopedManager` reads. So calling any of that
   unmodified code from inside a marketplace request — whose contextvar
   is the *passenger's own* (Marketplace) Client — would silently
   ORM-filter every one of those reads/writes to the wrong Client, bypass
   or not. The fix, and it is not new: `apps.marketplace`'s views wrap
   these calls in `set_current_client_id(str(trip.client_id))` /
   `reset_current_client_id(...)`, nested inside `platform_staff_bypass()`
   — the exact combination `apps.core.management.commands
   .seed_e2e_users._seed_boardable_open_seating_ticket` already uses to
   call `create_booking` on behalf of a Client other than the ambient
   one. Nothing about `create_booking`/`get_fare`/payment-intent creation
   changes; they run exactly as they do for a same-Client booking, just
   with the contextvar temporarily pointed at the Trip's own (already
   independently verified bookable) Client for the duration of the call.

A dedicated singleton **Marketplace Client** (`Client.is_marketplace`,
`get_or_create_marketplace_client()`) is what a marketplace passenger's
own `User.client` points at — see spec 22 for the seeding mechanics.
Everything on the operator side (client-admin, ledger, settlement,
staff-facing manifest/trip views) needs zero changes: a marketplace
booking's own `client`/`business` are already the *operator's*, exactly as
if it had been booked directly.

## Options considered

- **Extend the shared RLS policy with an `app.current_user_id` GUC and an
  `OR`-clause allowing "row belongs to me" regardless of Client.**
  Rejected: checked the actual policy SQL
  (`apps.core.migration_operations`) — it is one generic operation applied
  identically to every protected table. The ownership column differs per
  table (`Booking.passenger` direct; `PaymentIntent`/`Ticket`/
  `Notification` one or two FK hops away), so this would need bespoke
  per-table policy SQL with subqueries — a **larger** blast radius than
  the per-view approach above, touching every protected table's migration
  rather than a small, named list of views.
- **`client=NULL` for marketplace passengers**, matching how platform
  staff opt out of tenancy. Rejected: `NULL` is reserved for platform
  staff throughout (ADR-0003); every other invariant (email uniqueness is
  per-Client, `is_client_staff` semantics, KYC dashboards) assumes a real
  Client for anyone who isn't platform staff. A dedicated Client keeps
  every existing invariant intact.
- **Query-param toggle on the existing tenant-scoped views** (e.g.
  `?scope=marketplace` on `GET /trips/search/`) instead of new views.
  Rejected: the existing endpoints' entire safety story rests on "RLS
  already narrowed this to my Client" being always true; a toggle risks
  that guarantee leaking to the wrong caller through a config mistake.
  New, separately-named views (`apps.marketplace`) make the cross-tenant
  posture `grep`-able and impossible to reach by accident, the same
  reasoning `RouteBrowseView` already uses to stay separate from
  `RouteListCreateView`.
- **A new Django app, `apps.marketplace`, for the cross-tenant views**
  (chosen) vs. scattering `Marketplace*View` classes across
  `network`/`scheduling`/`seating`/`booking`/`payments`'s own `views.py`
  files. Chosen because the cross-tenant boundary crosscuts all five and
  is itself worth naming as one thing — the same reasoning `tapngo` earned
  its own app for a distinct posture rather than living inside
  `scheduling`.

## Consequences

A short, fixed list of views now deliberately bypasses RLS's Client-match:
the two marketplace resolution helpers, and the five widened "my own
records" views named in spec 22. Every one of them is required to state,
in its own docstring, exactly which explicit predicate replaces the RLS
guarantee it no longer gets for free — the same discipline
`platform_staff_bypass()`'s own docstring already models ("Queries inside
the block must use `Model.all_objects`... don't reach for this unless the
caller has already established authorization some other way").

If a future domain model changes what counts as "publicly bookable" (e.g.
Route gains a fifth lifecycle state, or Business KYB gains a
suspend/revoke transition — both already flagged as gaps in
`docs/traps.md` and `apps.businesses.services`), the two resolution
helpers are the only two places that need updating; every other read in
the platform is unaffected, since only marketplace code paths touch
`all_objects` for this purpose.
