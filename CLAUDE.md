# CLAUDE.md

Guidance for Claude Code (or any contributor) working in this repo.

## What this is

Integra AFC — an Automated Fare Collection platform for African transport
operators (Lagos commuter shuttle, intercity bus, Botswana metro). One
Django/DRF backend; four white-labeled Angular 20 frontends (customer,
client-admin, super-admin, validator) sharing libraries in one Angular
CLI workspace. `validator-app` is an installable PWA standing in for the
still-out-of-scope Flutter validator app — see its own note under Phase
4b below and `docs/specs/4b-tap-and-go.md`'s "Operator harness" section.

**Status: Phase 0 (Foundation), Phase 1 (Identity, Client, Business),
Phase 2 (Client-Admin + Super-Admin UI), and Phase 3 (Network,
Scheduling, Fleet) complete**, all self-checked
(`docs/self-check-2026-08-07.md`, `docs/self-check-2026-08-08.md`,
`docs/self-check-2026-08-08-phase2.md`,
`docs/self-check-2026-08-09-phase3.md`). Phase 3 built `apps/network`
(Route/Stop/RouteStop), `apps/fleet` (VehicleType/Vehicle/Driver), and
`apps/scheduling` (Schedule/Trip, a Celery Beat job that generates Trips
from active Schedules daily), plus `client-admin-app` screens for all
seven models. **Phase 4 (Fares, Seating, Booking) backend is complete**,
spec'd at `docs/specs/4-fares-seating-booking.md` (§9 lays out its 3
backend slices, all now done). Slice 1 built `apps/fares`
(`FareRule`/`FareSegmentRule`, `Business.fare_pricing_mode`). Slice 2
built `apps/seating` (`Seat`/`SeatReservation`, the GiST exclusion
constraint, `Business.seat_hold_minutes`, the expiry-sweep Celery Beat
job) plus `apps/booking`'s bare `Booking` model, landed alongside
`apps/seating` since `SeatReservation.booking` FKs it. **`docs/adr/0004`
is now Accepted** — its mandatory concurrency spike test
(`apps/seating/tests/test_seat_concurrency.py`) exists and passes
reliably. Slice 3 built out `apps/booking`'s creation/cancellation flow
(`create_booking`/`cancel_booking`, `POST /bookings/`,
`POST /bookings/{id}/cancel/`, `GET /bookings/mine/`, `GET /bookings/`
for staff) — the first real consumer of `apps.core.models.IdempotencyKey`,
via the new reusable `apps.core.idempotency` module. **Phase 4's frontend
addendum (customer-app booking flow + client-admin bookings-list) is
also now built**, spec'd at
`docs/specs/4-fares-seating-booking-frontend.md` — the backend gap-fill
it required (`GET /routes/browse/`, `GET /trips/search/`,
`BookingSerializer.trip` nesting) plus all 4 frontend slices, built
without the spec's own stop-and-review checkpoints between slices and
verified after the fact — see that spec's own implementation note and
`docs/self-check-2026-08-14-phase4-frontend.md` for the full account,
including one real bug fixed (`apps/network/services.py::set_route_stops`)
and one shared-component UI bug fixed (`ui-select` missing `w-full`). A
second, separately spec'd, wholly unplanned feature — versioned
`FareRule`/`FareSegmentRule` with price-snapshotting on
`SeatReservation`/`Booking.currency` — was discovered during that same
verification pass and is now documented at
`docs/specs/4-fares-seating-booking-versioning.md`; it includes
destructive migrations already applied to the dev database. 346/346
backend tests passing (up from 303). **Phase 5's two blockers are now
resolved** (2026-08-14): `docs/adr/0006` (ledger chart-of-accounts) is
now **Accepted** (its three open questions — commission-split shape,
settlement-run modeling, refund/concession account reuse — are
resolved in the ADR itself), and the payment partner is decided —
**Paystack**, per the new `docs/adr/0007` — with Botswana coverage
named as an explicit, tracked gap (Paystack doesn't operate there; a
second PSP for that market is deferred, not silently assumed away).
Phase 5 is spec-ready as of this decision but not yet spec'd. **Phase
4b (tap-and-go fare determination) backend is now built**, spec'd at
`docs/specs/4b-tap-and-go.md` (see that spec's own "Implementation note"
for the full account), answering the open question ADR-0004 left
behind. Built `apps/tapngo` (`TapCredential`/`FareJourney`/`TapEvent`),
identification via QR code or NFC through one opaque revocable token,
fare resolution reusing `apps.fares.services.get_fare()` unchanged, the
one-open-journey-per-passenger invariant enforced by a Postgres partial
unique index (not a GiST constraint — this isn't a range-overlap
problem), proven under real concurrency the same way ADR-0004's own
spike was. Two new permission codenames (`tapngo.record`/`tapngo.view`).
383/383 backend tests passing (up from 346). **The operator harness is
also now built** (2026-08-16) — not the unstyled page this spec
originally scoped, but `validator-app`, a fourth Angular app in the
workspace (installable PWA, `ng serve validator-app` on :4203), built to
the same `@shared-ui`/`@auth`/`@layout`/`@api-client` standard every
other app is, per direct request superseding the original "exempt from
the design/a11y bar" framing — see
`docs/specs/4b-tap-and-go.md`'s "Implementation note (frontend, done)"
for the full account, including two real bugs found only by actually
running it (a missing `CORS_ALLOWED_ORIGINS` entry for the new app's
port, and a `ui-button` `aria-pressed` binding that silently landed on
the wrong DOM element — fixed at the shared component, not worked
around). **The customer-app credential-issuance UI is also now built**
(2026-08-17) — `customer-app` gained a `credentials` screen
(`GET`/`POST /tap-credentials/`, `PATCH /tap-credentials/{id}/`, all
already customer-app-consumable with no backend change needed) to issue
a Tap & Go credential, see its raw token and a scannable QR code exactly
once, and revoke it — see `docs/specs/4b-tap-and-go.md`'s
"Implementation note (Frontend — customer-app credential UI, done)" for
the full account, including this workspace's first QR-rendering code
(the new `qrcode` npm dependency). **A permanent Playwright E2E spec for
validator-app's `record` screen is also now built** (2026-08-17) —
`frontend/e2e/validator-app/{login,record}.spec.ts`, needing a new
`playwright.config.ts` entry (port 4203) and a `seed_e2e_users`
extension (`_seed_tap_and_go_fixture`: its own tap-and-go-mode
`Business`, since `booking_mode` is snapshotted per-Trip from
`route.business.booking_mode_default` and can't vary within one
Business, plus a `TapCredential` seeded with a known fixed token —
`issue_credential()` never persists the raw token, so the real flow
can't produce one an e2e spec can reuse). **This closes Phase 4b
entirely.** See `docs/specs/4b-tap-and-go.md`'s fourth Implementation
note for the full account, including 4 pre-existing, unrelated
full-suite failures traced to this dev database's accumulated
Business-list cruft (see the correction below — the note's own original
"no explicit ordering" diagnosis for `Business`/`Route` was wrong).

**Cross-cutting fix, same day**: a follow-up investigation corrected
that diagnosis — `Business`/`Route` both already have stable
`-created_at` ordering; the real mechanism is that ordering plus a few
frontend `limit=100` "fetch everything" call sites plus unbounded dev-DB
cruft with no cleanup tooling. Two genuinely distinct, real correctness
gaps were found and fixed: `identity.Role` and `identity.User` (the
model `StaffListView` lists) had **no** `Meta.ordering` at all (`Role`
declares its own bare `Meta`, silently dropping `BaseModel.Meta`'s
inherited ordering — the same trap `Route.Meta`'s own comment already
documented once). Fixed with `ordering = ["name"]`/`["email"]`
respectively (one state-only migration, `identity/migrations/0015_...`).
Also added `prune_e2e_test_data`, a new dev/CI-only management command
(sibling to `seed_e2e_users`, kept separate so that command's own
"never deletes" guarantee stays true) that best-effort-deletes stray
e2e cruft under the one hardcoded e2e Client, skipping any row with a
protected dependent rather than force-cascading. Run once against the
live dev stack: 145 Businesses down to 38, 4 of the originally-observed
Playwright failures down to 2 — the remaining 2
(`booking.spec.ts`/`kyb-queue.spec.ts`) have cruft rows with their own
protected dependents (a `KybDocument`, a `Trip`) a non-cascading prune
can't safely remove; named, not solved.

**Two more bugs found by a deliberate audit, same day, both fixed**:
asked to "look carefully" for anything else in the same vein, a
targeted pass over RLS/tenancy correctness and over the frontend's
other `limit=100` call sites turned up two genuinely new, real bugs
(not a rehash of the above):

1. `apps.seating.services.replace_vehicle_type_seats` deleted existing
   seats via `Seat.objects.filter(...).delete()` — the tenant-scoped
   manager — instead of `Seat.all_objects`, the exact failure shape
   `apps.network.services.set_route_stops` was already fixed for (a
   `platform_staff_bypass()` caller has no Python tenancy contextvar
   set, so `.objects` silently matches zero rows and the delete is a
   no-op). This function's own docstring said it "mirrors
   `set_route_stops`'s hard-delete-and-recreate shape" but never got
   the matching fix. Not tripped in practice only because its one
   caller, `seed_e2e_users`, has a defensive guard skipping reseeding a
   `VehicleType` that already has Seats (which stays, for a different
   reason — preserving real `SeatReservation`s from cascading away).
   Fixed to match `set_route_stops` exactly, plus a new regression test
   (`apps/seating/tests/test_seating.py`) that calls the service
   function directly under `platform_staff_bypass()` with no
   `tenant_context` active, the way a real such caller would.
2. `SelectedBusinessStore` (`client-admin-app`) resolved the "active
   Business" — driving nearly every business-scoped screen, including
   pre-filling the Business field on 7 create forms — from a single
   `limit=100` fetch. For a Client with more than 100 Businesses, a
   persisted `selectedBusinessId` outside that window silently fell
   back to "first Business in the page" instead of the one actually
   selected — every list screen silently re-scoped to it, and new
   records could get silently created under it. Fixed by paging through
   the full list (the backend sets no `max_limit` on
   `LimitOffsetPagination`) instead of trusting one page — the common
   case (well under 100 Businesses) is still exactly one request. Two
   new store tests prove the exact previously-broken scenario (a
   persisted id that only exists past page 1) now resolves correctly.
   Two more instances of the same "bounded fetch, `.find()` by id,
   silent fallback" pattern were found already copy-pasted into
   `super-admin-app` (`paystack-config.ts`, `settlement-runs.ts`) —
   lower severity (page-1-of-25, single-Business config screens, not a
   session-wide default) and not fixed that pass.

**Same pattern, fixed as its own follow-up slice**: those two
`super-admin-app` instances are now also fixed. Neither screen had a
single-Business GET to fall back to (`super-admin/businesses/` only
ever supported list/search, confirmed by checking
`apps/businesses/urls.py`), so the fix adds
`BusinessSuperAdminStore.findById()` — a
shared method both screens now call, paging through the full,
unfiltered cross-client list directly against the API (bypassing
`ListStore`'s own `state`/`getAll()`, so a lookup from either config
screen can never clobber `business-list.ts`'s own paginated browse
state) rather than trusting one `limit=25` page. Confirmed live: a
"Rama Craft" Business sitting past the old page-1 boundary (dev DB has
47 Businesses total) now resolves correctly on both
`paystack-config`/`settlement-runs` instead of showing "Business not
found." **`docs/adr/0005` (QR ticket signing) is now Accepted**
(2026-08-18) — Ed25519 signing over a CBOR payload with binary-packed
UUID fields, `TICKET_SIGNING_KEYS`/`TICKET_SIGNING_ACTIVE_KID`
env-var-backed key rotation extending `SECRET_KEY`'s own storage
precedent, and revocation bounded by a short `expires_at` plus a
best-effort synced revocation list rather than a real-time check a
genuinely offline validator device can't perform. This was the last
Proposed ADR. **Phase 6 (Ticketing) is now spec'd in full**
(`docs/specs/6-ticketing.md`, 2026-08-18) — a new `apps/ticketing`
app's `Ticket` model, issued automatically the moment
`mark_booking_paid()` runs, carrying the ADR-0005 signed QR payload;
an always-online `POST /trips/{id}/tickets/validate/` endpoint
extending `apps.tapngo`'s "device presents a credential, backend
resolves and records an event" shape to a signed payload instead of an
opaque DB-looked-up token; and the two ADR-0005-committed sync
endpoints (`GET /ticketing/signing-keys/`, `GET /ticketing/revoked/`).
Sliced backend-then-frontend like Phase 4/4b/5. **Slice 1 (issuance) is
now built** (2026-08-18) — `apps/ticketing`'s `Ticket` model
(`OneToOneField` to `SeatReservation`, not `Booking` — a Booking can
hold several seats, and each needs its own independently scannable
ticket, a real correction to the spec's first draft, caught before any
code shipped), `apps/ticketing/signing.py` (this backend's first
cryptography dependencies, `cbor2`/`pynacl`), `issue_ticket()` wired
into `mark_booking_paid()`, and the three `GET` read endpoints. See the
spec's own "Implementation note (Slice 1, done)" for the full account,
including two more real bugs found only by building this: (1) every
existing bare, no-default `config()` secret in `config/settings/base.py`
(`PAYSTACK_SECRET_KEY` and, it turns out, `SECRET_KEY` itself) looks
like it would crash Django settings import the moment CI runs, since
CI sets none of them as env vars and has no `.env` — `local.py`'s/
`ci.py`'s own `default=` override lines were never actually reachable
as a safety net, just redundant re-reads of values `.env` already
supplied locally; the new ticketing settings were wired to avoid
repeating this (an empty-string `base.py` default plus a hardcoded
`local.py`/`ci.py` literal, matching `ci.py`'s own existing `SECRET_KEY`
literal), while the pre-existing gap itself was flagged, not fixed,
being outside this slice's scope. (2) `apps/payments/tests/booking_helpers.py`'s
shared fixture used `TripFactory`'s own fixed-past-calendar-date
default, which broke four previously-green `apps/payments` tests the
moment ticket issuance started checking a Trip's departure time against
"now" — fixed at the fixture with a real near-future date. 497/497
backend tests passing (up from 480). **Slice 2 (validation) is also now
built** (2026-08-18) — `validate_ticket()` (mirroring `record_tap()`'s
idempotency-key-first, typed-exception shape), `POST
/trips/{id}/tickets/validate/`, and the new `ticketing.validate`
permission (seeded and granted to Manager/Staff alongside
`tapngo.record`/`tapngo.view`). **This closes Phase 6's backend arc.**
A real concurrency bug was found only by running the mandatory
concurrency test: a request racing another under the identical
Idempotency-Key could see the ticket already `boarded` by its rival and
wrongly reject itself, instead of recognizing its own successful replay
— fixed with a second, race-free `IdempotencyKey` lookup taken after
the row lock, not the `IntegrityError`-catch reconciliation
`create_booking`/`record_tap` use (there's no database constraint
backing this particular race). 511/511 backend tests passing (up from
497). **The first frontend slice, customer-app's ticket/QR view, is
also now built** (2026-08-18) — `my-bookings` gained a "View tickets"
action on any `paid` Booking, opening a new `my-bookings/:id/tickets`
screen (this workspace's first routed path param — every prior screen
was flat or passed data via `router.navigate([...], { state })`, which
doesn't survive a refresh; a ticket is a bookmarkable resource, unlike
those linear-flow steps) that calls `GET /bookings/{id}/tickets/` and
renders one QR per Ticket via the same `toDataURL()` call
`credentials`' own QR rendering already established. Built as
component-local signals plus a direct `API_CLIENT` call, not a new
`ListStore` — no small parent-scoped-list precedent existed anywhere in
the workspace, and a Booking's Tickets are a handful of rows with no
real pagination. No backend change was needed. 93/93 `customer-app`
Karma tests passing (up from 86). See the spec's own "Implementation
note (Frontend Slice A, done)" for the full account, including a real
environment gap found (not fixed) while trying to verify this live:
`docker compose build backend` times out in this sandbox pulling
`pynacl`/`django-celery-beat`'s wheels, so the backend Docker image
still predates Phase 6's `cbor2`/`pynacl` dependencies — worked around
for verification by running `uv run python manage.py runserver`
directly against the already-running `postgres`/`redis` containers
instead, but the image itself still needs a rebuild from a network with
reliable PyPI access. **The second and final frontend slice,
validator-app's validate-ticket screen, is also now built** (2026-08-18)
— **this closes Phase 6 entirely.** `validator-app` gained a second
screen mirroring `record-tap`'s component/service split exactly
(`ValidateTicketService` owns every API call, returns the same
`{ok:true;data}|{ok:false;status;message}` shape, reuses the same
generic `error.detail`-extraction — no per-typed-exception switch
needed since the backend already turns every typed exception into a
`{"detail": ...}` body), with its trip picker filtering to the
*opposite* `booking_mode` from `record-tap`'s own (`!== 'tap_and_go'`,
since only reservation-mode trips produce Tickets) and no stop picker
(a ticket's stop pair is already in the signed payload). A real design
gap was found and closed along the way: `validator-app`'s `AppShell`
had no navigation at all, justified in its own docstring by "exactly
one screen" — no longer true once this slice added a second route.
Fixed with two plain `routerLink` text links in the existing bespoke
header (still not `@layout`'s `NavShell`). 31/31 `validator-app` Karma
tests passing (up from 20). Verified over real HTTP against one of
Slice A's own real Tickets: first scan boarded it, a same-key replay
returned the identical result, a different-key replay correctly
409'd as already-boarded. See `docs/specs/` for what's
been built phase by phase and `docs/adr/`
for why. **Phase 5 (Payments, Wallet, Ledger) is now spec'd in full**
(`docs/specs/5-payments-wallet-ledger.md`), and **all three of its
backend slices are now built — Phase 5's backend arc is complete.**
**Slice 1** — the ledger foundation — is `apps/ledger`
(`LedgerAccount`/`SettlementRun`/`JournalEntry`/`JournalLine`,
implementing `docs/adr/0006`'s account taxonomy and three-line
commission-split entry exactly), `post_journal_entry()` as the sole
balanced-write path (the balance invariant is enforced in application
code and independently re-verified by a DB-wide sweep test, per
ADR-0006's own "enforced by a test, not just application logic"), and
two staff-facing read endpoints gated on a new `ledger.view`
permission. See the spec's own "Implementation note (Slice 1, done)"
for the full account, including a real RLS+JOIN interaction bug found
and fixed (a `select_related` against the RLS-protected `LedgerAccount`
table was silently dropping journal lines that reference the platform
commission account when read by an ordinary Business's staff — fixed
by reading the FK id directly instead of joining). **Slice 2** — the
actual money-moving piece — is `apps/payments` (`PaystackAccount`,
`PaymentIntent`, `WebhookEvent`; this backend's first outbound
third-party HTTP integration, `apps/payments/psp/paystack.py`) and
`apps/wallet` (a thin read layer over `apps.ledger`, no model of its
own), plus `Booking.Status.PAID` and
`apps.booking.services.mark_booking_paid()`. A passenger can now go
from `POST /payments/` through a real (mocked-in-tests) Paystack
checkout to a `charge.success` webhook that atomically posts the
three-line ledger entry, marks the `Booking` `paid`, and confirms its
held seats. See the spec's own "Implementation note (Slice 2, done)"
for the full account, including two real, non-obvious bugs found only
by running the webhook flow under real concurrency: (1) `Model.save(update_fields=...)`
silently targets zero rows when called with no active tenant context,
because Django always routes the UPDATE through `_base_manager`
(defaulting to the tenant-filtering `objects` manager) regardless of
which manager fetched the instance — this was already latent in Slice
1's own `post_journal_entry()`, just never triggered by its own tests;
fixed at the root via `BaseModel.Meta.base_manager_name = "all_objects"`,
which required one state-only (no DDL) migration per app with a
`BaseModel` subclass. (2) `apps.core.rls.platform_staff_bypass()` was
not actually safe to nest — a nested call's restore-on-exit reset the
RLS session GUCs based on the Python tenancy contextvar, which bypass
never touches, silently turning off bypass mode while an outer bypass
block was still logically open; fixed with a nesting-depth counter so
only the outermost call ever touches the GUCs. **Slice 3** — settlement
runs, the piece that actually pays a Business out — adds
`apps.ledger.services.claim_settlement_run()` (atomically creates a
`SettlementRun` and bulk-claims every unclaimed `JournalEntry` for a
Business in one period) and `apps.payments.services.trigger_settlement_run()`,
which calls it and then Paystack's Transfer API
(`apps/payments/psp/paystack.py::initiate_transfer()`, new this slice)
to actually move the money; the existing webhook handler gained
`transfer.success`/`transfer.failed` branches reconciling the outcome.
`GET`/`POST /settlement-runs/` is `IsPlatformStaff`-gated, not a
Role/Permission codename — a payout is a platform financial operation,
not client self-service. See the spec's own "Implementation note
(Slice 3, done)" for the full account, including one real bug found
only by calling `trigger_settlement_run()` directly as a service
function rather than through the HTTP endpoint: its `recipient_code`
precondition check silently saw nothing, because it read
`PaystackAccount.all_objects` with no RLS bypass GUC active — invisible
through the real endpoint only because `IsPlatformStaff` requests
already have that GUC set by `TenancyMiddleware`, the same
"only safe because of who happens to call it" fragility class Slice 2's
own bypass-nesting bug came from. Fixed by making
`trigger_settlement_run()` open its own `platform_staff_bypass()`
around its entire body, matching `process_paystack_webhook()`'s own
self-sufficiency for the identical reason. **Phase 5's backend is now
fully complete** — 470/470 backend tests passing (up from 383 before
Phase 5, 413 after Slice 1, 449 after Slice 2). **Phase 5's frontend is
being built one app at a time, stopped for review between each**, per
the same "too much in one continuous pass" risk the Phase 4 frontend
addendum already surfaced — a deliberate, explicit choice this time,
not a retroactive fix. The first slice, customer-app's payment flow, is
done: `my-bookings` (`projects/customer-app`) gained a "Pay now" action
on any `pending_payment` booking, calling `POST /payments/` and
redirecting to the returned Paystack `authorization_url`; regenerating
`api-client`'s `schema.ts` for this slice also surfaced a real,
independent regression in `client-admin-app`'s own `booking-list.ts`
(an identically-shaped exhaustive status map that stopped compiling the
moment `'paid'` became a valid `Booking.status` in the generated
types — fixed with enum coverage only, no new functionality). See the
spec's own "Implementation note (Frontend Slice A, done)" for the full
account. **The second slice, client-admin-app's payments/wallet/ledger
visibility, is also now done**: three new read-only screens —
`payments/payment-list` (`GET /payments/`), `ledger/ledger-overview`
(`GET /ledger/accounts/` + `GET /ledger/entries/`, combining a
business-clearing balance stat with the paginated journal-entry
history), and `wallet/wallet-lookup` (`GET /wallet/`, a passenger-UUID
support/dispute lookup — no search by name/email exists yet, named in
the screen itself) — gated on the existing `payments.view`/
`ledger.view`/`wallet.view` codenames, already granted to every Role
preset, so no backend change was needed. Added `shared-ui`'s first
card/stat-display component (`ui-stat`) along the way, plus three new
`IconName` entries (`banknotes`/`book-open`/`credit-card`) for the new
nav items. `SettlementRun` remains deliberately out of client-admin's
reach (`IsPlatformStaff`-gated only). See the spec's own "Implementation
note (Frontend Slice B, done)" for the full account, including a real
bug caught by the new component spec (`LedgerAccount` has no `currency`
field of its own — the balance stat's initial version read one that
doesn't exist). **The third and final slice, super-admin-app's Paystack
account config + settlement-run trigger UI, is also now done — Phase
5's frontend arc is complete.** Needed two small backend additions
(explicit user sign-off before building, since both endpoints this
slice needed already existed but had no way to *find* a Business or
*read* its current config): `GET /super-admin/businesses/` (cross-client
Business search for platform staff — `apps.businesses.views
.BusinessSuperAdminListView`, `IsPlatformStaff`-gated like every sibling
super-admin endpoint; neither the Client-scoped `GET /businesses/` nor
the kyb_status-filtered KYB queue could serve this), and `GET` added to
the existing `PaystackAccountConfigView` (returns a distinct 404 when a
Business exists but has no `PaystackAccount` row yet, so the frontend
can render "not configured" as an expected state, not an error).
480/480 backend tests passing (up from 470). Three new `super-admin-app`
screens — `businesses/business-list` (search, the new entry point),
`businesses/paystack-config` (GET-before-show, then PATCH), and
`businesses/settlement-runs` (existing-runs table + a trigger form,
branching its error handling by HTTP status same as
`wallet-lookup.ts`'s own precedent). See the spec's own "Implementation
note (Frontend Slice C, done)" for the full account, including a real
bug caught during browser verification (the "no single-Business GET,
reuse the list store" lookup pattern's fallback refetch was reusing a
stale search filter left over from a previous screen visit, so a direct
navigation after searching for a *different* Business incorrectly
reported "Business not found" — fixed; a related, accepted limitation
remains: that same fallback is still bounded by the store's own page
size, so a deep link to a Business outside an unfiltered list's first
page still won't resolve, caught live against this dev database's 145
leftover e2e-test Businesses). **Phase 4b's customer-app
credential-issuance UI, closed out as its own slice right after Phase
5's frontend arc finished** (2026-08-17), needed no backend change at
all, and **its permanent validator-app E2E spec, closed out as the very
next slice the same day, closes Phase 4b entirely** — see the paragraph
above and `docs/specs/4b-tap-and-go.md`'s own implementation notes for
the full account of both.
`docs/architecture.md` (technical) and `docs/executive-overview.md`
(non-technical) are the standing reference docs for the system as a
whole — kept up to date at the end of every phase/slice, not just at
launch. The full architecture brief and phase plan live in the
conversation history that produced this repo; `docs/adr/0001` through
`0007` capture the load-bearing decisions from it.

## How we work

1. **Spec before code.** Every phase/module gets a spec at
   `docs/specs/<phase>-<module>.md` (scope, data model, API surface, edge
   cases, failure modes, test plan, migration impact) before
   implementation starts.
2. **ADRs for architectural decisions**, including options rejected and
   why — `docs/adr/`.
3. **Thinnest vertical slice first**, then stop for review. Backend +
   frontend for one feature beats a complete backend with no consumer.
4. **Never guess on ambiguity.** Label unavoidable assumptions
   `ASSUMPTION:` in output.
5. **Self-check before declaring anything done** — `docs/self-check.md`
   defines what "done" means (backend tests, e2e, accessibility, security
   sweep, report format). Run it at the end of every module and phase;
   reports land at `docs/self-check-<date>.md`.

## Repository layout

```text
backend/    Django project — apps/ per bounded domain (see docs/adr/0001)
frontend/   Angular CLI workspace — projects/ (3 apps + shared libraries)
docs/       specs, ADRs, self-checks, UI review screenshots
.github/    CI workflow
```

### Backend apps (`backend/apps/`)

- `core` — tenancy base classes (`BaseModel`, `TenantScopedManager`,
  `TenancyMiddleware`), Postgres Row-Level Security as a second,
  independent enforcement layer (`migration_operations.EnableRowLevelSecurity`,
  `rls.set_rls_session_vars` — see `docs/specs/1-identity-client-business.md`
  §3 and `docs/adr/0002`), `IdempotencyKey`, `AuditLog` + write helper,
  health/readiness endpoints. `core/tests/testapp/` is a **test-only**
  diagnostic app (installed only under `config.settings.ci`) used to
  exercise the tenancy base classes before a real business model exists —
  delete it once one does.
- `clients` — `Client` model (tenant root) with KYC fields, plus
  `KycDocument` (the first real `BaseModel`/RLS-protected model), Client
  self-registration (`POST /clients/register/`, auto-login), the KYC
  document upload endpoint, and the super-admin KYC review queue
  (backend + API-tested only — no super-admin UI yet, that's Phase 2).
  Uploaded files go to local disk (`MEDIA_ROOT`) — S3/production storage
  is documented-but-unbuilt, same treatment Phase 0 gave AWS provisioning
  generally. Also `WhiteLabelConfig` (one-to-one per Client, RLS-protected
  — domain/branding/email-sender-identity/terms, `GET`/`PATCH /white-label/`
  gated on `whitelabel.manage`) and `ClientInvitation` (super-admin →
  prospective Client, **not** a `BaseModel` — mirrors `Permission`'s
  reasoning: no Client exists yet at invite time, so no RLS/tenancy
  scoping applies; safe to admin-register for exactly that reason).
  `complete_client_invitation()` reuses `register_client()` unchanged so
  invitation-completion and direct self-registration produce identical
  Client/User/Role state.
- `businesses` — `Business` (a Client can run several) + `KybDocument`,
  mirroring `clients`' shape exactly: create/list/patch, KYB document
  upload, super-admin KYB queue. Backend + API-tested only, same as
  `clients`. `GET /super-admin/businesses/` (`BusinessSuperAdminListView`,
  Phase 5 frontend Slice C) is a separate, unfiltered, `IsPlatformStaff`-gated
  cross-client search (optional `?search=` on name) — added because
  neither the Client-scoped list nor the KYB queue (which drops a
  Business the moment it's decided) let platform staff find an
  arbitrary, already-approved Business.
- `identity` — custom `User` model (nullable `client` FK for platform
  staff — see `docs/adr/0003`), audience-scoped JWT issuance
  (`/api/v1/auth/{customer,client-admin,super-admin}/token/`), `/me/`
  (now returns a real `permissions` array). `Role`/`Permission` (DB-backed
  RBAC — three fixed presets per Client: Owner/Manager/Staff, auto-created
  at registration) and `StaffInvitation` (invite/accept flow, backend +
  API-tested only, no UI). `apps.core.permissions.HasPermission(codename)`
  is what every `client.view`/`business.manage`/etc.-gated endpoint uses
  now — including the Slice 2/3 endpoints, retrofitted off the coarser
  `IsClientStaff` once real RBAC existed.
- `ledger` — Phase 5 Slice 1 (`docs/specs/5-payments-wallet-ledger.md`).
  The double-entry ledger every later money movement writes through:
  `LedgerAccount` (fixed `account_type` taxonomy per `docs/adr/0006` —
  `wallet`/`business_clearing`/`integra_commission`/`psp_suspense`/
  `refund_contra`; the single platform-level `integra_commission` row
  is the one deliberate exception to "every `BaseModel` row carries a
  non-null `client_id`", nullable here the same way `identity.User`'s
  `client` already is for platform staff), `SettlementRun`,
  `JournalEntry`/`JournalLine` (signed line amounts, `SUM(amount) == 0`
  per entry is the balance invariant). `apps.ledger.services.post_journal_entry()`
  is the sole write path and runs under `apps.core.rls.platform_staff_bypass()` —
  deliberately, since one entry can legitimately span two different
  Clients' books at once (a Business's clearing account and the
  platform commission account together) and since the Slice 2 webhook
  handler (below) calls it with no authenticated request behind it at
  all. `apps.ledger.services.claim_settlement_run()` (Slice 3) is the
  only other write path against `SettlementRun`/`JournalEntry.settlement_run` —
  atomically creates a `SettlementRun` and bulk-claims every unclaimed
  `JournalEntry` for a Business in one period, snapshotting the payout
  total from the claimed entries' `business_clearing`-account lines.
- `payments` — Phase 5 Slices 2–3 (`docs/specs/5-payments-wallet-ledger.md`).
  This backend's first outbound third-party HTTP integration —
  `apps/payments/psp/paystack.py` is the only module that talks to
  Paystack's API (a new `requests` dependency), kobo/minor-unit
  conversion and HMAC-SHA512 webhook-signature verification both
  confined there. **Slice 2**: `PaystackAccount` (a Business's
  payout-destination reference — Integra is the merchant of record, one
  platform-level Paystack key for every Business, per ADR-0007's own
  reasoning; `PaystackAccountConfigView` gained a `GET` alongside its
  original `PATCH` in Phase 5 frontend Slice C, returning a distinct
  404 when a Business exists but has no account row yet — the
  PATCH-only original left a config screen with no way to show
  "already configured" state), `PaymentIntent` (`psp_reference` generated server-side
  before calling Paystack, so a retry under one `Idempotency-Key` can't
  produce two different Paystack transactions), `WebhookEvent` (not a
  `BaseModel` — same "must be writable with no tenancy context"
  reasoning as `AuditLog`/`IdempotencyKey`; its own `(psp_provider,
  reference, event_type)` unique constraint is the real webhook-replay
  dedup gate). `POST /webhooks/paystack/` always returns `200` past
  signature verification (avoids Paystack retry-storms) and never lets
  an exception escape mid-processing (`TenancyMiddleware` wraps the
  whole request in one transaction — an uncaught exception would roll
  back the `WebhookEvent` row too, defeating the dedup gate on retry).
  **Slice 3**: `apps.payments.services.trigger_settlement_run()` calls
  `apps.ledger.services.claim_settlement_run()` then Paystack's Transfer
  API (`psp/paystack.py::initiate_transfer()`); the webhook handler
  gained `transfer.success`/`transfer.failed` branches resolving a
  `SettlementRun` by `psp_transfer_reference` the same way Slice 2's
  handler resolves a `PaymentIntent` by `psp_reference`.
  `GET`/`POST /settlement-runs/` is `IsPlatformStaff`-gated, not a
  Role/Permission codename — a payout is a platform financial
  operation, not client self-service. Like `process_paystack_webhook()`,
  `trigger_settlement_run()` opens its own `platform_staff_bypass()`
  around its entire body rather than relying on caller context — a real
  bug from initially skipping this is documented in the spec's own
  "Implementation note (Slice 3, done)".
- `wallet` — Phase 5 Slice 2. No model of its own — a "wallet" is just
  `ledger.LedgerAccount(account_type="wallet")`, read-only, never
  `get_or_create`'d by a view (viewing an empty wallet must not create a
  row).

Every future domain app (`network`, `scheduling`, `fleet`, `fares`,
`seating`, `booking`, `tapngo`, `ledger`, `payments`, `wallet`,
`ticketing`, ...) follows the same shape: models in `apps/<name>/models.py` inheriting
`core.models.BaseModel` for anything tenant-owned, service layer doing
the business logic (fat services / thin views), tests alongside.
**DRF generic-view gotcha specific to `TenantScopedManager`**: never
write `queryset = Model.objects.all()` as a bare class attribute on a
view — it's evaluated once at import time, before any request has set a
tenancy context, and freezes to an empty queryset forever (`Business`'s
list/patch views hit exactly this in Slice 3 — see
`docs/specs/1-identity-client-business.md` §2's implementation note).
Always override `get_queryset()` as a method instead when the queryset
is backed by `.objects` (not `.all_objects`, which is contextvar-free and
safe as a class attribute). **Same trap on serializer fields**:
`serializers.PrimaryKeyRelatedField(queryset=Model.objects.all())`
declared on a serializer class is evaluated once too (`SerializerMetaclass`
collects declared fields at class-body execution time) — Slice 4 hit this
on `Role`. Resolve the FK manually inside a `validate_<field>()` method
instead of passing `queryset=` when the manager is `TenantScopedManager`.

**`apps.core.rls.platform_staff_bypass()`** (Slice 4) is the sanctioned
way for system code with no authenticated platform-staff request (an
invitation-token lookup, seeding a fresh Client's Roles) to read/write
RLS-protected rows — it now opens its own transaction when one isn't
already active, specifically because a Celery task has no ambient
transaction and `SET LOCAL`-style GUCs vanish after one statement without
one (caught live against the real stack, not by pytest — see
`docs/specs/1-identity-client-business.md` §2's Slice 4 implementation
note). Any future system-level RLS access should go through this rather
than calling `set_rls_session_vars` directly.

### Frontend (`frontend/projects/`)

- `customer-app`, `client-admin-app`, `super-admin-app`, `validator-app`
  — the four application shells. Each has its own `src/environments/`
  (base + development + stage + production, wired via `angular.json`
  `fileReplacements` — **never hardcode API URLs**) and its own
  `login`/`home` (or equivalent) feature folders under `src/app/`.
  `validator-app` (Phase 4b, `docs/specs/4b-tap-and-go.md`) is the odd
  one out in two ways: it's an installable PWA (`@angular/pwa`
  scaffolding — `manifest.webmanifest`, `ngsw-config.json`,
  `provideServiceWorker`, disabled under `isDevMode()`) standing in for
  the still-unbuilt Flutter validator app, and it has one screen
  (`record`) instead of a multi-section console — its own `AppShell` is
  a bespoke top bar, not `@layout`'s `NavShell` (built for a
  multi-section back-office console this app doesn't have). Runs on
  port 4203 (`npm run start:validator`); signs in via the same
  client-admin JWT audience as `client-admin-app` (`tapngo.record` is an
  ordinary Role/Permission codename, not a new audience).
  `customer-app`'s `credentials` screen (Phase 4b frontend close-out,
  same spec) is this workspace's first consumer of the `qrcode` npm
  package — a passenger's own `TapCredential`s, issued/listed/revoked
  through endpoints that were already customer-app-consumable before
  this slice touched them.
- `shared-ui` — presentational components (`ui-button`, `ui-text-field`,
  `ui-alert`). Match their spacing/type/color patterns when adding more;
  this is the seed of the design language the self-check's visual
  iteration loop (§10.6) judges everything against.
- `shared-data` — `ListStore<T, TQuery>`: the base class for every future
  paginated domain store, implementing `getAll()` / `updateQuery()` /
  `changePage()` over signals. Concrete per-domain stores belong at
  `src/app/shared/data/store/<domain>.store.ts` **inside each app**, not
  in this library — extend `ListStore` there.
- `auth` — `AuthStore` (session signals, persisted to `localStorage`),
  `AuthApiService` (audience-scoped login via `AUTH_AUDIENCE` DI token),
  `PermissionsService`, `permissionGuard`, `*appHasPermission` directive.
  Phase 0's permissions are coarse (`customer:access` /
  `client-admin:access` / `super-admin:access`); real per-permission RBAC
  lands in Phase 1 without changing this shape. `WhiteLabelResolverService`
  (Slice 5) resolves `GET /white-label/resolve/` once at boot via
  `provideAppInitializer` in `client-admin-app`/`customer-app`'s
  `app.config.ts` — never blocks boot, a 404/network error just leaves its
  `clientId` signal `null`.
- `layout` — `AuthLayout` (standalone-page card shell — no `cdkTrapFocus`;
  that's for modals, not full pages, see the comment in the source),
  `ForbiddenPage`.
- `api-client` — `schema.ts` is **generated**, never hand-edited (`npm run
  openapi:generate`, checked via `npm run openapi:check`).
  `createApiClient`/`provideApiClient`/`API_CLIENT` wrap
  [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) for full
  request/response typing against the backend's OpenAPI schema.

## Commands

### Backend (`cd backend`)

```bash
uv sync                                    # install deps
uv run python manage.py migrate
uv run python manage.py runserver
uv run pytest --cov=apps --cov-report=term-missing
uv run ruff check .
uv run mypy .
uv run python manage.py spectacular --file openapi.yaml --validate   # regenerate OpenAPI spec
./scripts/check_openapi_drift.sh           # fails if openapi.yaml is stale
uv run python manage.py seed_e2e_users     # test-only fixtures for Playwright, NOT demo data
uv run python manage.py prune_e2e_test_data [--dry-run]   # dev/CI only: delete accumulated e2e cruft (never touches production)
```

Settings modules: `config.settings.{local,ci,staging,production}` — set
via `DJANGO_SETTINGS_MODULE`. `local` is `manage.py`'s default.

`pyproject.toml` sets `addopts = "--reuse-db"` for faster local
iteration. **If a full `pytest` run ever fails a large number of
seemingly-unrelated tests across many apps, all in a
permission/tenancy-shaped way, before chasing it as a regression, try
`pytest --create-db` once first.** Any test using
`@pytest.mark.django_db(transaction=True)` (real, committed
transactions — currently only `apps/seating/tests/test_seat_concurrency.py`)
flushes the *entire* reused test database after it runs, including
`RunPython`-seeded migration data (e.g. `identity_permission`) that
`flush` doesn't replay — a real gotcha caught building Phase 4 Slice 2,
documented in `docs/specs/4-fares-seating-booking.md`'s own Slice 2
implementation note. Not a CI risk (a fresh CI runner has no
pre-existing test database for `--reuse-db` to find).

### Frontend (`cd frontend`)

```bash
npm install
npm run start:customer        # :4200
npm run start:client-admin    # :4201
npm run start:super-admin     # :4202
npm run start:validator       # :4203
npm run build:all
npm run test:all              # Karma/Jasmine, all apps + libraries
npx ng lint <project>          # no combined "lint all" target; loop per project (see CI workflow)
npm run openapi:generate       # regenerate api-client/src/lib/schema.ts from ../backend/openapi.yaml
npm run openapi:check          # drift check
npx playwright test            # e2e + axe; starts dev servers itself, needs backend already up
```

Playwright's `globalSetup` seeds e2e users by shelling into the **backend
container** (`docker compose exec backend ...`) — bring up
`docker compose up -d postgres redis backend` (and migrate) before
running `npx playwright test`.

### Full stack

```bash
docker compose up          # postgres (+ btree_gist), redis, backend, celery-worker, celery-beat
docker compose exec backend python manage.py migrate
```

## Conventions (see docs/adr/0001 for the reasoning)

**Backend**: fat services / thin views. `Decimal` for money (not yet
exercised — no money-bearing model exists in Phase 0), UTC storage for
all datetimes, type hints throughout (`mypy` in CI), `ruff` for
lint+format. Tenant-owned models inherit `core.models.BaseModel` and are
never queried through anything but the default `objects` manager unless
the cross-client access is deliberate and explicit (`Model.all_objects`).
Every concrete `BaseModel` subclass's migration must also apply
`apps.core.migration_operations.EnableRowLevelSecurity(model_name)` — RLS
is a second, DB-level layer, and `all_objects` bypasses only the ORM's
filter, not it (a registry-driven test enforces this with no allowlist —
`apps/core/tests/test_row_level_security.py`). Anything that touches
`BaseModel` rows outside an HTTP request — a management command, a Celery
task — must call `apps.core.rls.set_rls_session_vars(client_id,
is_platform_staff)` itself inside an open transaction first, or every
query/write will be silently empty/rejected (RLS fails closed when the
session variables are unset). `seed_e2e_users` doesn't need this today —
it only creates `Client`/`User` rows, neither RLS-protected.

**Frontend**: Angular CLI workspace (not Nx). Standalone components (no
`standalone: true` — implicit in v20), `input()`/`output()` functions not
decorators, `ChangeDetectionStrategy.OnPush` everywhere, native control
flow (`@if`/`@for`), `host` object not `@HostBinding`/`@HostListener`,
reactive forms only, `inject()` over constructor injection, Tailwind v4
first (CDK `Dialog` for overlays — `ui-confirm-dialog`, Phase 2 Slice 3 —
and CDK `BreakpointObserver` for responsive breakpoints — `NavShell`'s
collapsible sidebar). File naming
has no `.component` suffix. Path aliases only across library boundaries
(`@shared-ui`, `@shared-data`, `@auth`, `@layout`, `@api-client`) — never
deep relative imports into another project.

## Known Phase 0 limitations (deliberate, not oversights)

- `TenancyMiddleware` still resolves tenancy from the JWT claim only, per
  request — that's unchanged and correct, RLS/`TenantScopedManager` don't
  need anything else. What Phase 1 Slice 5 closed is the *login-time* gap:
  `client-admin-app`/`customer-app` now call `GET /white-label/resolve/`
  (resolved server-side from the request's `Host` header) via
  `WhiteLabelResolverService`/`provideAppInitializer` on boot, and
  pre-fill login's `client` disambiguation field from the result — see
  `docs/specs/1-identity-client-business.md` §5. Local dev
  (`localhost:4200` etc.) has no matching `WhiteLabelConfig` domain, so
  resolution 404s and the field stays manual, unchanged from Phase 0.
  Production reverse-proxy topology for white-labeled custom domains
  (making the browser's real `Host` reach the backend unchanged) is
  still out of scope — `ASSUMPTION:`, documented but unbuilt, same
  treatment AWS provisioning got.
- Login's `client` disambiguation field itself (the request field, not
  its pre-fill) is unchanged from Phase 0 — see the docstring in
  `apps/identity/serializers.py`.
- No demo seed data / teardown command yet (nothing to seed — no business
  models exist). `seed_e2e_users` is test infrastructure only, not that
  feature.
- Postgres Row-Level Security (defense-in-depth alongside the ORM-level
  tenancy filtering) landed in Phase 1 Slice 1, applied to `TenancyProbe`
  first — see `docs/adr/0002` and
  `docs/specs/1-identity-client-business.md` §3. **The app connects as
  `integra_app`, not `integra`** — `integra` is the Postgres bootstrap
  role (a true superuser, which unconditionally bypasses RLS regardless
  of `FORCE ROW LEVEL SECURITY`, and Postgres won't let anyone strip
  `SUPERUSER` from a bootstrap role). Any direct `psql` access for
  anything other than provisioning should use `integra_app` too, or RLS
  will look enabled and do nothing. Django admin sessions
  authenticate via cookies, not the JWT `TenancyMiddleware` reads, so an
  admin request resolves as anonymous and RLS will show zero rows / reject
  writes for any RLS-protected model viewed through `/admin/` — not fixed
  yet, flagged for whenever a real model gets admin-registered.
- All four ADRs this system has needed so far are now **Accepted**:
  seat-segment concurrency (`docs/adr/0004`), QR ticket signing
  (`docs/adr/0005`, finalized 2026-08-18), ledger chart-of-accounts
  (`docs/adr/0006`), and payment partner selection (`docs/adr/0007`).
  Phase 6 (ticketing) is now spec'd in full
  (`docs/specs/6-ticketing.md`) but not yet built — no ADR currently
  blocks any phase. The standing rule remains live for whenever a
  future phase needs a new one: finalize a proposed ADR before the
  phase that needs it is spec'd, not during it.
