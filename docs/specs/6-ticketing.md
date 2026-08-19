# 6-ticketing: QR ticket issuance and validation

`docs/adr/0005-qr-ticket-signing-scheme.md` was the last Proposed ADR in
the repo; it's now Accepted, and its Context section named exactly what
this spec must settle: whether a dedicated `Ticket` model exists beyond
reusing `SeatReservation`'s own id, the actual expiry-window and
revocation-sync-cadence values, and the concrete API surface a validator
device syncs against. This spec answers all three. Like Phase 4/4b/5,
it is built as backend-then-frontend slices, each stopped for review
before the next starts — see "Suggested implementation slicing" below.
No code exists yet for this phase; this is a spec-only pass.

## Scope and non-goals

In scope: issuing a signed QR ticket automatically the moment a Booking
is paid, an always-online staff/validator endpoint that scans and
validates it, a customer-facing screen to view/download the QR, and a
validator-app screen to validate it — extending `apps.tapngo`'s
"device presents a credential, backend resolves and records an event"
shape to a signed-payload credential instead of an opaque DB-looked-up
token.

**Non-goals:**

- **Genuine offline validation** (camera-based scan plus local Ed25519
  verification with no network round-trip). ADR-0005's own Context
  section frames this as a later, Flutter-app v2, arriving after this
  phase. This phase's validator-app screen stays always-online and
  manual-entry, matching `record-tap`'s existing shape exactly — it
  posts the scanned/typed payload to the backend and trusts the
  backend's answer, the same way `record_tap` already works.
- **Revoking a ticket after refund or cancellation of an already-`paid`
  Booking.** No refund flow exists anywhere in this codebase yet —
  `apps.booking.services.cancel_booking` only cancels a
  `pending_payment` Booking; nothing cancels or refunds a `paid` one.
  `GET /ticketing/revoked/` ships with this phase (the mechanism ADR-0005
  already committed to), but it has no producer for this specific case
  — in practice it stays empty until a future refund phase populates
  it. Named, not solved, the same treatment `docs/adr/0007` gave the
  Botswana PSP gap.
- **Real AWS Secrets Manager/SSM-backed key storage.** ADR-0005 already
  settled this as documented-but-unbuilt, same treatment Phase 0 gave
  AWS provisioning generally. This phase provisions the `config()`
  env-var path only.
- **A `Ticket` reissue or manual-issuance UI.** A Ticket is created
  exactly once per Booking, automatically, the moment
  `mark_booking_paid()` runs. Nothing in this phase lets staff manually
  trigger, regenerate, or backdate one.

## Data model changes

New app `apps/ticketing`. One model, a `BaseModel` subclass, RLS-enabled
via `EnableRowLevelSecurity` in its first migration — the exact shape
`apps/fares/migrations/0001_initial.py` already establishes for a new
domain app's first migration.

### `Ticket`

**Correction made during implementation**: this table originally put
`unique=True` on `booking`, implying one Ticket per Booking. That's
wrong — `apps.booking.services.create_booking(*, trip, passenger,
seats: list[SeatRequest], ...)` already accepts multiple seats per
Booking (a group booking), and each seat needs its own independently
scannable ticket, since ADR-0005's payload identifies a ticket by
`seat_reservation_id`. `unique=True` belongs on `seat_reservation`, not
`booking`. `GET /bookings/{id}/ticket/` below is corrected to
`GET /bookings/{id}/tickets/` (plural, list) for the same reason.

| Field | Type | Notes |
|---|---|---|
| `booking` | FK → `booking.Booking`, `PROTECT` | Not unique — a Booking may have several Tickets, one per seat. |
| `seat_reservation` | FK → `seating.SeatReservation`, `PROTECT`, `unique=True` | The QR payload's own identity field per ADR-0005 (`seat_reservation_id` doubles as the ticket's identity — no separate id scheme). One Ticket per seat, enforced at the DB level. |
| `trip` | FK → `scheduling.Trip`, `PROTECT` | Denormalized from `booking.trip`, matching the `FareJourney.business`-denormalization precedent (`apps/tapngo/models.py`) — read/audit convenience, not a new source of truth. |
| `kid` | `CharField` | Which `TICKET_SIGNING_KEYS` entry signed this payload. Needed to know, without decoding, whether a ticket was signed under a since-retired key. |
| `signed_payload` | `TextField` | The base64url-encoded, CBOR, Ed25519-signed QR content, generated once at issuance and reused on every subsequent view. Storing it (rather than regenerating on each request) is deliberate: a passenger who screenshots or downloads their QR must see the exact same code every time they reopen the screen, not a freshly re-signed one with a different `issued_at`. |
| `issued_at` | `DateTimeField` | Server-assigned, set once at creation. |
| `expires_at` | `DateTimeField` | Server-assigned. `= trip.scheduled_departure_at - TICKET_VALID_BEFORE_MINUTES` is when the ticket becomes valid (see below); this field is the *end* of the window: `trip.scheduled_departure_at + TICKET_VALID_AFTER_MINUTES`. Anchored to the trip's own schedule, not to issuance time — a passenger who pays three days before travel still gets a QR that only becomes checkable near the trip, and that stays checkable through it. |
| `status` | `CharField`, choices `issued` / `boarded` / `expired` / `revoked` | `issued` at creation. `boarded` is set by the validate endpoint. `expired`/`revoked` are set on the read/write path that notices the condition (see Failure modes) — there is no cron sweep, unlike `SeatReservation`'s expiry-sweep Celery Beat job, because an un-transitioned expired Ticket has no side effect that needs cleaning up (it simply fails validation) the way an un-swept expired seat hold blocks other passengers. |
| `boarded_at` | `DateTimeField`, null | Server-assigned, set by the validate endpoint the moment a scan succeeds. |

```python
constraints = [
    models.CheckConstraint(
        check=models.Q(expires_at__gt=models.F("issued_at")),
        name="ticket_expires_after_issued",
    ),
]
```

Two new `config()`-sourced settings, alongside ADR-0005's own
`TICKET_SIGNING_KEYS`/`TICKET_SIGNING_ACTIVE_KID`: `TICKET_VALID_BEFORE_MINUTES`
(default `1440`, i.e. a ticket becomes scannable up to 24h before
departure) and `TICKET_VALID_AFTER_MINUTES` (default `240`, i.e. it
stays scannable up to 4h after departure). Both are platform-level, not
per-Business, matching `TICKET_SIGNING_KEYS`' own settings-not-model
precedent rather than `Business.seat_hold_minutes`'s per-tenant
precedent, since ticket validity windows aren't a business policy lever
in this phase. **ASSUMPTION**: these default numbers are reasonable
starting values, not researched against any real operator's boarding
process; they're trivially overridable via env var without a schema
change.

**Correction made during implementation**: an earlier draft of this
section also specified a `TICKET_KEY_GRACE_PERIOD_DAYS` setting to
govern how long a retired signing key stays honored. Implementing it
revealed that no code actually needs it: the grace window is already
fully implemented by whether a `kid` is still present in
`TICKET_SIGNING_KEYS` — there's no rotation-history model to compare a
timestamp against, so a numeric setting nothing reads would be
configuration for its own sake. The grace period is an operational
policy (how long ops waits before deleting a retired `kid` from the env
var), not enforced code — `GET /ticketing/signing-keys/` below already
does the right thing with no extra logic.

## API surface

### Passenger-facing (customer-app-consumable)

- `GET /bookings/{id}/tickets/` — returns the list of Tickets for an
  owned Booking (corrected from a singular `ticket/` — see the Data
  model correction above; normally one item, N for a group booking).
  `IsAuthenticated` + ownership check (`booking.passenger ==
  request.user`), the same pattern `GET /bookings/mine/` already
  enforces at the queryset level. Returns `404` if the Booking isn't
  `paid` yet (no Tickets exist until `mark_booking_paid()` creates them
  — this mirrors `PaystackAccountConfigView`'s "distinct 404 for a
  real-but-not-yet-configured state" precedent). Each item:
  `{"id", "signed_payload", "status", "issued_at", "expires_at",
  "boarded_at"}` — the frontend renders `signed_payload` directly as a
  QR code (as raw base64url text, the same way `apps.tapngo`'s raw
  token is rendered by `customer-app`'s existing `credentials` screen
  via the `qrcode` npm package).

### Staff/validator-facing (permission-gated, new codename `ticketing.validate`)

- `POST /trips/{id}/tickets/validate/` — body `{"payload":
  "<base64url QR content>"}`. Requires an `Idempotency-Key` header,
  `400` if missing — copying `TapRecordView`'s exact precondition.
  Requires `ticketing.validate` via the existing `HasPermission(codename)`
  pattern, seeded in a new `backend/apps/identity/migrations/
  0016_seed_phase6_ticketing_permissions.py` depending on `0015_...`,
  following the `PERMISSIONS` list / `RunPython` seed-and-unseed
  template every prior phase's permission migration already uses.
  Decodes and Ed25519-verifies the payload (never trusting any field
  from the request body except `payload` itself — see Failure modes),
  resolves the `Ticket` by its embedded `seat_reservation_id`, checks
  trip match / expiry window / not-already-boarded / not-revoked,
  transitions `issued` → `boarded`, sets `boarded_at`, and returns a
  validator-facing summary: `{"status": "boarded", "passenger_name",
  "seat_number", "from_stop", "to_stop", "trip_departure_at"}`. On
  failure, returns a typed error (`InvalidSignature`, `TicketExpired`,
  `TicketRevoked`, `AlreadyBoarded`, `WrongTrip`, `UnknownTicket`),
  each mapped to a specific HTTP status — the same
  typed-exception-to-status-code shape `apps.tapngo.services`'s
  `UnknownToken`/`CredentialInactive`/etc. already establishes.

### Sync endpoints (from ADR-0005, `IsAuthenticated` only — no
`ticketing.*` permission, since these publish low-sensitivity key/list
material a future offline validator device needs to cache, not a
privileged action)

- `GET /ticketing/signing-keys/` — `{"keys": [{"kid", "public_key"}]}`,
  every `kid` currently present in `TICKET_SIGNING_KEYS`, active or
  retired-but-still-listed. Presence in the setting *is* the grace
  window (see the Data model correction above) — an operator ends a
  retired key's grace period by removing its `kid` from the env var and
  redeploying, not by waiting out a stored duration.
- `GET /ticketing/revoked/` — list of ticket ids that are cancelled/
  revoked but still inside their own `expires_at` window. Empty in
  practice this phase (see Non-goals), but the shape exists so a future
  refund phase and a future offline validator both have a stable
  contract to build against without another migration.

## Edge cases

1. **Ticket requested for a `pending_payment`, `cancelled`, or
   `expired` Booking.** `404` — no Ticket row exists; `mark_booking_paid()`
   is the only creator.
2. **Validate attempted before the valid-from window opens** (now <
   `trip.scheduled_departure_at - TICKET_VALID_BEFORE_MINUTES`, which
   can't actually happen given `expires_at`/window math below, but a
   staff member manually testing a not-yet-boardable trip could still
   hit a "too early" state if `TICKET_VALID_BEFORE_MINUTES` is
   shortened after issuance) — rejected with a distinct `TicketNotYetValid`
   status, not lumped into `TicketExpired`.
3. **Validate attempted after `expires_at`.** `TicketExpired`, `409`.
   Ticket's own `status` is lazily flipped to `expired` on this read,
   so a subsequent staff-facing list view reflects it without a sweep
   job.
4. **Already-boarded re-scan.** Returns the original success response
   again (idempotent `200`, not a `409`) as long as the same
   `Idempotency-Key` is replayed — matching `record_tap`'s own
   idempotency-first precedent for "the same physical action retried
   by a flaky connection." A *different* Idempotency-Key against an
   already-`boarded` Ticket is a genuine double-scan and returns
   `AlreadyBoarded`, `409`.
5. **Wrong trip** — payload's `trip_id` doesn't match the URL's
   `{id}`. `WrongTrip`, `400`. Guards against a validator operator
   accidentally scanning a ticket for a different trip's departure.
6. **Tampered or corrupted payload** — signature verification fails.
   `InvalidSignature`, `400`. No partial trust: a payload that fails
   verification is never decoded further for a "helpful" error message,
   since doing so would mean trusting unverified bytes.
7. **`kid` names a retired-but-still-grace-window key.** Validates
   normally — this is the entire point of the grace window.
8. **`kid` names a key not present in `TICKET_SIGNING_KEYS` at all**
   (rotated out past its grace window, or never valid). `InvalidSignature`,
   `400` — treated identically to a bad signature, since from the
   validator's point of view an unrecognized key and a forged signature
   are the same untrustworthy outcome.
9. **A `paid` Booking's Ticket is requested for a refunded/cancelled
   trip.** Named, not solved — see Non-goals. The Ticket still reports
   `issued` (or `boarded`) since nothing in this phase writes `revoked`;
   `GET /ticketing/revoked/` stays silent about it too.

## Failure modes

- **Signature verification failure.** The validate endpoint re-derives
  every fact it acts on (trip, seat, stop pair, expiry) from the
  Ed25519-verified CBOR payload alone — it never reads `trip_id` or any
  other claim from an unverified source. A forged or corrupted payload
  is rejected before any of its claimed fields are ever inspected.
- **Concurrent double-scan.** Two validator devices (or one flaky
  connection retried) submitting the same ticket at the same instant
  is resolved by the `Idempotency-Key` mechanism `apps.core.idempotency`
  already provides — the same mechanism `create_booking`/`record_tap`
  use, not a new one invented for this endpoint.
- **Clock skew between issuance and validation.** `expires_at` is
  computed and persisted once, server-side, at issuance — a validator
  device's own clock is irrelevant to whether a ticket has expired,
  since the comparison always happens against the backend's own clock
  at request time, not a client-supplied timestamp.
- **Key rotation mid-flight.** A ticket signed under a `kid` that gets
  retired between issuance and boarding still validates as long as
  operators keep that `kid` in `TICKET_SIGNING_KEYS` — the payload
  format's own `kid` claim exists specifically so rotation is "publish
  a new key, keep honoring the old one for a while," per ADR-0005, not
  a payload-breaking change.

## Test plan

**Backend** (mandatory cross-cutting tests per `docs/self-check.md`
§10.2):

- Cross-client isolation on both `GET /bookings/{id}/tickets/` and
  `POST /trips/{id}/tickets/validate/`.
- **Idempotency (mandatory)**: duplicate `POST /trips/{id}/tickets/validate/`
  requests under one `Idempotency-Key` return the identical response,
  no double state transition.
- Every edge case above, individually, as its own test.
- A signature-tamper test: flip one byte of a valid `signed_payload`,
  assert `InvalidSignature`.
- A key-rotation test: issue a ticket under key A, rotate
  `TICKET_SIGNING_ACTIVE_KID` to key B, assert the ticket still
  validates within the grace window and stops validating once the
  grace window is mocked past.
- `mark_booking_paid()` creates exactly one Ticket per Booking, even
  under a concurrency test mirroring the shape of
  `apps/seating/tests/test_seat_concurrency.py` (the `unique=True` FK
  is the actual DB-level guarantee; the test proves the ORM path
  respects it under contention, not just in the happy path).
- The `grep -rn "\.all_objects\."` tenancy-bypass audit for the new
  `apps/ticketing` module.
- Audit-log coverage for the validate action, via the existing
  `apps.core.models`'s `record_audit_event()` helper — a boarding
  event is a real operational record, same class of event as a
  settlement-run trigger.

**Frontend**:

- `customer-app`: a ticket/QR view component under the existing
  booking-detail area, reusing the `qrcode` npm dependency this
  workspace already depends on (first used by the `credentials` screen).
- `validator-app`: a `validate-ticket` component/service pair mirroring
  `record-tap/record-tap.ts` and `record-tap/record-tap.service.ts`'s
  existing structure exactly (manual payload entry, no camera).

**E2E**: pay a booking → view its ticket QR on `customer-app` → paste
its `signed_payload` into `validator-app`'s validate screen → confirm
`boarded` status is shown and persisted; a rejected scan (expired or
wrong-trip, seeded the same way `_seed_tap_and_go_fixture` seeds a
fixed known token for `seed_e2e_users`) is shown clearly, not as a
silent failure.

## Migration impact

Purely additive: one new app (`apps/ticketing`), one new model plus its
RLS-enabling migration, one new permission-seeding data migration
(`0016_seed_phase6_ticketing_permissions.py`). No existing table is
altered.

## Suggested implementation slicing

Backend-then-frontend, matching Phase 4/4b/5's own precedent — each
slice stops for review before the next starts; this spec doesn't itself
schedule when.

- **Slice 1 — issuance (backend)**: `apps/ticketing` app, the `Ticket`
  model, the CBOR/Ed25519 signing service, `issue_ticket()` wired into
  `mark_booking_paid()`, `GET /bookings/{id}/tickets/`,
  `GET /ticketing/signing-keys/`, `GET /ticketing/revoked/`.
- **Slice 2 — validation (backend)**: `POST /trips/{id}/tickets/validate/`,
  the `ticketing.validate` permission and its seed migration.
- **Frontend Slice A — customer-app**: the ticket/QR view screen.
- **Frontend Slice B — validator-app**: the validate-ticket screen.

## Implementation note (Slice 1, done)

Built exactly as spec'd, plus one more real correction found in the
same "verify before building" pass that already fixed the
`Ticket.booking`-vs-`seat_reservation` cardinality and dropped
`TICKET_KEY_GRACE_PERIOD_DAYS`: `Ticket.seat_reservation` is a
`OneToOneField`, not a plain `ForeignKey(..., unique=True)` — Django's
own system check flags the latter as redundant, and `makemigrations`
was re-run once to pick up the cleaner form before any migration
shipped.

`cbor2` and `pynacl` are this backend's first cryptography dependencies
— `apps/ticketing/signing.py` is the one module that owns every
CBOR/Ed25519 detail, structured like `apps/payments/psp/paystack.py`
(settings read lazily inside each function, one collapsed exception
type, `TicketSigningError`, for every failure mode: bad base64, bad
CBOR, unknown `kid`, bad signature — a verifier never distinguishes
between them).

**A second, more significant real bug was found and fixed while wiring
the new `TICKET_SIGNING_KEYS`/`TICKET_SIGNING_ACTIVE_KID` settings**:
`config/settings/base.py`'s existing `PAYSTACK_SECRET_KEY`/
`PAYSTACK_WEBHOOK_SECRET`/`INTEGRA_COMMISSION_RATE_PERCENT` (and, it
turns out, `SECRET_KEY` itself) are bare `decouple.config("X")` calls
with no default — and a bare call like that executes unconditionally
the instant the settings module is imported (`from .base import *`),
raising `UndefinedValueError` immediately in any process with neither
a matching OS env var nor a `.env` file, *before* `local.py`'s/`ci.py`'s
own `default=`-carrying override lines are ever reached. Those override
lines only look like a working safety net because `backend/.env`
(gitignored, present on every developer's machine) already supplies
real values for everything `base.py` asks for — they've never actually
been exercised as a fallback. Confirmed live: `.github/workflows/ci.yml`
sets no `PAYSTACK_*`/`DJANGO_SECRET_KEY`/etc. env vars, and CI's
checkout has no `.env` (gitignored, never committed), so this same
mechanism would raise `UndefinedValueError` the moment `manage.py
migrate` or `pytest` first imports Django settings in a real CI run —
this looks like a pre-existing, unrelated defect in how every secret
in this codebase is wired, not something this slice introduced. Fixed
for the *new* ticketing settings only (fixing the pre-existing ones was
out of scope for this slice, flagged for separate follow-up): `base.py`
now gives `TICKET_SIGNING_KEYS`/`TICKET_SIGNING_ACTIVE_KID` an
empty-string `default=""` (keeps `local.py`/`ci.py` importable no
matter what), `local.py`/`ci.py` hardcode their fixed test keypair as a
plain assignment (bypassing `config()` entirely, the same way `ci.py`
already hardcodes its own `SECRET_KEY` literal), and `staging.py`/
`production.py` each re-declare the setting with their own bare,
no-default `config()` call — which is what actually enforces "must
never silently default" for a real environment, not `base.py`'s own
line.

**A third real bug, cross-cutting into `apps/payments`'s existing test
suite**, was found only by running the full test suite after wiring
`issue_ticket()` into `mark_booking_paid()`: `apps/payments/tests/
booking_helpers.py`'s shared `booking_with_a_held_seat()` fixture built
its `Trip` via `TripFactory`'s own hardcoded default
`scheduled_departure_at` (a fixed calendar date in the past relative to
whenever tests actually run) — harmless before this slice, since
nothing previously checked a Trip's departure time against "now," but
`Ticket.expires_at` (anchored to `trip.scheduled_departure_at`, per
this spec's own Data model section) must be *after* `Ticket.issued_at`
(real "now"), enforced by a DB `CheckConstraint`. Four previously-green
tests in `apps/payments/tests/` broke the moment ticket issuance
started running inside the same `mark_booking_paid()` call they already
exercised. Fixed at the fixture, not by loosening the constraint:
`booking_with_a_held_seat()` now builds its `Trip` with an explicit
near-future `scheduled_departure_at` (`timezone.now() +
timedelta(hours=2)`) instead of `TripFactory`'s own stale default —
correct on its own terms too, since a real booking is never taken for
an already-departed trip.

17 new tests (backend), 497/497 passing (up from 480). `uv run ruff
check .` and `uv run mypy .` clean; `manage.py makemigrations --check`
clean; `./scripts/check_openapi_drift.sh` clean after two view classes
(`SigningKeysView`, `RevokedTicketsView`) needed an explicit
`@extend_schema` — neither has a `serializer_class` backed by a model,
the same reason `apps.tapngo.views.TapCredentialCreateView` already
needed one; `npm run openapi:generate && npm run openapi:check` clean
on the frontend side, and `npm run build:all` confirmed no repeat of
Phase 5's `booking-list.ts`-style regression from the newly-typed
schema. A manual round-trip against the real dev Postgres database
(outside pytest, using the real test factories, rolled back after)
confirmed `mark_booking_paid()` → `Ticket` creation → `signing.verify_and_decode()`
works end to end, not just under mocked/in-memory conditions.

**Not built this pass, as agreed**: `POST /trips/{id}/tickets/validate/`
and the `ticketing.validate` permission (Slice 2), and both frontend
slices.

## Implementation note (Slice 2, done)

Built exactly as spec'd: `apps.ticketing.services.validate_ticket()`
mirrors `apps.tapngo.services.record_tap()`'s shape (idempotency-key
lookup first, one typed exception per edge case — `InvalidSignature`,
`TicketNotYetValid`, `TicketExpired`, `TicketRevoked`, `WrongTrip`,
`UnknownTicket`, `AlreadyBoarded` — each mapped to its own HTTP status
by `TicketValidateView`), `apps/identity/migrations/
0016_seed_phase6_ticketing_permissions.py` seeds `ticketing.validate`,
and `apps.identity.services.DEFAULT_ROLE_PERMISSIONS` grants it to the
Manager/Staff presets alongside `tapngo.record`/`tapngo.view` (two
pre-existing tests — `test_roles.py`, `test_me_permissions.py` — hardcode
the exact expected permission set per Role and needed their exhaustive
lists updated, the same class of change Phase 5's `booking-list.ts`
regression already established a precedent for).

**A real concurrency bug was found and fixed only by running the
mandatory concurrency test, not by review**: the first version of
`validate_ticket()` checked `if ticket.status == Ticket.Status.BOARDED:
raise AlreadyBoarded` immediately after acquiring the row lock, with no
awareness that the request racing it to that lock might be a *matching*
replay under the exact same Idempotency-Key, not a genuine second scan.
Sequence: two requests under the same key both pass the initial
idempotency-key lookup (neither has written its `IdempotencyKey` row
yet), then both reach `select_for_update()` — the first acquires the
lock, transitions the ticket to `boarded`, writes its `IdempotencyKey`
row, and commits; the second, unblocked once the lock releases,
re-reads the now-`boarded` ticket and raised `AlreadyBoarded` even
though it was carrying the identical key and payload as the request
that just succeeded. Caught immediately by
`test_concurrent_validate_under_one_idempotency_key_boards_exactly_once`
(8 threads, same key, same payload — every response must be identical).
Fixed by re-checking for a matching `IdempotencyKey` record (now
race-free, since it happens after the row lock is held) before
concluding a `BOARDED` status means a genuine conflict — a distinct
class of race from `create_booking`'s/`record_tap`'s own
`IntegrityError`-triggered reconciliation (there's no database
constraint backing `AlreadyBoarded`, since ticket boarding isn't a
uniqueness violation, just an application-level status check racing an
identical concurrent request), so the fix is a second, deliberate
`IdempotencyKey` lookup, not a caught exception.

Two smaller, real test-only bugs were also caught and fixed while
writing this slice's own tests, both before they ever reached a shared
fixture: an expired-ticket test tried to set `expires_at` to the past
while leaving `issued_at` at issuance time, violating the model's own
`expires_at > issued_at` `CheckConstraint` — fixed by moving both
fields into the past together, preserving the same constraint. Every
worker thread in the new concurrency test needed its own
`transaction.atomic()` + `tenant_context()` wrapping around
`validate_ticket()` (mirroring `test_tapngo_concurrency.py`'s own
precedent) — `validate_ticket()`, unlike `mark_booking_paid()`, has no
`platform_staff_bypass()` of its own, since it's designed to run inside
a real authenticated request's ambient tenancy context, not a webhook's.

14 new tests (backend), 511/511 passing (up from 497). `uv run ruff
check .` and `uv run mypy .` clean (one `UUID(...)` cast and one
generic-type-parameter fix — `TicketValidateView` must be typed
`GenericAPIView[Trip]`, matching what `get_queryset()` actually returns,
not `GenericAPIView[Ticket]`, the same shape `apps.tapngo.views.TapRecordView`
already establishes); `manage.py makemigrations --check` clean;
`./scripts/check_openapi_drift.sh` clean; `npm run openapi:generate &&
npm run openapi:check` clean, `npm run build:all` clean. A manual
round-trip against the real dev Postgres database (outside pytest,
rolled back after) confirmed issue → validate → idempotent-replay →
genuine-second-scan-rejected works end to end.

**Phase 6's backend arc is now complete.** Both frontend slices
(customer-app's ticket/QR view, validator-app's validate-ticket screen)
remain unbuilt.

## Implementation note (Frontend Slice A, done)

Built exactly as spec'd, no backend change needed — `GET
/bookings/{id}/tickets/` and the `Ticket`/`PaginatedTicketList`
`api-client` types were already generated by Slice 1.

`customer-app` gained one new route, `my-bookings/:id/tickets` →
`booking/booking-tickets.ts`/`.html` — the workspace's first route with
a path param (every prior screen was either flat or passed data via
`router.navigate([...], { state })`, which doesn't survive a refresh;
a ticket is a bookmarkable, revisitable resource, so a real param fits
better than router state here). `my-bookings.ts`/`.html` gained a
"View tickets" action, rendered only for `status === 'paid'` rows,
alongside the existing `Pay now`/`Cancel` actions.

The new screen follows `my-credentials.ts`'s shape exactly rather than
introducing a `ListStore`: no nested/parent-scoped small-list precedent
existed anywhere in the workspace (no store anywhere passes `params: {
path: ... }`), and a Booking's Tickets are a handful of rows with no
real pagination, so component-local signals plus a direct `API_CLIENT`
call (matching `booking-confirm.ts`'s equivalent shape) fit better than
forcing one. QR rendering reuses the exact same `toDataURL(payload, {
width: 220, margin: 1 })` call `my-credentials.ts` already established,
generalized to a `Record<ticketId, dataUrl>` since a group booking
renders one QR per seat.

93/93 `customer-app` Karma tests passing (up from 86), including a new
`booking-tickets.spec.ts` and two additions to `my-bookings.spec.ts`.
One pre-existing test in `my-bookings.spec.ts`
("renders the paid status pill with no pay or cancel actions") had to
be updated — it asserted zero actions on a `paid` row, which this
slice makes no longer true. `npx ng lint customer-app` clean, `npm run
build:all` clean across all four apps (one pre-existing, unrelated
`NG8102` warning in `client-admin-app`'s `trip-list.html`, untouched by
this slice).

**A real environment gap, found while trying to verify this live, not
fixed (out of scope for a frontend slice)**: `docker compose build
backend` fails in this sandbox — `uv sync --frozen` inside the
Dockerfile times out downloading `pynacl`/`django-celery-beat`'s wheels
over this environment's network, on two separate attempts, one with a
(silently ineffective — the Dockerfile declares no matching `ARG`/`ENV`)
longer `UV_HTTP_TIMEOUT` build-arg. The backend Docker image therefore
still predates Phase 6's `cbor2`/`pynacl` dependencies and crashes on
import (`ModuleNotFoundError: No module named 'cbor2'`) the moment
`apps.booking.urls` pulls in `apps.ticketing.services`. Not a code
defect — `uv run pytest` (511/511) and a real HTTP round-trip both
verify fine against the local `uv`-managed environment, which already
has both packages installed. Whoever next has reliable network access
should run `docker compose build backend` once to refresh the image;
until then, local backend work in this sandbox should run via `uv run
python manage.py runserver` directly against the already-running
`postgres`/`redis` containers (`.env`'s `POSTGRES_HOST=localhost`
already supports this) rather than `docker compose up backend`.

Verification, given the above: `uv run pytest` re-confirmed 511/511
green; a real Booking was created and paid via `create_booking()`/
`mark_booking_paid()` (not pytest — a genuine dev-DB row, left in place
as a real fixture) for the seeded e2e passenger
(`e2e-passenger@example.com`), then `GET
/bookings/{id}/tickets/` was called over real HTTP with a real
password-grant JWT and returned the exact two-ticket shape the new
screen expects (`{count, results: [{id, signed_payload, status,
issued_at, expires_at, boarded_at}, ...]}`). No browser-automation tool
was available in this session to literally click through the rendered
screen — per this project's own standing rule to say so rather than
claim an unverified success, that specific check (does the QR visually
render, does the status pill visually read "Issued") is **not** covered
here, only by the Karma spec's DOM assertions on the same markup.

One frontend slice remains: **Frontend Slice B — validator-app's
validate-ticket screen.**

## Implementation note (Frontend Slice B, done)

Built exactly as spec'd, no backend change needed — `POST
/trips/{id}/tickets/validate/` and the `TicketValidate`/
`TicketValidationResult` `api-client` types were already generated by
Slice 2.

`validator-app` gained a second screen, `validate-ticket/validate-ticket.ts`/
`.html`/`.service.ts`, mirroring `record-tap`'s component/service split
exactly: `ValidateTicketService` owns every API call (the component
never touches `API_CLIENT`), returns the same
`{ok:true;data}|{ok:false;status;message}` discriminated union,
generates a fresh `Idempotency-Key` per submit, and reuses the exact
`toErrorMessage()` shape that just extracts `error.detail` — no
per-typed-exception switch needed on the frontend, since
`apps/ticketing/views.py` already turns every typed exception into a
`{"detail": "<message>"}` body. The trip picker mirrors `record-tap`'s
(same `loadTripsForDate` shape, scheduled + in_progress merged), but
filters to the *opposite* `booking_mode` — `!== 'tap_and_go'` instead
of `=== 'tap_and_go'` — since only reservation-mode trips produce
Tickets via `mark_booking_paid()`. No stop picker exists on this
screen: a ticket's stop pair is already encoded in the signed payload
and comes back in the validation result, so there's nothing to pick.

**One real design gap found and closed, not spec'd in advance**:
`validator-app`'s `AppShell` had no navigation at all — its own
docstring justified this as deliberate because the app had "exactly
one screen." That stopped being true the moment this slice added a
second route. Fixed with two plain `routerLink` text links in the
existing bespoke header (still not `@layout`'s `NavShell` — two links
isn't the multi-section sidebar NavShell exists for), rendered
unconditionally rather than behind `*appHasPermission`: each route
already has its own `permissionGuard`, and `tapngo.record`/
`ticketing.validate` are always granted together in
`DEFAULT_ROLE_PERMISSIONS`, so gating the links themselves would add
directive/test plumbing for zero practical benefit.

31/31 `validator-app` Karma tests passing (up from 20 before this
slice — `record-tap`'s existing 15 plus `app.spec.ts`/`login.spec.ts`'s
existing 5, plus 11 new: 5 in `validate-ticket.spec.ts`, 5 in
`validate-ticket.service.spec.ts`, 1 new assertion added to
`app-shell.spec.ts`). `npx ng lint validator-app` clean, `npm run
build:all` clean across all four apps.

Verified against the real dev DB, the same workaround Slice A's own
implementation note already named (this sandbox's `docker compose
build backend` still can't complete — not re-attempted here): ran the
backend via `uv run python manage.py runserver` against the
already-running `postgres`/`redis` containers, logged in as the seeded
`e2e-client-staff@example.com` (Owner role, so it carries
`ticketing.validate` same as every other permission), and called `POST
/trips/{id}/tickets/validate/` over real HTTP three times against one
of the two real Tickets Slice A's own verification created: first
scan → `200 {"status":"boarded", ...}`; a replay under the *identical*
Idempotency-Key → the identical `200` result; a *different* key
against the now-boarded ticket → `409 {"detail":"This ticket has
already been boarded."}` — exactly the three states
`ValidateTicket`'s success/idempotent-replay/error paths are built to
handle. As with Slice A, no browser-automation tool was available this
session, so the rendered screen itself wasn't visually clicked through
— that specific check is covered only by the Karma specs' DOM
assertions on the same markup, not by this HTTP-level verification.

**Phase 6 is now fully complete: backend and both frontend slices.**
