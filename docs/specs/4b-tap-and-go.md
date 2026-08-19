# 4b-tap-and-go: Tap-and-go fare determination

Referenced as Phase "4b" in `docs/status-report-2026-08-14.md` §4 —
sequenced after Phase 4 (Fares, Seating, Booking) and before Phase 5
(Payments, Wallet, Ledger), since it depends on `apps.fares.services`
and produces the record Phase 5 will eventually charge against, but
needs neither seat reservations nor payment collection itself.

This spec resolves the question ADR-0004 explicitly left open:

> How `tap_and_go` fare collection actually works is a real, still-open
> question — explicitly not answered here, and not silently assumed
> either; it is a named non-goal of
> `docs/specs/4-fares-seating-booking.md`.

and the one open question `docs/status-report-2026-08-14.md` §4 named
as this slice's own responsibility to settle: **what a passenger
presents at the validator.** Answered below (§ "Tap identifier"),
confirmed directly with the product owner rather than assumed.

## Scope and non-goals

**In scope**: recording a board tap and an alight tap against a
`tap_and_go`-mode Trip, resolving the travelled segment the same way
`apps.seating` already does (via `RouteStop.sequence`), pricing it
through the existing `apps.fares.services.get_fare()` (unchanged,
already dispatches on `Business.fare_pricing_mode` — flat or
per-segment, tap-and-go doesn't care which), and producing a
`FareJourney` record that Phase 5 will later charge. A minimal internal
staff-operated web harness that drives this API, standing in for the
not-yet-built Flutter validator app's button presses.

**Non-goals** (each a deliberate boundary, not an oversight):

- **Fare collection.** A closed `FareJourney` has an `amount` and a
  `status`; nothing charges it. That's Phase 5, same terminus pattern
  `Booking.status == pending_payment` already established.
- **The real Flutter validator app, or any real NFC/QR scanning
  hardware/SDK integration.** The harness (§ "Operator harness") is a
  plain HTML form that already assumes a token has been decoded by
  *something* — a camera, an NFC reader, a person typing it in. What
  does that decoding is out of scope here and belongs to whichever app
  eventually replaces the harness.
- **QR image rendering or NFC tag/HCE provisioning.** The API returns
  and accepts a raw token string. Turning that string into a scannable
  QR image, or writing it to a phone's NFC HCE session or a physical
  card, is client-side work for a future customer-app/mobile slice.
- **A staff remediation workflow for `needs_review` journeys.** This
  slice makes `needs_review` journeys visible (§ API surface); resolving
  one (assigning a fare manually, voiding it) has no dedicated endpoint
  yet. Named explicitly so it doesn't read as forgotten.
- **Enforcing "one open journey" across operators.** See Edge case 9 —
  a real, named gap, not silently assumed away.
- **QR ticket signing (ADR-0005).** That ADR is about a *paid ticket's*
  tamper-proof payload for Phase 6 and is still Proposed. A tap
  credential is a different, much lower-stakes artifact — see "Tap
  identifier" below for why this spec doesn't wait on that ADR.

## Tap identifier

**Decision** (confirmed with the product owner, 2026-08-14): a
passenger can present **either a QR code or an NFC device (phone card
emulation, physical card, or watch)**. Both resolve through the same
backend concept — an opaque, per-credential bearer token — so the API
is transport-agnostic: it never learns or cares whether the token was
decoded from a camera frame or an NFC read, only that a token string
arrived in the request body.

**Why not reuse ADR-0005's signed-ticket scheme.** ADR-0005 (Ed25519
QR ticket signing) is about proving a *paid* ticket is authentic and
unmodified, offline, with revocation semantics — a materially harder
problem this codebase has correctly deferred. A tap credential proves
something much smaller: "the bearer of this token claims to be this
passenger." It doesn't need offline verification (the harness/validator
always calls the real API online), doesn't need to survive a fare
dispute on its own (the `TapEvent`/`FareJourney` audit trail does that),
and is cheap to revoke and reissue. Waiting on ADR-0005 to finalize
before building this would block a materially simpler feature on a
harder one it doesn't actually need.

**Design**: `TapCredential.token` is a high-entropy random string
(`secrets.token_urlsafe(32)`), generated server-side, returned to the
passenger **once**, at issuance. The database stores only a SHA-256
hash of it (`token_hash`, unique) — mirroring how a leaked database
shouldn't hand out usable bearer credentials, the same reasoning
`IdempotencyKey.request_hash` already applies to request bodies
elsewhere in this codebase. If a passenger loses their credential (lost
card, uninstalled app), they issue a new one and deactivate the old —
there is no "reveal it again" flow, deliberately.

## Data model changes

New app: `apps/tapngo`. All three models are `BaseModel` subclasses,
RLS-enabled via `EnableRowLevelSecurity` in the first migration exactly
like every other domain app (`apps/fares/migrations/0001_initial.py` is
the direct precedent).

### `TapCredential`

| Field | Type | Notes |
|---|---|---|
| `passenger` | FK → `identity.User`, PROTECT | Owner. A passenger may hold several (one QR, one NFC card, etc.). |
| `token_hash` | `CharField(64)`, unique | SHA-256 hex digest. Raw token never stored. |
| `channel` | `CharField`, choices `qr`/`nfc` | Informational only — resolution logic doesn't branch on it. |
| `label` | `CharField`, blank | e.g. "NFC card ending 4F2A" — passenger-facing, optional. |
| `is_active` | `BooleanField`, default `True` | Revocable. |

### `FareJourney`

One open→closed lifecycle per board/alight pair, the tap-and-go
analogue of `SeatReservation`'s `held`→`confirmed` lifecycle — but
without the seat/hold concept, since there's no inventory to protect,
only a "don't double-count this passenger" invariant.

| Field | Type | Notes |
|---|---|---|
| `business` | FK → `businesses.Business`, PROTECT | |
| `trip` | FK → `scheduling.Trip`, PROTECT | Must be `booking_mode == TAP_AND_GO`. |
| `passenger` | FK → `identity.User`, PROTECT | Denormalized from `credential.passenger`, matching the `Trip.business`/`Trip.booking_mode` denormalization precedent — read/audit convenience, not a new source of truth. |
| `credential` | FK → `TapCredential`, PROTECT | The credential that opened the journey. |
| `board_stop` / `alight_stop` | FK → `network.Stop`, PROTECT | `alight_stop` null until closed. |
| `status` | `CharField`, choices `open`/`closed`/`needs_review`/`abandoned` | See lifecycle below. |
| `amount` / `currency` | `DecimalField(10,2)` / `CharField(3)` | Null until `closed`. `currency` snapshotted from `Business.currency`, matching `Booking.currency`. |
| `fare_rule` / `fare_segment_rule` | FK, PROTECT, nullable | Exactly one populated on close — same `CheckConstraint` shape `SeatReservation` already uses. |
| `boarded_at` / `alighted_at` | `DateTimeField` | Server-assigned, not client-supplied (§ Failure modes). |

```python
constraints = [
    models.UniqueConstraint(
        fields=["business", "passenger"],
        condition=models.Q(status="open"),
        name="one_open_fare_journey_per_business_passenger",
    ),
    models.CheckConstraint(
        check=~(models.Q(fare_rule__isnull=False) & models.Q(fare_segment_rule__isnull=False)),
        name="fare_journey_at_most_one_fare_rule",
    ),
]
```

The partial unique constraint is the concurrency mechanism (§ Test
plan) — a plain Postgres partial unique index, not a GiST exclusion
constraint, because this isn't a range-overlap problem like seat
segments; it's "at most one row with `status='open'` per
`(business, passenger)`," which a partial unique index enforces
directly and atomically.

### `TapEvent`

An immutable append-only record of each physical tap — kept distinct
from `FareJourney` (which mutates as it moves open→closed) so a dispute
or audit always has the raw sequence of taps, not just the journey's
final state.

| Field | Type | Notes |
|---|---|---|
| `business` / `trip` | FK, PROTECT | |
| `credential` | FK → `TapCredential`, PROTECT | |
| `journey` | FK → `FareJourney`, PROTECT | The journey this tap opened or closed. |
| `tap_type` | `CharField`, choices `board`/`alight` | |
| `stop` | FK → `network.Stop`, PROTECT | Where the tap occurred (§ Assumption below). |
| `tapped_at` | `DateTimeField` | Server-assigned. |

**ASSUMPTION**: the validator explicitly selects which `Stop` a tap
occurred at (a dropdown populated from the Trip's Route, ordered by
`RouteStop.sequence`) rather than deriving it from GPS or a
fixed-reader location — there's no location-sensing hardware in scope
yet (the harness is a web form), and this mirrors how a conductor on a
real minibus would operate a handheld reader today.

## API surface

Two audiences: passengers manage their own credentials; staff operate
the validator harness.

### Passenger-facing (customer-app-consumable, no UI built this slice)

- `POST /tap-credentials/` — issue a credential. Body: `{channel: "qr"|"nfc", label?: string}`. Response `201`: `{id, token, channel, label, is_active, created_at}` — **`token` appears only in this one response, never again.**
- `GET /tap-credentials/mine/` — list own credentials. `token` omitted from the response entirely (only `id`/`channel`/`label`/`is_active`/`created_at`).
- `PATCH /tap-credentials/{id}/` — `{is_active: false}` only; own credentials only.
- `GET /fare-journeys/mine/` — own journey history, paginated, parity with `GET /bookings/mine/`.

### Staff-facing (permission-gated, new codenames `tapngo.record` / `tapngo.view`, following the existing `HasPermission(codename)` pattern)

- `POST /trips/{trip_id}/taps/` — the validator action. Body: `{token: string, tap_type: "board"|"alight", stop_id: uuid}`, `Idempotency-Key` header required (same transport `apps.booking`'s `create_booking` already uses). Requires `tapngo.record`. Response `201`: the `TapEvent`, with its `journey` nested (`id`, `status`, `amount`, `currency` when closed).
- `GET /fare-journeys/` — staff list, filterable by `trip`/`status`, read-only (mirrors `GET /bookings/` for staff — no staff-side mutation of a journey exists this slice). Requires `tapngo.view`.

### Operator harness

**Superseded from this spec's original draft, which called for "a
single unstyled page under `client-admin-app`... not held to the
`shared-ui` design-language or accessibility bar."** Built instead
(2026-08-16, on direct request) as `validator-app` — a fourth
first-class Angular app in the workspace, an installable PWA, gated on
`tapngo.record`, using the same `@shared-ui`/`@auth`/`@layout`/
`@api-client` primitives and conventions every other app in this
workspace uses. See this spec's own "Implementation note (frontend,
done)" below for the full account of what changed and why the original
"unstyled, exempt from the a11y bar" framing turned out to be the wrong
call once a real installable tool was what got asked for.

One screen, matching the original scope's own list: pick a Trip,
enter/scan a token, pick a tap type, pick a stop, submit, show the
result.

## Edge cases

1. **Board tap while the passenger already has an open journey** (same
   Business, any Trip). Rejected — `409 OpenJourneyExists`, DB-enforced
   by the partial unique constraint.
2. **Alight tap with no open journey** for that credential on that Trip.
   `404 NoOpenJourney`. No `TapEvent` row is written for a rejected
   attempt — mirrors how a `Booking` never gets created when
   `get_fare()` fails in the reservation flow.
3. **Alight at the same stop as boarding.** Rejected before any write —
   `400 InvalidAlightStop`. Treated as passenger/staff error (accidental
   double-tap), not a zero-fare journey.
4. **Alight at a stop earlier in route sequence than the board stop.**
   Rejected — `400 InvalidAlightStop`, same `RouteStop.sequence`
   ordering check `apps.seating.services._segment_sequence_range`
   already performs. The journey **stays open** — a bad tap shouldn't
   cancel a trip the passenger is still legitimately on.
5. **No fare rule covers the resolved segment** (`FareNotConfigured`
   from `get_fare()`). **Deliberately different from the booking flow's
   404-and-reject.** The passenger already physically rode the vehicle
   by the time they tap out — there's no sane "reject the alight tap and
   make them undo the ride." Instead: the alight `TapEvent` **is**
   persisted, the journey transitions to `needs_review` (not `closed`),
   `amount` stays null. Response is `201`, not an error — the harness
   shows "recorded, flagged for fare review," not a failure. This is an
   operator fare-configuration gap, not a passenger or validator error.
6. **Trip not in `tap_and_go` mode.** `400`, mirrors
   `BookingCreateSerializer`'s existing rejection of `tap_and_go` trips
   in the reservation flow (`apps/booking/serializers.py:85`), inverted.
7. **Trip status is `COMPLETED`/`CANCELLED`.** `400` — taps only accepted
   while `SCHEDULED` or `IN_PROGRESS`.
8. **Unknown token.** `404` (distinct from #9 below — staff need to be
   able to tell a passenger which happened).
9. **Inactive/revoked credential.** `403`.
10. **Duplicate/retried tap request** (harness network retry). Standard
    `apps.core.models.IdempotencyKey` semantics: same key + same body →
    replays the original response; same key + different body →
    `IdempotencyKeyConflict` (`409`).
11. **A passenger has simultaneous open journeys across two different
    operators (different Businesses/Clients).** **Named, not solved.**
    The uniqueness constraint is scoped to `(business, passenger)`
    because RLS partitions every table by client/tenant — a true
    cross-operator global constraint would fight that boundary and
    isn't attempted here. Physically implausible (one passenger, one
    body, can't ride two vehicles from two unrelated operators at once)
    but not impossible to trigger by mistake or misuse; flagged as a
    known limitation of a per-tenant data model, same category of
    tradeoff as every other cross-Business gap this platform already
    accepts.

## Failure modes

- **Torn writes.** Each tap (`TapEvent` create + `FareJourney`
  open/close) happens inside one `transaction.atomic()` block, matching
  `create_reservation`/`create_booking`'s existing pattern — no
  intermediate state is ever visible or persisted.
- **Concurrent board taps for the same passenger.** The partial unique
  constraint is the enforcement mechanism, not an application-level
  pre-check (same reasoning as ADR-0004: always attempt the write, let
  Postgres decide). `IntegrityError` on that constraint →
  `OpenJourneyExists` (`409`), caught the same way
  `create_reservation` catches its own exclusion-constraint violations.
- **Token guessing.** Tokens are 32 bytes of CSPRNG output
  (`secrets.token_urlsafe(32)`), stored hashed — brute-forcing one is
  not computationally realistic. The `POST /trips/{id}/taps/` endpoint
  should carry a throttle scope (reusing this codebase's existing
  rate-limiting conventions) as defense in depth; possession of the
  physical device/QR image remains the primary control, same trust
  model any physical transit card system relies on.
- **Server-assigned timestamps.** `tapped_at`/`boarded_at`/`alighted_at`
  are always `timezone.now()` at write time, never client-supplied —
  a harness or future validator app has no way to backdate or reorder
  taps.

## Test plan

**Backend** (mandatory cross-cutting tests per `docs/self-check.md`
§10.2, same bar every prior domain app was held to):

- Cross-client isolation: a staff user from Business A cannot record or
  view taps/journeys against Business B's trips.
- **Concurrency (mandatory)**: N concurrent board-tap requests for the
  same `(business, passenger)` — exactly one `FareJourney` opens, the
  rest receive `409 OpenJourneyExists`. Simpler mechanism than ADR-0004's
  spike (a partial unique index, not a GiST range constraint) but the
  same "always attempt the write, let the DB decide, run it for real
  under real concurrency" standard applies — this is not exempt from
  that bar just because the constraint is simpler.
- Idempotency: replay of an identical `POST /trips/{id}/taps/` request
  returns the original response; a same-key-different-body replay
  returns `409 IdempotencyKeyConflict`.
- Every edge case in the section above, individually.
- `N+1` check on `GET /fare-journeys/` (staff list) — `select_related`
  on `trip`, `credential`, `fare_rule`/`fare_segment_rule`.
- `grep -rn "\.all_objects\."` over `apps/tapngo` — same tenancy-bypass
  audit every prior phase's self-check has run.
- Audit coverage: credential issuance/revocation, every tap, and every
  journey status transition each call `record_audit_event`.

**Frontend**: superseded — see "Implementation note (frontend, done)"
below. `validator-app` got full Karma coverage (service + component,
including the real API contract shapes), not just "basic" coverage, per
the same bar every other app in this workspace is held to.

**E2E**: not built as a permanent Playwright spec this pass — verified
instead via a one-off scripted browser run against the real backend
(login → trip/stop pickers populated from real data → board tap → alight
tap → correct fare amount shown), described in the implementation note.
A permanent `frontend/e2e/validator-app/` spec, matching this
codebase's established convention, is real follow-up work, not
something this pass silently skipped without saying so.

## Migration impact

Purely additive. New app (`apps/tapngo`), three new models, zero
changes to any existing model or migration. No destructive migrations —
unlike the fare-versioning addendum
(`docs/specs/4-fares-seating-booking-versioning.md`), this slice needs
no approval gate for a destructive step because there isn't one.

## Implementation note (backend, done)

Built as spec'd, in one pass, backend only — matching the plan agreed
before implementation started (frontend/harness explicitly deferred,
see below). `apps/tapngo` (`TapCredential`, `FareJourney`, `TapEvent`),
all six endpoints, the two new permission codenames (`tapngo.record`,
`tapngo.view`, seeded via `apps/identity/migrations/
0011_seed_phase4b_tapngo_permissions.py` and added to both Manager and
Staff's default permission set — Owner gets them automatically per
`DEFAULT_ROLE_PERMISSIONS["Owner"] = None`). 37 new tests, all passing
(383/383 backend-wide, up from 346); `ruff`/`mypy` clean;
`makemigrations --check` clean; OpenAPI regenerated and drift-checked
clean. The mandatory concurrency spike
(`apps/tapngo/tests/test_tapngo_concurrency.py`, 6 concurrent board taps
for the same passenger, exactly one succeeds) passed cleanly across 3
consecutive fresh-database runs.

**One real correction to this spec, made during implementation**: the
`FareJourney` data-model table above lists `abandoned` as a fourth
status alongside `open`/`closed`/`needs_review`. That was a drafting
error — nowhere else in this spec is a transition into `abandoned` ever
defined (no sweep job, no manual staff action was specified), so it
would have been a dead enum value with no code path ever setting it.
Implemented with three statuses only (`open`/`closed`/`needs_review`).
If a real need for an "abandoned" state emerges later (e.g. a
forgot-to-tap-out sweep job), that's new scope for its own spec
addendum, not a gap silently patched here.

**Not built this pass, as agreed**: the customer-app credential-issuance
UI and a permanent Phase 4b E2E spec. The operator harness itself was
*not* left for later — see the next implementation note; it landed the
same week, on direct follow-up request, as a full `validator-app`
rather than the unstyled page originally scoped here.

## Implementation note (frontend, done)

Built 2026-08-16, immediately after the backend note above, on direct
request to build the operator harness "as a frontend pwa app... using
same frontend stacks and rule we have been using" — a materially
different brief than this spec's own original "single unstyled page...
not held to the shared-ui design-language or accessibility bar."
Delivered as `validator-app`: a fourth Angular app in the workspace
(alongside `customer-app`/`client-admin-app`/`super-admin-app`),
installable as a PWA (`@angular/pwa` scaffolding — manifest, service
worker, `ng serve validator-app` on port 4203), using
`@shared-ui`/`@auth`/`@layout`/`@api-client` the same way every other
app does, not exempted from either.

**Shape**: `login` (client-admin JWT audience — `tapngo.record` is an
ordinary Role/Permission codename, not a new audience) → a bespoke
minimal top-bar `AppShell` (not `@layout`'s `NavShell`, which is built
for a multi-section back-office console; this app has exactly one
screen) → `record-tap`, the one screen the original scope named: service
date → trip picker (`GET /trips/`, merging `scheduled`+`in_progress`
since the query serializer only accepts one status per request,
filtered client-side to `booking_mode === 'tap_and_go'` since no
server-side filter for that exists) → token field → board/alight toggle
→ stop picker (`GET /routes/?business=`, the existing `network.view`-
gated endpoint every Manager/Staff role that can reach `tapngo.record`
already has, since no single-route GET exists) → submit
(`POST /trips/{id}/taps/`, a fresh `Idempotency-Key` per tap) → a
success/error result banner.

**Two real bugs found and fixed, not by static review — by actually
running it**, per this repo's own "start the dev server and use the
feature in a browser" standard:

1. **CORS**: `config.settings.local`'s `CORS_ALLOWED_ORIGINS` hardcoded
   the three existing apps' ports (4200-4202) and had no mechanism to
   pick up a fourth. Every request from `validator-app` (port 4203)
   failed at the browser's preflight check, not at the API. Fixed in
   `backend/config/settings/local.py` and `docker-compose.yml`'s
   `backend` service env. A real, if narrow, gap in this repo's own
   process: nothing before now had ever added a fourth Angular app, so
   nothing had exercised this.
2. **`ui-button`'s `[attr.aria-pressed]` silently landing on the wrong
   element.** `ui-button`'s host is `{ class: 'contents' }` — a host-level
   attribute binding lands on the `<ui-button>` wrapper, never the real
   inner `<button>` a screen reader actually reads. The board/alight
   toggle's `[attr.aria-pressed]` binding (bound directly on `<ui-button>`
   in the first draft of `record-tap.html`) was consequently inert —
   caught only because a scripted browser check asserted on the real
   `<button>` element's attributes and failed. Fixed at the shared
   component, not worked around locally: `Button` gained a proper
   `ariaPressed` input (`projects/shared-ui/src/lib/button.ts`) that
   binds `[attr.aria-pressed]` on the actual inner `<button>`, with
   Karma coverage proving the wrapper-vs-inner-element distinction
   directly. Any future toggle-style `ui-button` usage anywhere in this
   workspace gets this for free now.

**Verification performed**: `ng build`/`ng lint`/`ng test` all clean for
`validator-app` and (after the `Button` change) `shared-ui`; the full
`npm run test:all` (24 Karma suites across every app/library),
`build:all`, and `openapi:check` all still clean afterward. Beyond
static checks, a real scripted Playwright browser run against the live
backend (fresh `Client`/`Business`/`Route`/`Stop`/`FareRule`/`Trip`/
`TapCredential` fixtures created directly via the backend's own service
functions, matching the pattern `apps/seating/tests/test_seat_concurrency.py`
already uses for setup) drove the actual UI end to end: signed in,
watched the trip and stop pickers populate from real API responses,
recorded a real board tap and a real alight tap, and confirmed the
screen showed the correct closed-journey fare amount from the fare rule
that was configured. This is what caught both bugs above — reading the
code would not have.

**Not built this pass**: a permanent `frontend/e2e/validator-app/`
Playwright spec (the scripted run above was one-off verification, not
committed to the suite), the customer-app credential-issuance screen,
and the full `self-check.md` §10.6 visual-iteration/axe loop this
codebase's product UI is normally held to — reasonable given this is
one focused screen rather than a multi-page surface, but named
explicitly rather than silently assumed equivalent to having been done.

## Implementation note (Frontend — customer-app credential UI, done)

Phase 4b's other still-open item, closed out as its own slice (2026-08-17),
one app at a time per this project's Phase 5 frontend precedent — the
permanent `frontend/e2e/validator-app/` spec remains the one item still
open (see the prior implementation note's own "Not built this pass").

**No backend change was needed.** `POST /tap-credentials/`,
`GET /tap-credentials/mine/`, and `PATCH /tap-credentials/{id}/` were
already built and already documented above as "Passenger-facing
(customer-app-consumable, no UI built this slice)" — this slice is pure
frontend, the first Phase 4b/5-era slice with zero backend surface.

Built `customer-app`'s `credential/my-credentials.ts`/`.html` (new
`TapCredentialStore`, mirroring `BookingStore`'s no-`TQuery` shape since
`/mine/` is already scoped server-side) — one screen combining an
issuance form, a one-time reveal panel, and the existing-credentials
table with revoke. The reveal panel is the interesting part: `token`
only ever appears in the `POST` response body, so it's held in a plain
component signal (not persisted, not re-fetchable — a page refresh
loses it, matching the backend's own "no reveal it again" guarantee)
alongside a QR image of that same token rendered via the new `qrcode`
npm dependency (`QRCode.toDataURL()`, isolated behind a
`generateQrDataUrl()` method so unit tests spy past the real encoder,
same seam `my-bookings.ts` already established for its own external
call). **This is the first QR-rendering code anywhere in this
workspace** — validator-app's own "scanning" screen turned out to be a
plain text input, not a camera reader, so there was nothing to reuse.

Revocation reuses the exact `ConfirmDialog` pattern `my-bookings.ts`
already established for cancellation (own `ng-template` body, deferred
refetch on close). No idempotency key on issuance — unlike bookings/
payments, `POST /tap-credentials/` never declared an `Idempotency-Key`
header parameter in the generated schema, so a double-click just issues
two credentials (harmless; either can be revoked) rather than needing
the retry-safety machinery those other flows have.

**Verification performed**: `npx ng lint customer-app` and the full
`npm run test:all` (497 Karma tests across every app/library, up from
485 — `customer-app`'s own suite went from 73 to 85) both clean;
`npm run openapi:generate && npm run openapi:check`
confirmed no drift (expected — the backend surface didn't move). Two
pre-existing lint failures in `my-bookings.spec.ts` (`spyOn(component as
any, ...)`, tripping `@typescript-eslint/no-explicit-any`) were fixed as
a drive-by, since `ng lint customer-app` needed to be clean for this
slice's own verification and the new spec file's own `generateQrDataUrl`
spy would have hit the identical pattern — both now spy through a small
locally-scoped interface cast (`component as unknown as WithRedirect` /
`WithGenerateQr`) instead of `any`. A real scripted Playwright run
against the live stack (signed in as the seeded `e2e-passenger@example.com`)
issued a QR credential, confirmed the reveal showed the token and a
real scannable QR image exactly once, confirmed the token never
reappeared anywhere on the page after dismissal (including the
credentials table below it), and revoked the credential, confirming its
status pill flipped to "Revoked" with the Revoke action removed.

**Not in scope for this slice, deliberately deferred to the next one**:
the permanent `frontend/e2e/validator-app/` Playwright spec named as
still-open above. What it will need was already scoped during this
slice's planning: a `validator-app` `projects`/`webServer` entry in
`playwright.config.ts` (port 4203, currently missing entirely), and
`seed_e2e_users` extended with a tap-and-go-mode `Trip` and a
`TapCredential` seeded with a fixed, well-known raw token (hashed
directly into `token_hash`, since `issue_credential()` only ever returns
its random token once and never persists it).

## Implementation note (Frontend — permanent validator-app E2E spec, done)

Phase 4b's last open item, closed out 2026-08-17 right after the
customer-app credential UI slice above — **this closes Phase 4b
entirely**.

Both gaps the prior note flagged were real and are now closed.
**Backend**: `seed_e2e_users` (`backend/apps/core/management/commands/seed_e2e_users.py`)
gained `_seed_tap_and_go_fixture()`, called alongside the existing
`_seed_bookable_journey()`. It needed its own, separate `Business`
("Integra E2E Tap & Go Business") rather than reusing the bookable
fixture's — `apps.scheduling.services.create_manual_trip` snapshots
`booking_mode` from `route.business.booking_mode_default` per-Trip, not
settable per-Trip, so a tap-and-go Trip needs a Business whose default
already is one. The fixture is otherwise the same shape as the bookable
one (Route, 3 Stops, VehicleType + Vehicle with no Seats — tap-and-go
never touches `apps.seating` — a flat `FareRule`, a week of Trips), plus
one new piece: a `TapCredential` created directly (not through
`issue_credential()`, which always generates a fresh random token and
never persists it) with `token_hash` hashed from a hardcoded constant,
the same "fixed constant, hashed at rest" shape `E2E_PASSWORD` already
uses. Force-reset to `is_active=True` on every run, mirroring the
KYC/KYB force-reset pattern already in this file. **Frontend**:
`playwright.config.ts` gained a fourth `projects`/`webServer` pair for
`validator-app` (port 4203), and two new spec files —
`frontend/e2e/validator-app/login.spec.ts` (axe-clean render, the same
generic-rejection message for a passenger login as `client-admin-app`'s
own spec, since validator-app signs in via the same client-admin JWT
audience) and `record.spec.ts` (a read-only render check, then a single
test recording a board tap followed immediately by an alight tap against
the seeded fixture — deliberately kept in one test, not split, so the
`FareJourney` table's one-open-journey-per-`(business, passenger)`
Postgres partial unique index is never left open across runs; a stray
open journey from an interrupted prior run is a named, accepted gap this
spec doesn't defend against, same class of "assumes the previous run
finished cleanly" limitation this codebase has already accepted
elsewhere).

**Verification performed**: `uv run ruff check`/`uv run mypy` on the
modified seed command both clean. Ran `seed_e2e_users` against the live
dev stack and confirmed every new row directly via a Django shell query
(Business `booking_mode_default=tap_and_go`/`kyb_status=approved`, 8
Trips with `booking_mode=tap_and_go`, the `FareRule` amount, and the
`TapCredential`'s `token_hash` matching a locally-computed SHA-256 of
the fixed constant). `npx playwright test --project=validator-app` — all
5 new tests green on the first run. A full `npx playwright test` (all
four projects) surfaced 4 failures **unrelated to this slice** — traced
each to this dev database's already-documented cruft (`docs/specs/5-payments-wallet-ledger.md`'s
own Slice C note names "145 leftover e2e-test Businesses"; it's grown
past that since): `Business` and `Route` have no explicit `Meta.ordering`,
and `SelectedBusinessStore`/the trip-search route picker both fetch with
a flat `limit=100`, so a handful of long-lived, fixed-name fixture rows
(`Integra E2E KYB Review Business`, the bookable fixture's `Ikeja → CMS`
Route) can arbitrarily fall outside that window depending on the
underlying table's natural row order — confirmed by re-running each
failing spec in isolation (still fails, same missing element, no
seed_e2e_users changes involved) and by directly querying
`GET /businesses/?limit=100` and finding "Integra E2E KYB Review
Business" absent from the first page against 145+ total rows. This
predates this slice; adding one more idempotent, fixed-name Business
here doesn't materially change it (it doesn't grow on repeat runs, unlike
the timestamp-suffixed rows other specs create). Not fixed here — out
of scope for a Phase 4b close-out, and the real fix (stable ordering
and/or a periodic dev-DB reset) is a cross-cutting concern touching
every list screen in `client-admin-app`, not just this one.

**Correction (2026-08-17, same day)**: the "no explicit ordering" cause
named above was wrong. A follow-up investigation found `Business` and
`Route` both already resolve to a stable `ordering = ["-created_at"]`
(`Business` inherits it from `BaseModel.Meta`; `Route` restates it
explicitly, with its own code comment recording this exact trap having
bitten the codebase once before). The real mechanism is newest-first
ordering plus a handful of frontend `limit=100` "fetch everything" call
sites plus unbounded dev-DB cruft growth with no cleanup tooling — see
this repo's cross-cutting fix (`identity.Role`/`identity.User` ordering
plus the new `prune_e2e_test_data` management command, `CLAUDE.md`'s
commands list) for the corrected diagnosis and what was actually done
about it. That fix reduced the originally-observed 4 failures to 2 — the
remaining 2 (`booking.spec.ts`, `kyb-queue.spec.ts`) have cruft rows
with their own protected dependents (a `KybDocument`, a `Trip`) that a
best-effort, non-cascading prune can't safely remove; deliberately not
solved here.
