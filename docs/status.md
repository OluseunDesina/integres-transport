# Project status and build history

**Read this on demand, not by default.** It is the full narrative record
of what has been built, phase by phase, and the detailed account of every
cross-cutting lesson. `CLAUDE.md` carries the short version plus the
rules that actually change how code gets written; this file carries the
reasoning and the history behind them.

Reach for it when you need to know *why* something is the way it is, or
what a given phase actually shipped. `docs/specs/<n>-*.md` and their
Implementation notes remain the authoritative per-feature record;
`docs/specs/README-transit-os-adoption.md` is the roadmap.

---

## Where the system stands


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
only the outermost call ever touches the GUCs. **The same defect turned
out to exist in `apps.core.tests.tenancy.tenant_context`, found and
fixed 2026-08-27** while clearing the way for spec 10's slice 2: it
blanked the RLS session variables on exit instead of restoring them, so
any helper that opened its own `tenant_context` — notably
`apps.payments.tests.booking_helpers.booking_with_a_held_seat` — left
`app.current_client_id` NULL when it returned, and the *caller's* next
insert failed with `new row violates row-level security policy` even
though the caller's own `with` block was still open. Hard to spot
because the Python contextvars were restored correctly the whole time,
so `.objects` reads kept working and only writes broke. No depth
counter was needed: the contextvar tokens already carry the previous
state, so reading them back after the reset is correct at any nesting
depth. **If a test fails with an RLS write error inside a block that
looks correctly scoped, suspect a nested helper first.** **Slice 3** — settlement
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


---

## Backend apps, in detail

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
- `incidents` — spec 17 (`docs/specs/17-incidents.md`). `Incident` +
  `IncidentActivity`, both RLS-protected. One model, two entry points:
  `POST /incidents/` (operator, `incidents.manage`) and
  `POST /incidents/report/` (passenger, `IsAuthenticated` — passengers
  have no Role, and the endpoint carries this backend's first non-auth
  **POST** throttle scope, `incident_report`). Both are idempotent
  through `apps.core.idempotency`.
  `apps.incidents.services.transition_incident` is the **sole write
  path for `status`**, with the lifecycle as one explicit table; a
  `PATCH` naming `status` is a 400 pointing at the transition endpoint
  rather than a silent drop. `GET /incidents/mine/` returns a
  **separate reduced serializer**, not a field-exclusion list — an
  exclusion list is one careless edit from leaking a staff note on a
  safety report back to the passenger who filed it.
  `apps.incidents.models.OPEN_STATUSES` is shared with
  `apps.analytics`' dashboard count, so the queue and the stat above it
  cannot disagree about what "open" means. Its filters are a dedicated
  `IncidentListQuerySerializer`, **not** an extension of
  `apps/analytics/filters.py` — that module's `status` already means a
  PaymentIntent status and `booking_status` already exists because one
  field cannot validate two enums.
- `wallet` — Phase 5 Slice 2. No model of its own — a "wallet" is just
  `ledger.LedgerAccount(account_type="wallet")`, read-only, never
  `get_or_create`'d by a view (viewing an empty wallet must not create a
  row).

Every future domain app (`network`, `scheduling`, `fleet`, `fares`,
`seating`, `booking`, `tapngo`, `ledger`, `payments`, `wallet`,
`ticketing`, `incidents`, ...) follows the same shape: models in `apps/<name>/models.py` inheriting
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


---

## Frontend projects, in detail

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
  the still-unbuilt Flutter validator app, and it has three narrow
  screens (`record`, `validate-ticket`, and spec 17 slice 3's
  `report-issue`) instead of a multi-section console — its own
  `AppShell` is a bespoke top bar, not `@layout`'s `NavShell` (built for
  a multi-section back-office console this app doesn't have). Only the
  third nav link is permission-filtered: the first two rest on
  `tapngo.record` and `ticketing.validate` always being granted
  together, which is not true of `incidents.manage`. Runs on
  port 4203 (`npm run start:validator`); signs in via the same
  client-admin JWT audience as `client-admin-app` (`tapngo.record` is an
  ordinary Role/Permission codename, not a new audience).
  `customer-app`'s `credentials` screen (Phase 4b frontend close-out,
  same spec) is this workspace's first consumer of the `qrcode` npm
  package — a passenger's own `TapCredential`s, issued/listed/revoked
  through endpoints that were already customer-app-consumable before
  this slice touched them. Spec 17 slice 3 adds `report-issue` and
  `my-reports`, and with them this app's only use of
  `navigator.geolocation` — behind `shared/geolocation.ts`, so its three
  refusal paths are testable and so nothing ever infers a position.
- `shared-ui` — presentational components (`ui-button`, `ui-text-field`,
  `ui-alert`). Match their spacing/type/color patterns when adding more;
  this is the seed of the design language the self-check's visual
  iteration loop (§10.6) judges everything against.
  **Adding a table?** `ui-table`'s docstring carries the
  responsive-column convention every list in all four apps follows —
  secondary columns take `hidden md:table-cell` and their values
  re-flow into a `md:hidden` sub-line, the class goes on the `<th>`,
  its `<td>` *and* the skeleton `<td>` (missing one shifts every later
  value under the wrong heading, silently), and cells never set their
  own `px-*` because the component shrinks that padding on a phone.
  Call `expectColumnVisibilityParity` from the list's spec;
  `e2e/responsive-tables.ts` measures the result at real widths.
- `shared-data` — `ListStore<T extends {id: string}, TQuery>`: the base
  class for every future paginated domain store, implementing
  `getAll()` / `updateQuery()` / `changePage()` over signals, plus
  `findByIdPaged(id, query)` — the one lookup every detail/edit screen
  must use to resolve a record by id (see the note further down; the
  `T extends {id: string}` bound exists for it). Concrete per-domain
  stores belong at `src/app/shared/data/store/<domain>.store.ts`
  **inside each app**, not in this library — extend `ListStore` there,
  and expose a `findById()` that passes the scope it means.
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
  **`authMiddleware` attaches `Authorization` to every request and
  refreshes it on a `401`** (`docs/specs/13-session-resilience.md`),
  wired in each app as
  `provideApiClient(environment.apiBaseUrl, () => [authMiddleware()])`.
  **No call site attaches an auth header** — the single exception is
  `AuthApiService.fetchCurrentUser`, which passes a token not yet in the
  store, and the middleware never overwrites an explicit header. Adding a
  hand-written `Authorization` anywhere else re-creates the stale-token
  bug the 107 removed attachments had (a header captured before a refresh
  goes out dead). Three traps recorded there and worth knowing before
  touching it: the anonymous-path list is **prefix-matched**, so an entry
  can silently swallow an authenticated sibling; `options.fetch` must be
  called **bare**, never as `options.fetch(...)`, or the browser rejects
  it with `Illegal invocation` (no unit test catches this); and
  `permissionGuard` cannot cover a mid-session logout, because it runs at
  route *activation*, so the middleware navigates to `/login` itself.
- `layout` — `AuthLayout` (standalone-page card shell — no `cdkTrapFocus`;
  that's for modals, not full pages, see the comment in the source),
  `ForbiddenPage`.
- `api-client` — `schema.ts` is **generated**, never hand-edited (`npm run
  openapi:generate`, checked via `npm run openapi:check`).
  `createApiClient`/`provideApiClient`/`API_CLIENT` wrap
  [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) for full
  request/response typing against the backend's OpenAPI schema.
  `provideApiClient(baseUrl, middlewareFactory)` takes its middleware as
  a **factory**, not an array, so the factory body runs in an injection
  context — which is what lets `@auth`'s `authMiddleware` call
  `inject(AuthStore)`.


---

## Marketplace redesign (spec 24) — the reasoning

Full record: `docs/specs/24-marketplace-redesign.md` (slice 1 done,
slice 2 next). What follows is the *why* that spec's Implementation note
only points at.

**Why a survey, not one site.** Slice 1 was first drafted against
Wakanow alone, because spec 22 had named it. The product owner widened
the brief the same day: the right baseline is aggregators of *travel and
mobility options*, not one flight/hotel shop. Six were studied —
Omio, Busbud, FlixBus, Rome2Rio, BuuPass (the closest market analogue:
an African multi-operator bus site), Wakanow — plus Treepz, dropped
because it has pivoted to corporate travel. Landing pages were observed
live; results pages could not be (Busbud and FlixBus hand search to a
partner or a new tab), so results patterns come from known behaviour of
those products and the spec says so.

**What the survey changed.** The Wakanow draft's two-row search card
became Omio/Busbud/FlixBus's single segmented bar; recent searches,
a payment-methods line under search (BuuPass), "My bookings" for guests
(Omio, FlixBus), and Cheapest/Fastest badges on results (Rome2Rio, Omio)
were added. The navy hero survived because the survey splits on it
(Busbud and Omio light, Wakanow and FlixBus dark or photographic) — a
brand choice, not a baseline.

**What it could not change, and why.** The patterns *every* aggregator
shares that we lack — popular routes, seats-left, an operator wall,
city → stop grouping in suggestions — are all data problems, not UI
ones: stop suggestions are alphabetical, search results carry no
availability, and there is no marketplace operator list. Building any of
them on today's API would mean hard-coding or inventing, which spec 24
rules out. They are the obvious backend follow-ups; see `docs/traps.md`'s
known-gaps entry.

**Two traps worth the time they cost** (one-liners in `docs/traps.md`):
the shell's first per-route layout switch put two `<router-outlet>`s
behind an `@if`, and read `ActivatedRoute.firstChild` during
construction — both blanked the app with the same router error. One
outlet with a conditional wrapper class, read from
`router.routerState.snapshot`, fixed it.

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
- All eight ADRs this system has needed so far are now **Accepted**:
  monorepo structure, tenancy enforcement, PK/user-model strategy,
  seat-segment concurrency (`docs/adr/0004`), QR ticket signing
  (`docs/adr/0005`, finalized 2026-08-18), ledger chart-of-accounts
  (`docs/adr/0006`), payment partner selection (`docs/adr/0007`), and
  open-seating capacity enforcement (`docs/adr/0008`, 2026-08-26).
  **No ADR currently blocks any phase.** The standing rule remains
  live for whenever a future phase needs a new one: finalize a
  proposed ADR before the phase that needs it is spec'd, not during it.
  `docs/adr/0008` is worth knowing about beyond its own phase: it is
  the first concurrency invariant in this system that **no database
  constraint enforces** (Postgres can express "no two ranges overlap",
  as ADR-0004 does, but not "no more than N overlap"), so a
  `select_for_update()` on the `Trip` row in application code is the
  only line of defence. Every write path to open-seating tickets must
  therefore go through the one service function that takes that lock —
  there is no constraint to catch a path that forgets.
- **Phase 11 (KYB directors) is built and self-checked** —
  `docs/specs/11-kyb-directors.md`,
  `docs/self-check-2026-08-26-spec11.md`,
  `docs/ui-review/11-kyb-directors/`. Worth knowing beyond its own
  phase, because its self-check surfaced defects that live outside it:
  - **`ui-text-field`/`ui-select` render a validation error only when
    the parent binds `[invalid]` and `[errorMessage]`.** They do not
    read their own control's validity. A form that binds neither
    silently does nothing on an invalid submit. Check any new form
    against a *rendered* assertion, not just "the POST didn't happen" —
    that is exactly what let this one ship.
  - **The "bounded fetch, `.find()` by id, silent fallback" family is
    now fixed once, for every store.** `ListStore.findByIdPaged`
    (`@shared-data`) is the single implementation: it checks the loaded
    page, then pages via the store's own `fetchPage`, and deliberately
    never touches `state` so a detail-screen lookup cannot clobber the
    list screen's pagination. Concrete stores expose a thin `findById()`
    that **passes the scope explicitly** — never `this.query()`, since
    inheriting a leftover filter is itself a recorded bug. Adopted by
    all seven affected `client-admin-app` screens (`driver-form`,
    `vehicle-type-form`, `schedule-form`, `stop-form`, `vehicle-form`,
    `route-form`, and `seat-map`, which was worse: a bare `computed()`
    over shared root-store `items()`, so another screen paginating that
    store made this one's record silently `null` mid-session). The two
    hand-written predecessors (`BusinessStore`,
    `BusinessSuperAdminStore`) now delegate to it too. **Any new
    detail/edit screen must use it** rather than re-deriving the
    bounded-page shape an eighth time.
  - **`prune_e2e_test_data` structurally cannot clear the KYB/KYC review
    queues.** `KybDocument.business` is `on_delete=PROTECT` and a queue
    row has a document by definition, so every submitted Business is
    skipped as protected (measured: 28 deleted, 46 skipped, queue
    unchanged at 36). The queue therefore grows with every e2e run;
    `kyb-queue.spec.ts` pages to its fixture rather than assuming page
    1. Note too that the command's "only touches the e2e Client"
    guarantee does not separate fixtures from real work done while
    signed in as that account — its dry run listed two hand-built
    businesses for deletion. **Read a dry run before running it.**
  - **`booking-list`'s trip dropdown still cannot reach recent trips**
    (`limit=100` against ascending `Trip.Meta.ordering`, so a Business
    with >100 trips offers its oldest hundred). Its e2e test
    (`bookings.spec.ts`) is left **failing rather than skipped**.
  - **Run every Playwright project, not just the one you changed.**
    `customer-app`'s suite had been red since the tap-and-go fixture
    landed (the route `<select>` gains an em-dash-plus-operator suffix once
    the browse endpoint spans more than one Business, which that
    fixture guarantees) and nobody had run it. Fixture lookups that
    page rather than trusting one bounded page now live in
    `frontend/e2e/fixture-lookup.ts`.
  - **The four e2e projects interfere when run together** — a bare
    `npx playwright test` fails 3 specs that pass per-project, because
    `super-admin`'s `kyc-queue` approves the shared KYC fixture that
    `client-admin`'s `kyc-status` expects `submitted`, and the booking
    specs contend for the same fixture seats. Run with `--project=…`.
- **Phase 12 (fare matrix) is now built, backend and frontend**
  (`docs/specs/12-fare-matrix.md`, both Implementation notes;
  `docs/ui-review/12-fare-matrix/`). No data model change — it made an
  existing, tested, unreachable feature reachable. Three things from it
  matter beyond its own phase:
  - **`apps/fares/matrix.py` orchestrates and never writes.** Every
    mutation goes through `apps/fares/services.py`, which owns the
    close-and-supersede dance keeping the half-open
    `[effective_from, effective_to)` timeline gapless and the GiST
    exclusion constraint satisfied. A bulk editor that touched `amount`
    directly would silently destroy the price snapshot a historical
    `SeatReservation` points at. Any future bulk editor over a
    versioned model should copy this split, not the shortcut. The one
    new service function, `close_fare_segment_rule()`, closes a rule
    with **no** successor — "stop selling this segment", not a delete.
  - **The grid submits only edited cells, not the whole matrix**, even
    though the endpoint accepts and correctly skips a full submission.
    Sending every rendered cell would let a stale `null` for an
    untouched cell *close* a rule another operator created while the
    grid was open — a destructive write from a cell nobody looked at.
  - **`ui-select` now has a `hint` input** (wired through
    `aria-describedby`, and carrying both hint and error ids when
    invalid), and **`ui-alert` a `warning` variant**. Use the hint for
    guidance that is not inferable from the option labels rather than a
    loose `<p>` beside the control, which only sighted users get.
- **Phase 10 (`docs/specs/10-booking-modes.md`) is complete — all four
  slices** — see its four Implementation notes and
  `docs/ui-review/10-booking-modes/`. 690/690 backend tests pass.
  **No phase is now unbuilt.** Six things from it matter beyond its own
  phase:
  - **Capacity counts issued tickets only.** A product decision
    superseded ADR-0008 mid-phase: unpaid bookings hold nothing, so N
    passengers can each be told there is room, all pay, and the
    departure oversells. The `Trip` row lock's job is now a consistent
    count plus one `trip.oversold` audit record per crossing — not
    prevention. **The remedy has no code path**: there is no refund
    service and `apps/wallet/services.py` is read-only, so acting on a
    `trip.oversold` record is manual today.
  - **`GET /trips/{id}/availability/` returns an envelope**
    (`{booking_mode, status, seats, capacity_remaining,
    seat_selection_enabled}`), because the old bare array made "no
    vehicle assigned" and "every seat taken" indistinguishable. Branch
    on `status`, never on the seat list being empty — that inference is
    the original defect. `seat_selection_enabled` here is **not** the
    Business field of that name: it answers "may a passenger pick a
    seat on *this trip*", so it is always false for open seating, which
    has no seats to pick.
  - **Quick book** (`Business.seat_selection_enabled = false`, in
    reservation mode) means `POST /bookings/` takes `passenger_count`
    and allocates free seats server-side. The flag is read **live off
    the Business**, not snapshotted onto the Trip like `booking_mode`
    and `fare_collection_mode` — those describe what was sold, this
    only describes how a seat is picked. Allocation order is explicit
    (row, column, seat number) because `Seat.Meta.ordering` is
    `-created_at`, which would scatter a group across the vehicle.
  - **A tap credential is universal fare media.** On a prepaid trip,
    `POST /trips/{id}/tickets/validate/` accepts `token` instead of
    `payload` and boards the Ticket that passenger already holds — one
    tap per ticket, oldest first, so group bookings stay boardable. It
    must **never** open a `FareJourney`; the tests assert that absence,
    not just the status code.
  - **A `computed()` over a plain form-control value depends on no
    signal**, so it caches its first result forever. Both validator
    screens carried this for months and their trip-detail line never
    rendered; unit tests passed against it because Karma happens to
    leave the computed dirty, while a real browser does not. Use
    `toSignal(control.valueChanges)`, and assert **rendered** output.
  - **`ui-toggle` renders no text of its own**, so a `<p>` beside it
    reaches sighted users only. Pass its id as `describedBy` — the same
    rule `ui-select`'s `hint` already carries, found again in this
    phase's visual pass.
  - **The passenger nav collapses at 390px**, the authoritative
    customer-app viewport: links wrap and overlap and the header forces
    horizontal overflow. Recorded in
    `docs/ui-review/10-booking-modes/iteration-1.md`; Spec 17 slice 3
    measured it rather than fixing it (seven labels come to 554px in a
    459px nav at 768px, so it wraps there too) and left the rest to
    spec 21. **Fixed in spec 21 slice 1**: below `sm` (640px) the nav
    moves to a fixed bottom tab bar instead of growing the top row
    further; see that spec's own entry below.
- **Spec 18 (manifest and staff booking) slice 1 — the trip manifest —
  is built** (`docs/specs/18-manifest-and-staff-booking.md`, its
  Implementation note). `GET /trips/{id}/manifest/`, a `manifest` CSV
  export and the `client-admin-app` screen that reads them: a
  composition over five apps that already held every field and none of
  which assembled them. **1052/1052 backend tests**, 1470 frontend unit
  tests. Four things from it matter beyond its own spec:
  - **A spec can be written against a data model that does not exist.**
    This one's response envelope named a `booking_reference` and a
    `ticket_reference`. Neither field existed, and **no screen in any of
    the four apps showed an identifier for either model** — so a
    passenger had nothing to quote on the phone and a manifest had
    nothing to print, which is a product gap the spec's own "Data model
    changes: None" concealed rather than settled. Two of its other
    claims were also false: there is no trip detail screen to reach a
    manifest from, and its non-goal that the existing CSV export covers
    the need is wrong for pay-as-you-go, which has no `Booking` rows at
    all and therefore exports as a blank file. All three were checked
    **before** planning; none was discovered halfway through building.
  - **A savepoint can be load-bearing for a second reason.**
    `apps/incidents` wraps its reference-collision retry in a nested
    `transaction.atomic()` because an `IntegrityError` poisons the outer
    transaction. `create_booking` needs it for that *and* because its
    own `except IntegrityError` exists to reconcile an idempotency-key
    race — without the savepoint a reference collision would escape into
    that handler and be reported as a duplicate submission, which it is
    not. The same pattern, one more reason, in the second place it was
    used.
  - **A plain-dict response is where the `Decimal` trap actually
    bites**, and this endpoint's own test caught it: `fare` came back as
    `Decimal('300.00')` where the generated `schema.ts` promises a
    string. Rows now render through the serializers the schema is built
    from. The envelope's `results` is a discriminated union too, rather
    than the `{[key: string]: unknown}[]` that
    `ListField(child=DictField())` produced — an untyped bag defeats the
    point of a generated client.
  - **A refusal should be declared, not buried in the code that
    refuses.** The `manifest` export cannot run without a trip. Checking
    that inside its row builder would have forced the registry-driven
    export tests to carry an allowlist of resources to skip — and a
    skipped resource is an uncovered one. `ExportSpec.required_filters`
    makes it data the tests read, so the next such resource is handled
    without anybody remembering to.

- **Spec 18 slice 2 — staff booking — closes the spec.**
  `booking.manage` (Owner and Manager only; its grant migration reached
  **758/758** existing roles and 0 Staff), `GET /passengers/lookup/`,
  `POST /bookings/staff/` with an optional wallet settlement, and a
  four-step counter-booking screen. **1081/1081 backend tests**, 1506
  frontend unit tests, client-admin e2e 118 → 121. Four things from it
  matter beyond its own spec:
  - **The same spec named a second field that does not exist.** Slice 1
    caught `Booking.reference` and `Ticket.reference`; slice 2 caught a
    `?phone=` passenger lookup, where `identity.User` has **no phone
    number at all** and no registration path collects one. Adding the
    column would have shipped a lookup field empty for every account
    that exists and filled by nothing — and it would fail as "not
    found" rather than "not supported", which is strictly worse than not
    offering it. The lesson is not "specs contain errors"; it is that
    checking the model before planning caught both cheaply, and neither
    would have been cheap to find mid-build.
  - **A new endpoint can be a capability an old screen already
    documented as missing.** `client-admin-app`'s wallet-lookup screen
    has carried its own limitation in its docstring since spec 5:
    `GET /wallet/?business=&passenger=` takes a passenger UUID, and
    there was no way to obtain one, so the screen only worked if a
    support ticket happened to quote it. `GET /passengers/lookup/` is
    exactly that capability. Gating it on `booking.manage` alone — as
    the spec proposed — would have left the screen broken for every
    Staff user, who hold `wallet.view` and deliberately not the other;
    so it accepts either codename, which is a real widening of who can
    confirm an address is registered and was taken knowingly. Worth
    reading a new endpoint against the screens that already exist, not
    only against the feature commissioning it.
  - **A rule can be true of the filter and false of the result.**
    `apps.booking.manifest` said in a comment that `pending_payment` was
    deliberately not excluded — and it was not, from the *filter*. But
    the manifest was built over `Ticket`, and **a ticket is issued at
    payment**, so a booking that was never paid for had no row to filter
    in the first place. Slice 1's test missed it by manufacturing a
    ticket and then forcing the booking back to unpaid, so it only ever
    proved a *ticketed* row survives the status filter: assert the
    invariant, not the example. It stayed invisible for a whole slice
    because nothing routinely created unpaid bookings — and slice 2
    makes them ordinary, since **there is no cash account in the ledger**
    (ADR-0006) and an unpaid counter booking is the normal outcome of
    selling at a desk. An agent who sold a seat and could not then see
    it on the manifest is precisely the double-sell that rule exists to
    prevent.
  - **An `effect` that calls a store without `untracked` can freeze the
    browser.** The signal reads inside a store method become
    dependencies of the effect that called it, so the store's own write
    re-invalidates that effect and it calls the store again — an
    infinite *synchronous* loop, which is not an error anywhere. It
    presents as a blocked main thread: `page.url()` answers instantly
    while `page.evaluate` times out. `trip-list` already wrapped these
    calls; the pattern is not decoration.

- **The self-check stopped running, and nobody noticed for seven
  specs.** `docs/self-check.md` has said "run at the end of every module
  and every phase" since Phase 0, and the last report is
  `docs/self-check-2026-08-26-spec11.md` — specs 12 through 18 shipped
  without one, including the ledger-touching staff booking. The rule
  existed; what it lacked was anything that made its absence visible,
  since a spec could be closed, documented and merged with nothing
  asking for the report. CLAUDE.md rule 5 now says a spec is not closed
  until its report exists, and names the last one so the gap is countable
  rather than notional.

  The second half is worse, because it degrades silently in **both**
  directions. Nothing required a report to re-read its predecessor, so
  the spec-11 findings simply stopped being looked at: `F6` (the trip
  dropdown that could only reach a Business's oldest hundred trips) was
  **fixed** by spec 14 slice 3b, and CLAUDE.md went on telling every new
  session it was a known-red with a deliberately-failing test for four
  more specs — a rules file asserting something false about the code.
  Meanwhile `F7` (no search on the KYB queue), `F9` (the 390px icon
  rail) and `F10` (an approved business rendering every document as
  pending) sat untouched since August, not because anyone decided to
  carry them but because no later report mentioned them. `self-check.md`
  §10.7 now opens with the previous report's open findings, re-verified
  and marked closed / still open / deliberately carried. **A finding
  that nobody re-reads is a finding nobody owns.**

  The catch-up pass this created — `docs/self-check-2026-09-07-specs12-18.md`
  — closed `F10`: `decide_business_kyb`/`decide_client_kyc` set the
  parent's status but never touched the document rows, so `status`,
  `reviewed_by` and `reviewed_at` sat at their `pending` defaults
  forever. Fixed by bulk-updating every still-`pending` document to the
  decision's outcome inside the same locked transaction, scoped to
  `pending` only so a document from an earlier rejected round keeps its
  own history rather than being relabelled by a later approval. `F7`
  and `F9` are unchanged (new functionality and a deliberate deferral to
  spec 21, respectively); `F6c` and the Playwright/visual-loop coverage
  are carried as unverified this pass rather than re-run — see that
  report's named 5% for why and what closing them would take.

- **Spec 17 (incidents) is complete, all three slices**
  (`docs/specs/17-incidents.md`, its three Implementation notes). New
  `apps/incidents`: one `Incident` model with two entry points (operator
  queue, passenger report) plus an append-only `IncidentActivity` trail,
  eight endpoints, both codenames on all three role presets; then the
  operator queue, form and detail screen in `client-admin-app`; then the
  reporter UI — `customer-app`'s report form and history, and a
  `validator-app` screen for a conductor to file against the trip they
  are working. **1022/1022 backend tests** (up from 920) and **1446
  frontend unit tests**. Slice 1's own lessons follow; slices 2 and 3
  add three more worth carrying:
  - **Slice 3 needed no backend change at all**, and that was verified
    before planning rather than discovered afterwards. Both passenger
    endpoints had shipped in slice 1 with **zero frontend callers**,
    which is exactly why the operator queue could only ever contain what
    operators had typed into it themselves. A backend slice that ships
    an endpoint nobody calls is half a feature, and the half that is
    invisible.
  - **A value derived for one screen is not automatically right on
    another.** `passenger_report_title` exists so the operator queue's
    first column is not a list of blanks. Rendered on the reporter's own
    screen it printed "Passenger report: Hardware" beside a Category
    column reading "Hardware" — the category twice, prefixed with the
    one fact that screen already establishes. The visual pass caught it;
    reading the code would not have, because both halves are correct in
    isolation.
  - **Two layout regressions, both measured rather than guessed.** The
    validator header reached four rows at 390px when a third nav link
    landed — but the cause was that the nav's `w-full` had always
    resolved against a nested `flex-1` wrapper rather than the header
    (**193px, not 358**), so two links had never fitted either. And the
    passenger nav wrapped at 1200px: six labels are 556px in a 587px
    nav, a seventh takes it to 656px. Shortening three labels brought it
    to 554px. Measuring first is what turned "add a link and it looks
    broken" into two specific numbers and two specific fixes.
  Seven things from slice 1 matter beyond its own spec:
  - **A seed migration grants a codename to nobody, and the debt was
    much larger than the one case already recorded.** Measured live
    before `identity/0021`, across 331 roles of each preset:
    `ledger.view` held by **201**, `notifications.view` **192**,
    `ticketing.validate` **194** — roughly 40% of every Client's roles
    could not reach three shipped features, with no error anyone would
    read as a permissions gap. All three are 331/331 now. **That
    backlog is closed; do not reopen it by shipping a seed without a
    grant.** A blanket backfill was only safe because **no API path in
    this system edits a Role's permissions** (`RoleListView` is a
    `ListAPIView` and is the only role endpoint) — check that again
    before ever writing another one.
  - **`identity.User` is the one relation the tenant-scoped-manager
    trap does not cover.** It is not a `BaseModel` (ADR-0003 —
    `client` is nullable for platform staff), so `User.objects` is the
    plain unscoped manager and resolving a user id through it will
    happily find another Client's staff. Any serializer taking a user
    id must filter `client=` explicitly. Spec 17's own edge-case table
    asserted the opposite and was wrong.
  - **drf-spectacular names a colliding `status` enum after a hash of
    its own choice set** — `StatusD05Enum` and eleven siblings ship
    today. That name is what `schema.ts` exports, so *adding a value to
    an enum silently renames the type a frontend imports*. Name any new
    one in `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]` at birth; it
    needs a **module-level** constant, since the setting resolves a
    dotted path with `import_string`, which cannot walk into a nested
    class.
  - **A state machine's "clear the timestamp" rule keys on the
    destination, not the origin.** `resolved -> closed` and
    `resolved -> investigating` share an origin and mean opposite
    things; keying on the origin alone wiped `resolved_at` when an
    incident was merely filed away, losing the only record of when the
    fault was actually fixed.
  - **Assert the property, not a magic query budget.** A
    `django_assert_max_num_queries(N)` drifts with unrelated middleware
    changes *and* still passes an N+1 that only appears at scale.
    Comparing two real requests — one row against twelve — fails the
    moment a row costs a query, which is the thing actually worth
    guarding.
  - **Notification fan-out is one row per staff user.** Any new trigger
    has to answer "what happens when this fires two hundred times in an
    hour" before it ships. Incidents notify only at `high`/`critical`
    and on escalation to `critical`, deliberately narrower than that
    spec's own text.
  - **`apps/analytics/tests/test_exports.py` no longer uses
    `incidents` as its canonical unknown export resource** — that
    domain is real now and deliberately ships no export. It uses
    `not-a-resource`. Adding any export resource stays a deliberate
    act.
- **Naming, settled and not to be "fixed":** the *credential* is still
  called Tap & Go (`customer-app`'s `credentials` screen, the
  `seed_e2e_users` fixture) because that half genuinely stayed
  universal. The *fare model* is Pay as you go (client-admin's nav and
  journey list). The `/tap-go` route path is left alone deliberately.
- **Spec 15 (trip classes) is complete — all three slices** —
  `docs/specs/15-trip-classes.md` and its three implementation notes,
  plus `docs/ui-review/15-trip-classes/`. Premium / Exclusive /
  Standard / Mini, as a `Business.TripClass` enumeration plus five
  columns; no new table. 799/799 backend tests (up from 745), 496
  `client-admin-app` and 187 `customer-app` unit tests. Nine things
  from it matter beyond its own spec:
  - **A serializer `default=` makes drf-spectacular emit the field as
    *required* in the generated `schema.ts`.** DRF treats
    `ChoiceField(required=False, default=X)` as optional; the generated
    frontend type does not, and four existing call sites stopped
    compiling. Use `required=False` with **no** `default=` and let the
    service function own the default — one default, in one place.
    `RouteCreate.code` has carried this quirk unnoticed since Phase 3.
  - **A `blank=True` model field with `choices` loses the blank when a
    ModelSerializer infers it.** `FareRule.trip_class` generated as the
    four classes with no `""`, while every row in the database returns
    `""` — a type that was wrong about 100% of rows, and invisible until
    something consumed it. Declare such a field explicitly with
    `allow_blank=True`.
  - **The fare wildcard is `""`, never NULL.** Postgres `=` does not
    match NULL to NULL, so `trip_class WITH =` in the GiST exclusion
    constraint would silently permit the exact duplicate it exists to
    prevent. `get_fare()` resolves exact-class-then-wildcard via
    `order_by("-trip_class")`, which works only because any non-empty
    value sorts before `""` under DESC — "tidying" that to ascending
    would make every classed trip quote the wildcard price, silently.
    Its own test asserts the clause directly for that reason.
  - **`get_fare()` inherits the wildcard; `apps/fares/matrix.py` does
    not.** The grid filters its class exactly, so an inherited price
    renders as an empty cell. Showing the inherited amount would make a
    save supersede a rule the operator never looked at — the same blast
    radius spec 12's "submit only edited cells" rule exists to contain.
    `?trip_class=` is consequently **required** on
    `GET`/`PUT /routes/{id}/fare-matrix/`; a missing one is a 400.
  - **Narrowing a `<select>`'s options does not move the value into
    them.** A control still holding `standard` while the route offers
    Premium alone renders a select with no matching option: it *looks*
    empty, keeps its old value, and 400s on submit. Both
    class-narrowing forms carry a reconciliation `effect` for this.
    Found by an e2e spec while every unit test was green.
  - **`patchValue` applies an explicit `undefined`** rather than
    skipping the key. Every field in this feature has a model default,
    so DRF marks it `required=False` and the generated read type admits
    `undefined` — patching that into a required control blanks it and
    makes the form silently unsubmittable. Guard with `?? <default>`.
  - **Tailwind draws `::placeholder` at `currentColor` 50%**, which
    over a standard field measures **2.64:1** — under WCAG 1.4.3's
    4.5:1. Fine for a hint, not for a placeholder carrying information:
    the fare grid's inherited amount needed `placeholder:text-muted`
    (4.76:1) plus `placeholder:italic`, so the distinction is not
    carried by contrast alone. Any placeholder that *says something*
    needs the same treatment.
  - **`await locator.count()` does not retry; `expect(…).toHaveCount()`
    does.** A bare `count()` straight after an action resolves against
    the pre-action page — slice 3's own e2e reported zero departures on
    a page that had eleven. A `count()` inside a Playwright assertion is
    a race wearing an assertion's clothes.
  - **A new field on `booking-draft.ts`'s router-state shapes must be
    optional, and `booking-confirm.returnToSeatPicker` must be updated
    by hand.** Those guards run against `history.state`, so a passenger
    mid-booking across a deploy carries an object written by the old
    build; a required field fails the guard and bounces them to
    `/search` with a half-made booking behind them. And that function
    rebuilds the request field by field rather than spreading it, so a
    new field is silently dropped on Back unless added there too.
- **Spec 16 (operational analytics) is complete — all four slices** —
  `docs/specs/16-operational-analytics.md` and its four implementation
  notes, plus `docs/ui-review/16-operational-analytics/`. Slice 1 was backend-only with no endpoint:
  `PaymentIntent.channel`, `Trip.actual_departure_at`/`actual_arrival_at`,
  eight composite indexes, and the `analytics.view` codename (Owner and
  Manager, **not** Staff — revenue totals are a different sensitivity
  from the operational lists Staff needs). Slice 2 added `apps/analytics`
  — a **models-free read layer**, the `apps/wallet` shape — with one
  shared filter module and four read-only endpoints (dashboard,
  revenue, payments summary, per-trip performance). Slice 3 added
  `@shared-ui`'s `ui-chart` and replaced `client-admin-app`'s `home`
  with a real dashboard at the same path. Slice 4 added the revenue,
  transactions and per-trip performance screens plus
  `GET /exports/{resource}/` — seven CSV resources, this backend's first
  non-JSON response and this frontend's first file download. **920/920
  backend tests, 1313 frontend unit tests.** **No slice of spec 16
  remains.** Twenty things from them matter beyond their own spec:
  - **Neither field can be backfilled, which is why the slice shipped
    alone.** Paystack's `channel` exists only in the body of the
    `charge.success` webhook that reports the charge, and
    `status_changed_at` is one mutable field every transition
    overwrites — verified live, a Trip that completes has its departure
    time only because `actual_departure_at` is a separate column. Any
    future field of this shape should ship the same way: early, on its
    own, before the feature that reads it.
  - **Nothing in the Paystack webhook path may raise.**
    `process_paystack_webhook` runs inside `TenancyMiddleware`'s single
    request transaction, so an uncaught error rolls back the
    `WebhookEvent` dedup row and silently defeats replay protection on
    the next identical delivery. `_channel_from_payload` therefore
    type-checks every layer and truncates rather than failing — losing
    a reporting label must never cost a payment. Anything new read out
    of a webhook body follows that.
  - **`PaymentIntent.channel` is free text, not `choices`.** It is a
    value another company controls; a choice-validated column that
    rejected an unrecognised one would drop the data it exists to
    capture. Blank means "not captured" and must report as `unknown`,
    never be guessed — a live check found 17 blanks to 1 capture, and
    a fully wallet-paid booking has no PSP leg at all, so a bare
    `GROUP BY channel` under-reports wallet spend to zero.
  - **`validator-app`'s `validate-ticket.spec.ts` open-seating test is
    single-use per seed** — it boards the one seeded boardable ticket,
    so a second run without `seed_e2e_users` fails. Same for
    `super-admin`'s `kyc-queue`, which approves the shared KYC fixture.
    Both look exactly like regressions; **reseed before believing
    one.**
  - **A seed migration grants a codename to nobody who already
    exists.** Every phase's permission migration creates the
    `Permission` row and edits `DEFAULT_ROLE_PERMISSIONS`, which
    `create_default_roles` applies only to roles it creates. Measured
    live before slice 2: `analytics.view` reached **4 of 307** Owner
    roles, `notifications.view` 168/307, `ledger.view` 177/307 —
    coverage tracks exactly when each codename was added. **Any new
    codename needs a grant migration alongside its seed migration**, or
    it ships 403-ing for every existing Client.
    `identity/0019_grant_analytics_view_to_existing_roles.py` is the
    pattern; reconciling the six older ones is a real access change and
    is still open.
  - **A data migration touching a `BaseModel` must call
    `set_rls_session_vars(None, is_platform_staff=True)` and use
    `all_objects`.** RLS fails closed, a migration has no
    `app.current_client_id`, and the result is a migration that reports
    `OK` having selected zero rows. `identity/0019` shipped that way in
    its first version. Earlier seed migrations escaped it only because
    `Permission` is not a `BaseModel`.
  - **Assert the invariant, not the example.** Slice 2's channel
    breakdown excluded wallet top-ups while the total rendered beside
    it included them. Every value-checking test passed; the one
    asserting "the slices sum to the total" caught it. The same
    discipline caught a hand-written live reconciliation that summed
    `PaymentIntent.amount` alone — that is the Paystack leg only, and
    a blended payment is whole only with `wallet_component_amount`
    added.
  - **Never join `LedgerAccount` from an aggregate.** It has
    `client=None` for the platform commission account, so a JOIN drops
    the referencing `JournalLine` too for ordinary Business staff —
    spec 5 Slice 1's bug, which would silently under-report every
    payment. `apps/analytics/services.py` derives gross from each
    entry's **debit side** and commission as `gross - revenue`, so it
    never reads that account at all.
  - **`ui-chart` draws SVG, and there is no charting dependency in this
    workspace.** The spec named `chart.js`; SVG serves its stated
    containment goal more completely and settles two concrete problems.
    A canvas `fillStyle` cannot hold `var(--color-brand-600)`, so a
    white-labelled tenant's colours would need `getComputedStyle` at
    draw time and re-resolving every time `BrandThemeService` rewrites
    the ramp — a silent-staleness trap. And the drawing is decorative:
    a canvas is opaque to assistive technology, so **every chart
    renders a visually-hidden data table** beside an `aria-hidden`
    `<svg>`, and once that table exists the picture carries no
    information of its own. Two geometry rules follow from the plot
    being stretched non-uniformly: **nothing inside it may rely on
    geometry** (a point marker is a zero-length round-capped line, not
    a `<circle>`, which rendered as a 20×6 ellipse) and **no text is
    drawn inside it**. A `null` point is a gap, never a zero.
  - **A plain-dict endpoint does not coerce its `Decimal`s.** Nothing
    plays the role a `ModelSerializer` field does, so a bare `Decimal`
    reaches DRF's JSON encoder and leaves as a **float** — while the
    schema-only serializer that documents the response says `string`,
    and the generated `schema.ts` believes it. Every money field on all
    four analytics endpoints shipped that way in slice 2;
    `formatMoney` rendered `NGN 2850` for `2850.0`. Any endpoint
    returning a plain dict needs an explicit emission boundary
    (`apps/analytics/services.py::_money`), and its tests should assert
    the string.
  - **Analytics 400s are field-keyed, not `{"detail": …}`.** A
    serializer's own `ValidationError` produces `{"date_from": [...]}`;
    only permission failures and typed exceptions produce `detail`. An
    error extractor that reads `detail` alone flattens a message naming
    the exact fix into "failed to load". Check the shape against the
    running backend rather than assuming.
  - **A store that refetches on filter change needs a request id.**
    Two overlapping requests do not return in order — a validation 400
    answers almost immediately while a real aggregation does not — so
    an older success can land after a newer failure and overwrite it.
    The dashboard rendered a *successful* older period under newer
    filters, with the period line quietly disagreeing with the date
    fields above it. `AdminDashboardStore` keeps a monotonic id and
    lets only the newest response write, `loading` included.
  - **`/home` is where Staff lands, so it cannot be gated on
    `analytics.view`.** The route keeps `client-admin:access` and the
    dashboard component asks for the codename itself — with it, the
    analytics; without it, a named empty state and no request at all.
    Gating the route would drop a Staff user on Forbidden immediately
    after a successful login. Any future landing-page feature has the
    same constraint.
  - **A response whose body is produced lazily runs its queries with no
    tenancy context at all.** `TenancyMiddleware` wraps each request in
    its own `transaction.atomic()` and resets the Python tenancy
    contextvars in a `finally`, and a `StreamingHttpResponse` returns
    before either happens — so RLS fails closed, `TenantScopedQuerySet`
    returns `self.none()`, and the caller gets a **silently empty file
    reporting `200 OK`**. The CSV export therefore materialises inside
    the view and returns a plain bounded `HttpResponse`, against the
    spec's own literal wording. Anything else that wants to stream from
    the database has the same problem and needs the same answer.
  - **A record list must not inherit an aggregate's default period.**
    `GET /payments/` did, from spec 16 slice 2 until slice 4, and
    silently showed only the last 30 days — a support and dispute screen
    that could not find a two-month-old payment, with no chip, no message
    and no error. An aggregate is always bounded (a dashboard with no
    period is meaningless); a paginated list is bounded by its own
    pagination, and its export by `EXPORT_MAX_ROWS`.
    `apply_to_payment_records`/`apply_to_booking_records` are where that
    distinction lives, and the list and the export of the same rows call
    the identical function.
  - **`config/settings/local.py` merges `DEFAULT_THROTTLE_RATES` now,
    and must keep doing so.** It used to replace the dict, so a scope
    added to `base.py` did not exist under `config.settings.local` —
    and DRF answers an unknown scope with `ImproperlyConfigured`, a 500.
    Spec 16 slice 4's `export` scope 500'd on its first real HTTP call
    while the whole backend suite stayed green, because
    `config.settings.ci` inherits base's rates instead of overriding
    them. **A settings override that substitutes a dict hides every
    later addition to it.**
  - **One field validated against two enums cannot validate either.**
    `GET /bookings/?status=paid` would have 400'd against
    *PaymentIntent*'s choices the moment that list adopted the shared
    analytics filters, so the shared set carries `status` **and**
    `booking_status`, each named for its model.
  - **Analytics tests that do not name a period pass in the morning and
    fail in the evening.** Trip counts narrow on `service_date` and the
    shared fixture seeds a departure a few hours out, which lands on
    *tomorrow* late in the day — outside a default window ending today.
    Three tests had this, one of them latent since slice 2. **Name the
    period whenever a test asserts a trip count.**
  - **A link whose text is data needs `overflow-wrap` put back.**
    `ui-table` resets it to `normal` inside a `<button>`/`<a>` so a
    control's label is never split mid-word; wrapping a route name in a
    link therefore grew the column's minimum width and cost the trips
    table 16px at 390px. The class goes on a `<span>` **inside** the
    anchor — on the anchor itself it loses to that `::ng-deep`
    selector's specificity.
  - **Downloading a file goes through the typed `API_CLIENT`**, with
    `parseAs: 'blob'` per call, and needs three things that had no
    precedent here: the endpoint documented in the schema (not
    `exclude=True`) so the call inherits `authMiddleware`'s 401
    refresh-and-replay; the **error** body read back out of a blob,
    since `parseAs` applies to it too and the `detail` is the half the
    operator can act on; and `CORS_EXPOSE_HEADERS`, without which the
    browser hides `Content-Disposition` and the file saves under the
    wrong name. `ExportStore` is the one implementation.
- **Spec 19 (route lifecycle) is complete, both slices**
  (`docs/specs/19-route-lifecycle.md`, its two Implementation notes).
  Slice 1 — model and services.
  `distance_km`/`estimated_duration_minutes`, a four-state `status`
  replacing the old bare `is_active` (three migrations: additive,
  backfill, enforce `NOT NULL`), `set_route_status()`'s three guards
  (a currently-effective fare and two stops to activate, no future
  Trips to archive), `duplicate_route()`, and the three new endpoints.
  Migration 4, dropping the now-unread column, is committed but not run
  anywhere but a throwaway test database, per the standing rule on
  destructive migrations. 1116/1116 backend tests (up from 1081).
  - **A read-site sweep found the site it was looking for and missed a
    different one.** Every `is_active` reference in `apps.network` and
    the two passenger-facing endpoints (`GET /routes/browse/`,
    `GET /trips/search/`) was swept correctly; `apps.analytics.services
    .dashboard()`'s route breakdown was not, and 500'd until the full
    suite caught it. Fixed by keeping the dashboard's existing two
    buckets (`active`/`inactive`) rather than growing two more for
    `draft`/`archived` — redesigning that breakdown is spec 16's call,
    not spec 19's, and the fix records that a draft or archived route
    now counts in neither bucket, on purpose.
  - **A guard framed in prose around one transition is checked against
    the transition, not the frame.** The spec narrates `draft ->
    active`'s fare/stop guard by name; `set_route_status` runs it for
    *any* transition landing on `active`, so reactivating from
    `inactive` gets the same check. Nothing in the test plan ruled
    either reading out — the uniform one is also the smaller diff.
  - **An edge case named in a table is not enforced until something
    writes the check.** "Editing an archived route: 400; restore
    first" sat in the spec's own edge-case table with nothing behind
    it until `RouteSerializer.validate()` gained an explicit check
    against `self.instance.status`, alongside the separately-named
    "PATCH attempting `status`" rejection.
  - **`RouteFactory`'s default deliberately does not match the model's.**
    The model defaults a new Route to `draft`; the factory defaults to
    `active`, because dozens of tests across `fares`, `seating`,
    `booking`, `scheduling`, `payments`, `ticketing` and `analytics`
    build one via `RouteFactory()` with no override and expect an
    ordinarily-usable route — exactly what `is_active`'s own default
    (`True`) always gave them before this spec existed.
  - **An additive-then-later-drop migration plan must relax the old
    column's constraints in the additive step, not just leave the
    column present.** Found only by running the golden path
    (create → stops → price → activate → duplicate → archive → restore)
    against the real dev database, not by any test: `is_active` was
    still `NOT NULL` from migration 0001, and the additive migration
    never touched that, reasoning the drop was "a separate, later,
    explicitly-approved step" with "no pressure to run in the same
    deployment." False the instant `Route.objects.create()` stopped
    setting the field — every new Route insert failed `IntegrityError`.
    `pytest` never saw it: `--create-db` always builds the test database
    from *every* migration including the drop, so the constraint the
    live database still enforces never exists there to violate. Fixed by
    making `is_active` nullable inside the additive migration itself.
  - Slice 2 — UI. `route-list` replaces the old Active/Inactive toggle
    with a status filter and a row menu built from the legal next
    statuses (activate/deactivate/archive/restore, each confirmed) plus
    `Duplicate` from any status including `archived`; `route-form` gains
    the two depth fields and disables itself with a restore-first
    message when the loaded route is archived, since the backend's 400
    for that only fires on submit; `route-detail` is new, reading the
    real single-record GET slice 1 added rather than
    `findByIdPaged`. 1539 frontend unit tests.
  - **A menu icon or a dialog's danger tone keyed on the target status
    alone gets one transition backwards.** `archived -> inactive`
    (Restore) and `active -> inactive` (Deactivate) target the same
    status, but only one takes the route further from being sold.
    `takesOutOfService(from, to)` takes both ends and is computed once
    in `shared/route-labels.ts`, read by the row menu, its confirm
    dialog and the detail screen's own buttons — three chances to get
    the one case wrong, collapsed into one.
- **Spec 20 (live operations), slice 1 — telemetry backbone — is
  complete** (`docs/specs/20-live-operations.md`, its Implementation
  note). New `apps/telemetry` (`TelemetryDevice`/`VehiclePosition`/
  `VehicleLiveState`, all RLS-enabled), device issue/revoke/reassign on
  `fleet.manage` (no new codenames — the spec's own call), batch ingest
  idempotent on `(device, recorded_at)` with a `VehicleLiveState`
  advance guard, `POST /internal/tasks/prune-telemetry/`, and
  `manage.py simulate_vehicle_positions` — walking a route's coordinated
  stops through the same `record_positions()` the ingest endpoint calls,
  so the simulator exercises the real contract rather than writing rows
  directly. No UI, per the spec's own slicing. 1142/1142 backend tests
  (up from 1116).
  - **DRF silently downgrades `AuthenticationFailed` to a bare 403 when
    `authentication_classes` is empty.** The first cut hand-parsed the
    `Device <token>` header in `initial()`; `APIView.handle_exception`
    only keeps a 401 when some authenticator's `authenticate_header()`
    is truthy, so a revoked or unknown device token came back 403,
    contradicting the spec's own edge-case table. Fixed with a real
    `DeviceTokenAuthentication(BaseAuthentication)`, which also gave the
    per-device rate throttle a proper key (`request.auth`) instead of a
    hand-stashed request attribute.
  - **`settings.SETTINGS_MODULE` reads `None` the instant any
    `override_settings`-shaped override is active anywhere in the same
    test process — including this repo's own autouse `settings`
    fixture, active on every test.** Django's `UserSettingsHolder`
    hardcodes `SETTINGS_MODULE = None` at the class level ("doesn't make
    much sense in the manually configured case"), shadowing the real
    value process-wide, not just for the one overridden setting. The
    simulator's production guard read that attribute and crashed on
    every single test in the suite. Fixed by reading
    `os.environ["DJANGO_SETTINGS_MODULE"]` instead.
  - `openapi.yaml` had gone stale since spec 19 (never regenerated after
    that slice landed); this slice's regeneration carries a large diff
    that is confirmed, path-by-path, to be spec-19 catch-up rather than
    telemetry drift — alphabetical resorting makes a no-op change look
    like mass deletion under a naive line diff. `POST
    /telemetry/positions/` is excluded from the generated schema, same
    reason `PaystackWebhookView` is: no Angular client ever calls it.
- **Spec 20, slice 2 — live read API — is complete**
  (`docs/specs/20-live-operations.md`, its Implementation note).
  `GET /trips/live/` and `GET /trips/{id}/live/` in a new
  `apps/telemetry/live.py` (a module of its own, matching
  `apps.booking.manifest`'s own precedent), registered under
  `apps.telemetry.urls` even though the paths are `trips/...` — the app
  that owns the data owns the endpoint. Both gated on `scheduling.view`;
  the detail endpoint also accepts a ticket- or fare-journey-holding
  passenger, checked by hand since no existing permission class
  expresses "this codename, or ownership". `ETag` short-circuits a
  quiet poll before any per-trip envelope is built; `?since=` then
  narrows a real response to the trips that moved. 1161/1161 backend
  tests (up from 1142).
  - **Progress has no natural home in the slice-1 schema to be
    "constrained to move forward only" from.** `VehicleLiveState` holds
    only the current position, not a stop index. Implemented as a
    24-hour cache of the furthest nearest-stop index reached per trip —
    a soft guarantee (eviction only ever lets one poll under-report,
    never regress what was already shown), which is the right strength
    for a display backing nothing financial.
  - **ETA has no per-stop schedule to read from either** — only
    `Route.estimated_duration_minutes` (spec 19) for the whole route —
    so it's a uniform per-segment split of that total, offset by the
    observed departure delay, `null` whenever the route has no duration
    at all. Both gaps are labelled `ASSUMPTION:` in code rather than
    guessed silently.
  - **A vehicle reused for a later trip must not leak that trip's live
    position onto an earlier, completed one** — `VehicleLiveState` is
    keyed by vehicle, not trip. `current_position_for` reads it only for
    a trip still `in_progress`; a completed trip reads its own last
    `VehiclePosition` instead, which stays correctly attributed at
    ingest time. Caught by a dedicated test, not by inspection.
  - Reused rather than duplicated: `apps.booking.manifest.trip_summary()`
    and `apps.analytics.services.seats_sold_and_total()`. **Not** reused:
    `manifest.totals()`'s own `boarded` count, which builds a full
    manifest row list for a screen opened once — this endpoint is polled
    every 10-15 seconds fleet-wide, so `occupancy.boarded` is its own
    single `COUNT` query instead.
- **Spec 20, slice 3 — operator live monitoring — is complete**
  (`docs/specs/20-live-operations.md`, its Implementation note). A new
  `ui-map` (`@shared-ui`) — Leaflet, loaded dynamically, drawing custom
  token-coloured `L.divIcon` markers rather than Leaflet's own raster
  pins so a marker's tone tracks `BrandThemeService`'s runtime brand
  override — and `client-admin-app`'s `live-operations` screen: a trip
  list, a map panel, and a selected-trip detail panel, backed by a new
  `LiveOperationsStore` and a new, independently-tested `Poller`
  (`@shared-data`) that slice 4's passenger tracking and activity feed
  will reuse. 1571 frontend unit tests (up from 1539); 1161/1161 backend
  tests (+1 assertion).
  - **A real gap in slice 2, found building its first consumer:**
    `?since=` was read correctly and covered by backend tests, but no
    `OpenApiParameter` declared it, so `schema.ts` typed the endpoint as
    taking no query at all. Fixed with `_SINCE_PARAM`.
  - **`ETag` needed `CORS_EXPOSE_HEADERS`** — present on every response,
    but invisible to `response.headers.get('etag')` cross-origin without
    it, the same trap `Content-Disposition` hit one spec earlier.
  - **The `?since=`/`ETag` composition the spec left to this slice:**
    every poll echoes the previous `ETag`; a `304` leaves the board
    (and its cursor) untouched; a `200` merges into an id-keyed `Map` so
    an unrelated poll cannot reshuffle rows; every 6th poll runs full
    (no `?since=`) so a completed trip actually disappears. The cursor
    itself is a new `server_time` response field — the server's own
    clock — rather than `Date.now()` or the `Date` header, immune to
    client/server skew by construction.
  - **The fixture suite had no coordinated route at all** —
    `seed_e2e_users`'s stops were all `latitude=None`, so
    `simulate_vehicle_positions` silently skipped every trip. Real Lagos
    coordinates now anchor "Yaba → Lekki".
  - Verified against a real running stack — a local backend, the
    client-admin-app dev server, a fresh in-progress Trip, and one real
    `simulate_vehicle_positions` run — not only unit tests, screenshot-
    confirming the full ingest → live-read → frontend chain.
- **Spec 20, slice 4 — passenger tracking and activity feed — is
  complete. This closes spec 20, all four slices.**
  (`docs/specs/20-live-operations.md`, its Implementation note.) A new
  `apps/activity` (no models, the `apps.wallet`/`apps.analytics` shape)
  composes `PaymentIntent`, `Ticket` and `FareJourney` into
  `GET /activity/mine/`; `customer-app` gained `trip-tracking` (reusing
  slice 2's `GET /trips/{id}/live/`) and `activity-feed`, each with its
  own store and the `Poller` slice 3 built.
  - **Two spec claims corrected against the model, not guessed**: a
    PAYG fare never actually posts a ledger entry today (traced through
    `apps.tapngo.services._record_alight`), so `fare_deducted` entries
    are `FareJourney`-only and always carry `wallet_balance: null`
    rather than inventing a line that was never written; and "ticket
    issued and boarded" folds into `booking_paid` (issuance) plus its
    own `ticket_boarded` (scan time) rather than a redundant per-seat
    row.
  - **A per-transaction wallet balance has no column to read**
    (ADR-0006: always derived) — recomputed as a running sum over each
    wallet account's own history, acceptable only because it's bounded
    by one passenger's transaction count.
  - `activity-feed` reaches from a `home` quick-link card, not the nav
    bar — already at its measured 1200px width budget per
    `app-shell.ts`'s own comment.
  - Verified against the same real running stack as slice 3, using
    `seed_e2e_users`' own guaranteed-paid "boardable ticket" fixture
    trip transitioned to `in_progress` — screenshot-confirmed
    `my-bookings`' new "Track this trip" action, the tracking screen,
    and the activity feed rendering real accumulated history correctly
    ordered.
  - 1596 frontend unit tests (up from 1571), 1171/1171 backend tests
    (up from 1161).
- **Spec 21, slice 1 — responsive navigation — is complete.**
  (`docs/specs/21-passenger-experience.md`, its Implementation note.)
  `customer-app`'s `AppShell` moves its nav to a fixed bottom tab bar
  below Tailwind's own `sm` breakpoint (640px) and keeps the original
  top-bar row at `sm` and above — one `BreakpointObserver` signal
  gating a single `@if`, so exactly one `nav[aria-label="Primary"]` is
  ever in the DOM. Closes the 390px nav-overflow defect recorded since
  spec 10's own visual pass (`docs/ui-review/10-booking-modes/iteration-1.md`)
  and left open through spec 17 slice 3's own measurement of it.
  - **A real 320px finding from the new `e2e/responsive-nav.ts`
    harness**, not guessed: a flex item's default `min-width: auto`
    held one two-word tab label ("Tap & Go") to 28px wide — under the
    44px touch-target minimum — while its one-word neighbours
    ("Payments", "Journeys") kept their full intrinsic width, since
    they have no space to wrap on. Fixed with `min-w-0` (let every tab
    take its equal flex share) plus `break-words` (let an
    over-long word wrap mid-word inside that share rather than
    overflow it).
  - **Running the rest of `customer-app`'s own Playwright suite**
    (not only the new spec — `AppShell` is chrome every screen mounts)
    **surfaced two further pre-existing bugs, apparently never actually
    run to green before**: `trip-tracking.spec.ts`'s fixture helper
    called a staff-gated endpoint (`GET /bookings/`, `booking.view`)
    with a passenger token, which always 403s there regardless of
    fixture state — fixed by passing the staff token instead, since
    the lookup itself is a staff-only read even though the trip it
    locates is the passenger's own; and `ui-map`'s zoom control,
    attribution link and markers stayed keyboard-focusable inside the
    map's own `aria-hidden` container, which axe correctly flags and
    named the fix for directly — `keyboard: false` on the Leaflet map
    and its markers, `tabindex="-1"` swept onto the zoom/attribution
    anchors (which have no such option) right after the map is
    created. Confirming that fix didn't regress `ui-map`'s other
    consumer meant re-running `client-admin-app`'s own unit suite and
    its `live-operations` e2e spec too, which surfaced a **third**,
    separate contrast bug — the marker popup's "Simulated data" text
    at 2.71:1 — left open, orthogonal to responsive navigation, for
    this spec's own slice 3 (the WCAG sweep) or spec 20's follow-up.
  - Verified against the same real running stack as spec 20: a
    rebuilt backend image (the docker image had drifted behind
    `pyproject.toml`), freshly seeded, with the deliberately-withheld
    `network.0009_drop_route_is_active` migration confirmed still the
    only one unapplied.
  - No backend change. 257 customer-app unit tests changed, 728
    client-admin-app unit tests re-confirmed unaffected.
- **Spec 21, slice 2 — hold countdown — is complete.**
  (`docs/specs/21-passenger-experience.md`, its Implementation note.)
  `hold_expires_at`/`hold_expires_in_seconds` added to
  `BookingSerializer`; a new `CountdownClock` (`@shared-data`) and
  `ui-countdown` (`@shared-ui`); both consumers the spec named,
  `booking-confirm` and `my-bookings`.
  - **Computed from the earliest `HELD` reservation only**, not "any
    non-released row" — a `CONFIRMED` reservation's `held_until` is a
    stale pre-payment value the code never clears, so reading it would
    resurrect a countdown on an already-paid booking. Filtering on
    `HELD` makes "booking already paid → no countdown" fall out for
    free, with no separate check. Both fields read the exact same
    per-booking `SeatReservation` rows `seats` already batches
    (`reservations_by_booking`), so this cost no additional query.
  - **A second spec claim corrected against the model** (the first was
    slice 1's `validator-app` scope note): quick-book bookings hold a
    real seat — `create_reservation` runs for them exactly as for a
    manually-picked one (`apps/booking/tests/test_quick_book.py`'s own
    module docstring already states this) — and get a real countdown,
    contrary to the spec's edge case grouping them with open seating,
    which holds nothing at all.
  - **`CountdownClock` is a distinct primitive from `Poller`, not a
    reuse of it.** `Poller` is one screen's own polling need (a fresh
    instance per consumer); a countdown needs one shared tick source
    several unrelated component instances observe together (`my-
    bookings`' several held rows), which is what a `providedIn: 'root'`
    singleton is for. `ui-countdown` counts down from seconds alone,
    never compares against `Date.now()` — a wrong device clock still
    produces a correct countdown — and emits `expired` without
    asserting the hold is gone; both consumers re-fetch and render
    whatever the server actually says.
  - **`booking-confirm` no longer auto-navigates to `/my-bookings` on a
    successful submit.** The spec's own stated reason for returning
    both hold fields on the create response — "so the confirm screen
    can start counting down without a second request" — cannot be true
    of a screen that redirects away in the same tick it receives them.
    It now shows a held/confirmed panel with the countdown first;
    "Continue to My Bookings" is the passenger's own action. This also
    lets the post-submit copy tell an open-seating booking from a
    quick-book one for real (via `hold_expires_in_seconds`), which the
    pre-submit review form's own existing comment already recorded it
    could not do.
  - Running the full `customer-app` Playwright suite after this change
    surfaced four e2e assertions (`booking.spec.ts` ×3,
    `open-seating.spec.ts` ×1) that expected the old immediate
    redirect; all four updated, and the concurrent-booking race test's
    winner/loser detection rewritten from a URL pattern (the winner no
    longer navigates) to reading which of two visible-text markers
    appears.
  - Verified against the same real running stack: a real seated
    booking driven through search → seat-picker → confirm, screenshot-
    confirming "Your seats are held — pay before the timer runs out"
    with a live "Held for 14:59," then landing on `my-bookings` where
    the new row counts down, older accumulated rows past their window
    correctly show "Hold expiring" (floored at zero, not negative), and
    every cancelled/paid row shows no countdown.
  - 7 new backend tests, 1178/1178 total (up from 1171). 1617 frontend
    unit tests (up from 1598: +7 customer-app, +8 shared-ui, +4
    shared-data).

- **Spec 21, slice 3 — Senior Mode — is complete. This closes spec 21
  and the whole Transit OS adoption roadmap.**
  (`docs/specs/21-passenger-experience.md`, its Implementation note.)
  `SeniorModeStore` (`customer-app`-local, persisted, sets
  `data-senior="true"` on `<html>`) plus a `theme.css` token block keyed
  off that attribute; a header `ui-toggle` reachable at every viewport;
  a larger QR treatment on both existing QR screens. No backend change.
  - **The type/control/spacing scale is one rule —
    `html[data-senior='true'] { font-size: 175% }` — not a bespoke
    token.** Every size in this workspace is `rem`-based, Tailwind v4's
    own type scale and the `--ui-control-height`/`--ui-row-height`/
    `--ui-gutter` tokens included, so scaling the root font-size scales
    all of them together from one place, and composes with a real OS/
    browser zoom instead of fighting it. Took `--ui-control-height`'s
    44px to 77px for free, well past the spec's 56px floor, without
    touching Button/TextField/Select/Checkbox/RadioGroup.
  - **Contrast raised to a measured 7:1 (AAA)**, not judged: a new
    `color.spec.ts` block mirrors the existing AA one. `--color-default`
    (10.35:1) and `--color-strong` (17.85:1) already cleared it
    unmodified; `--color-muted` and the three status tones did not and
    were overridden (danger reuses the existing `--color-danger-hover`
    token rather than a new hex). `prefers-contrast: more` applies the
    same tokens independently of the toggle, matching this file's
    existing `prefers-reduced-motion` handling.
  - **Two real, pre-existing bugs found by the visual pass and fixed —
    neither one Senior-Mode-specific, both only first exposed by its
    larger type:**
    - `ui-page-header`'s title/description overflowed and was silently
      clipped instead of wrapping (a passenger's own email, on `home`).
      `break-words` alone did nothing — its flex wrappers lacked
      `min-w-0`, so each grew to fit the email's own unbreakable width
      instead of ever handing `break-words` a constrained box to break
      inside. Fixed in `page-header.ts`, with a regression test.
    - An `sr-only` `ui-countdown` announcement inside `ui-table`'s
      `md:table-cell` column escaped the table's own `overflow-x-auto`
      containment entirely and inflated `document.documentElement
      .scrollWidth`, because the wrapper was not `position: relative`
      and so was not its containing block. Fixed with `position:
      relative` plus `min-w-0` (the latter an independently real
      automatic-minimum-size flex bug: without it the wrapper does not
      shrink to its available width inside any consumer's `flex
      flex-col` layout in the first place). `app-shell.ts`'s `<main>`
      also gained `overflow-x-hidden` as a backstop, and its header row
      gained `flex-wrap` in two places for the same 320px reason.
  - **One capture-tool artifact, not a defect**: `fullPage` Playwright
    screenshots of a Senior Mode page misplace the fixed bottom tab bar
    mid-image; a direct viewport screenshot confirms the live app
    renders it correctly. No code change, recorded so it is not
    re-discovered as a phantom bug.
  - **One gap accepted, not fixed**: `ui-table`'s columns stay at a
    deliberately frozen "console density" — `table.ts`'s own docstring
    already documents a three-times-hardened decision to hold a 390px
    fit, never reading `--ui-text-body` — and a root-level `rem` scale
    cannot selectively respect that opt-out, so a narrow column can
    wrap mid-word under Senior Mode. Real, but
    `docs/specs/14-design-system-and-ui-rebuild.md` territory (a
    narrow-viewport redesign of the component), not a token override;
    every other Senior Mode requirement holds on every table screen,
    and no primary action is ever unreachable, only reached by
    scrolling sideways to it.
  - Full dual-mode visual pass at 390/768/1200px
    (`docs/ui-review/21-passenger-experience/iteration-1.md`):
    `ui-review-capture.ts` gained a `UI_REVIEW_SENIOR` env var so the
    existing capture list needed no duplication.
  - `e2e/senior-mode.ts` (new): no horizontal page overflow at
    320/390/768/1200px with the mode on; axe zero violations at
    390/1200px in **both** modes; the toggle keyboard-reachable on
    first load; every rendered `.min-h-11` control at least 56px tall.
    All 10 pass. Rest of `customer-app`'s Playwright suite re-run too:
    40 passed, 1 pre-existing skip, 1 pre-existing failure
    (`open-seating.spec.ts`, traced to this dev database's accumulated
    e2e-cruft routes exceeding the search dropdown's page size —
    `prune_e2e_test_data` reduced but did not clear it; unrelated to
    this slice).
  - 1633 frontend unit tests total (up from 1617).
  - **The self-check catch-up for specs 19–21 is done**:
    `docs/self-check-2026-09-12-specs19-21.md`. Backend (1178/1178,
    ruff/mypy clean, no OpenAPI drift) and frontend (1633/1633, lint
    clean on all 9 projects) both verified fresh; migration sweep found
    only the already-known, deliberately-unapplied
    `network.0009_drop_route_is_active`. One real regression found and
    fixed: `@HostListener` had crept back into `NavShell` and
    `NotificationBell` sometime in this range, the exact convention
    `standalone: true` was fixed for in the 09-07 pass — converted to
    `host` object bindings. One tracking gap found and closed: F9 (the
    `NavShell` 390px icon rail) had silently dropped out of
    `docs/traps.md`'s "Known gaps" list on the mistaken assumption that
    spec 21 would fix it — it never touched `NavShell` — and is
    restored there, now unowned since the roadmap has no further spec.
  - **The fix batch this self-check led to is done (2026-09-12)**: every
    gap it and `docs/traps.md` named — `ui-map` marker-popup contrast,
    `ui-table`'s Senior Mode density, `trip-search`'s bounded Route
    picker, `NavShell`'s icon rail, the KYB queue's missing search, and
    `prune_e2e_test_data`'s inability to clear KYB-documented rows —
    is fixed. Full account, including two corrections made along the
    way (F1's N+1 gap was narrower than recorded; F6c's real cause was
    a premature post-close refetch stealing CDK's own focus
    restoration, not Playwright worker concurrency — `workers: 1` was
    tried and confirmed **not** to fix it before the real cause was
    found) lives in `docs/traps.md`'s own entries, each dated. 1185/1185
    backend tests (up from 1178), 1645 frontend unit tests (up from
    1633). Verifying the batch with a full four-project Playwright run
    surfaced three further, unrelated, **not fixed** defects — a
    `client-admin-app` route row's action menu that never renders its
    items despite reporting itself open, a pre-existing axe violation
    in `live-operations`'s trip-picker list, and data drift on the
    shared "Yaba → Lekki" e2e fixture trip (duplicate rows, one
    incorrectly `in_progress`) — all recorded in `docs/traps.md`'s
    "Known gaps" section rather than chased in the same pass.
  - **The live Vercel + Supabase deployment had silently drifted a
    month behind (found and fixed 2026-09-13)**: `docs/deployment.md`'s
    runbook was carried out exactly once, on 2026-08-19 (commit
    `92ddabd`), but the backend Vercel project kept auto-deploying on
    every push after that — so the live backend had been running code
    from as far as `e221594` (2026-09-08) against a database schema
    frozen at day one. Three apps built since then (`incidents`,
    `notifications`, `telemetry`) had no tables in Supabase at all, and
    schema changes to `booking`/`businesses`/`network`/`scheduling`/
    `ticketing`/`payments`/`ledger`/`identity`/`fares`/`fleet` were
    likewise unapplied — confirmed live as `500`s on `/incidents/`,
    `/notifications/mine/`, and even `/api/v1/schema/`. Fixed by running
    the full pending migration set (40 files) against Supabase's direct
    connection, then pushing the fix batch (`6e5f179`) on top — no code
    change was needed for this specific gap, only catching the database
    up. Separately found and fixed while auditing this: the two
    notification-sweep cron workflows (added 2026-08-20, one day after
    the only deploy) never had `BACKEND_URL`/`INTERNAL_TASK_SECRET`
    configured as GitHub Actions secrets, so they'd never run
    successfully against real infrastructure — added now, confirmed via
    a manual `workflow_dispatch` run on all four cron workflows. The
    lesson, restated in `docs/deployment.md` §5: **auto-deploy on push
    and manually-run migrations are two independent mechanisms on this
    platform, and nothing keeps them in sync** — a deploy that changes
    schema silently breaks production the moment newer code reaches a
    database that was never migrated to match it. Storage for KYC/KYB
    documents remains ephemeral on Vercel (§7) — unrelated to this
    incident and still not fixed.

---

## Appendix — the reasoning behind the Commands and Conventions rules

Moved verbatim from CLAUDE.md when it was trimmed to rules-only.
The rules themselves live there; this is the evidence behind them.

**Never run a formatter over this repo.** There is no `prettier`
dependency and no config beyond an HTML parser override, so
`npx prettier --write` applies its own defaults — double quotes, an
80-column wrap — and rewrote 156 files in one command. The source is
hand-authored in a prettier-*like* style that no single setting
reproduces (the closest probed match was 3 of 37 known-clean files).
Format edits by hand; `ng lint` is the check that actually gates.

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
Playwright's `globalSetup` seeds e2e users by shelling into the **backend
container** (`docker compose exec backend ...`) — bring up
`docker compose up -d postgres redis backend` (and migrate) before
running `npx playwright test`.

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

