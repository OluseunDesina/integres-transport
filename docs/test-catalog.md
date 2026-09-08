# Test catalog — manual UAT guide

What this is: a walkthrough of every real, working flow in Integra AFC
and how to exercise it by hand, organized in the order the system was
built. Not a requirements doc, not user stories — everything below
describes the system as it actually exists right now. If a step here
stops matching reality, the code changed and this doc is stale, not
the other way around.

Each entry: **App + role** it's tested on, **Preconditions** (what has
to exist first), **Steps**, **Expected result**, and **Worth trying** —
a couple of edge cases that actually prove something, not exhaustive
QA coverage.

## 0. Setup

Bring the stack up (either target works with this guide unchanged —
only the URLs differ):

- **Local**: `docker compose up` from the repo root, then
  `docker compose exec backend python manage.py migrate` once, then
  `cd frontend && npm run start:customer` (and `:client-admin`,
  `:super-admin`, `:validator` in separate terminals, or just the ones
  you need).
- **Deployed** (Vercel + Supabase, see `docs/deployment.md`): use the
  real project URLs in place of `localhost:<port>` below.

Seed the fixed test accounts and fixtures (idempotent — safe to run
again at any point if something gets deleted or changed by a prior
walkthrough):

```bash
cd backend && uv run python manage.py seed_e2e_users
```

**Frontend URLs** (local dev ports):

| App | URL | Audience |
|---|---|---|
| customer-app | `localhost:4200` | passenger |
| client-admin-app | `localhost:4201` | client staff |
| super-admin-app | `localhost:4202` | platform staff |
| validator-app | `localhost:4203` | client staff (same JWT audience as client-admin-app) |

**API documentation**: `GET /api/v1/docs/` (Swagger UI, browsable —
fully styled via CDN-hosted assets, confirmed working on the deployed
backend) and `GET /api/v1/schema/` (raw OpenAPI schema). Useful for
exploring exact request/response shapes for any endpoint referenced
below without reading the Django source — e.g. locally,
`localhost:8000/api/v1/docs/`; on the Vercel deployment,
`https://<your-backend-project>.vercel.app/api/v1/docs/`.

**Seeded accounts** (all passwords `e2e-test-password-123`):

| Short name | Email | What it's for |
|---|---|---|
| **passenger** | `e2e-passenger@example.com` | customer-app — no Role, just `customer:access` |
| **owner** | `e2e-client-staff@example.com` | client-admin-app — Owner role, every permission |
| **staff colleague** | `e2e-client-staff-colleague@example.com` | client-admin-app — Staff role (fewer permissions), a row for `owner` to act on without editing their own session |
| **platform staff** | `e2e-platform-staff@example.com` | super-admin-app |

**Seeded fixtures** already in place after `seed_e2e_users`:

| Fixture | Status | What it's for |
|---|---|---|
| Client `Integra E2E KYC Review Client` | KYC `submitted` | super-admin KYC queue has something to review |
| Business `Integra E2E KYB Review Business` | KYB `submitted` | super-admin KYB queue has something to review |
| Business `Integra E2E Network Test Business` | KYB `approved` | Route "Ikeja → CMS" (Ikeja/Yaba/CMS stops), 6-seat VehicleType (`1A`/`1B`/`2A`/`2B`/`3A`/`3B`), a Vehicle, a ₦750 flat fare, Trips generated daily at 06:30 for the next 8 days — this is what §5–§8 book against |
| Business `Integra E2E Per-Segment Fare Business` | KYB `approved`, fare pricing mode `per_segment` | Route "Apapa → Ojota" (Apapa/Surulere/Ojota stops), a 6-seat VehicleType, a Vehicle, Trips daily at 08:00 for the next 8 days, and **deliberately no fares at all** — pricing this route through the grid is what §3.4 exercises |
| Business `Integra E2E Tap & Go Business` | KYB `approved` | Route "CBD Loop" (Gate A/Mid Stop/Gate B), a Vehicle, a ₦300 flat fare, Trips daily at 07:00 for the next 8 days, plus a `TapCredential` for **passenger** with a **known raw token**: `e2e-tap-credential-fixed-token` — this is what §7 taps against |

**Paystack test-mode checkout card** (used in §6): card number
`4084 0840 8408 4081`, any future expiry date, CVV `408`, PIN `0000`,
OTP `123456` — Paystack's own published test card.

---

## 1. Registration & KYC

### 1.1 Client self-registration

- **App + role**: client-admin-app, unauthenticated.
- **Preconditions**: none.
- **Steps**: go to `localhost:4201/register`. Fill in a business name,
  owner email, phone, and a password. Submit.
- **Expected result**: you're logged straight in (auto-login) and land
  on `home` — no separate "check your email" step. An Owner Role was
  created for you automatically, along with Manager/Staff role
  presets.
- **Worth trying**: register with an email that's already in use —
  confirm you get a clear validation error, not a 500.

### 1.2 KYC document upload

- **App + role**: client-admin-app, as the Owner you just registered
  (or **owner**).
- **Preconditions**: 1.1, or use **owner**.
- **Steps**: navigate to `kyc`. Upload any small file as a
  "Certificate of Incorporation." Submit.
- **Expected result**: your Client's KYC status moves to `submitted`.
- **Worth trying**: nothing here yet — the interesting part is the
  review side, next.

### 1.3 Super-admin KYC review queue

- **App + role**: super-admin-app, as **platform staff**.
- **Preconditions**: the seeded `Integra E2E KYC Review Client` (or
  your own Client from 1.2).
- **Steps**: log in, go to `kyc-queue`. Find the submitted Client.
  Approve it (or reject it with a reason).
- **Expected result**: the Client's KYC status updates to
  `approved`/`rejected`; the row drops out of the queue.
- **Worth trying**: reject with no reason typed — confirm the form
  actually requires one (this dialog is one of the few that does).

---

## 2. Business & staff

### 2.1 Business creation

- **App + role**: client-admin-app, as **owner**.
- **Preconditions**: logged in as Owner or Manager (Staff is blocked —
  see 2.4).
- **Steps**: go to `businesses/new`. Fill in name, vertical, currency,
  timezone, booking mode (`reservation` or `tap_and_go`), fare pricing
  mode (`flat` or `per segment`). Submit.
- **Expected result**: new Business appears in `businesses`, KYB status
  `not_submitted`.
- **Worth trying**: create one with `booking_mode_default: tap_and_go`
  — this is what determines every Trip generated under it later; it
  can't be changed per-Trip.
- **Worth trying**: set fare pricing mode to **per segment**, then look
  at a route's fare grid (§3.4). Switch it back to flat afterwards and
  confirm the segment fares are still listed but no longer applied —
  switching consults a different rule type, it does not delete
  anything. The control says so at the point of change.

### 2.2 KYB: directors, documents, and review

- **App + role**: client-admin-app (submit) then super-admin-app
  (review).
- **Preconditions**: 2.1, or the seeded KYB business.
- **Steps**: open the Business's edit screen and follow **Open
  verification** to `businesses/:id/kyb`. Add a director (full name,
  ID type, optional ID number) — the guidance text under **ID type**
  changes with the type you pick. Upload that director's ID from their
  own row, then upload a company-level document (certificate of
  incorporation, proof of address, tax certificate, or other) from its
  own section. As **platform staff**, go to `kyb-queue`, find the
  business — its **Directors** column shows who you are approving —
  and approve it.
- **Expected result**: each section shows what has been supplied and
  what is still outstanding ("Not supplied yet.") rather than an
  undifferentiated pile. A director's ID is filed against that
  director, not into the company-level pile. Business's KYB status
  moves `not_submitted → submitted → approved`. Route creation (§4) is
  gated on `approved` — you can't skip this for a new Business.
- **Worth trying**: press **Add director** with the name blank — the
  field goes red with "This field is required." Use a very long
  director name and confirm the row still lays out cleanly.
  **Remove** a director who already has an uploaded ID: they disappear
  from the form but stay on the reviewer's packet, because their
  document is still part of the submission. Open the KYB screen for a
  business well down the list (not one you just created) — that path
  used to report "couldn't be found" for anything past the 25th row.
- **Note**: the review queue is ordered **oldest submission first**,
  so a freshly submitted business is on the *last* page, and the queue
  has no search yet. Page to it.

### 2.3 Staff invite + accept

- **App + role**: client-admin-app, **owner** invites; the invited
  email accepts (any browser/incognito window, unauthenticated).
- **Preconditions**: logged in as Owner (or Manager — `staff.invite`
  is granted to both).
- **Steps**: go to `staff/invite`. Enter an email and pick a Role
  (Owner/Manager/Staff). Submit — this logs the invite link via the
  console email backend (check the backend process's log output for
  the link if you don't have real email delivery wired up). Open that
  link, set a password.
- **Expected result**: the new user can log into client-admin-app with
  exactly the Role's permissions.
- **Worth trying**: invite the same email twice — confirm the second
  invite doesn't silently create a duplicate/broken state.

### 2.4 Owner vs. Staff permission difference

- **App + role**: client-admin-app, as **staff colleague** (Staff
  role).
- **Preconditions**: none beyond the seed.
- **Steps**: log in as **staff colleague**. Try `businesses/new`.
- **Expected result**: blocked (403 / redirected to `forbidden`) —
  Staff can view Businesses but not create one; only Owner/Manager can.
- **Worth trying**: the same account *can* reach `bookings`,
  `payments`, `ledger` (all `*.view`-gated, granted to Staff too) —
  confirms this is real per-permission RBAC, not a blanket
  staff-vs-owner toggle.

### 2.5 White-label config

- **App + role**: client-admin-app, as **owner**.
- **Preconditions**: `whitelabel.manage` permission (Owner has it).
- **Steps**: go to `white-label`. Set a display name / branding
  fields.
- **Expected result**: saves successfully.
- **Known limitation**: on `localhost`, there's no real domain to
  resolve white-label config *against* — the login screen's
  auto-detection of which Client you belong to only works with a real
  custom domain in front of the app. Not a bug; documented in
  CLAUDE.md as an accepted Phase 0 gap.

---

## 3. Network, fleet, scheduling

All of §3 already exists for the seeded "Integra E2E Network Test
Business" — these entries describe editing/extending it, not creating
from zero (§2.1–2.2 covers that path).

### 3.1 Route & Stop management

- **App + role**: client-admin-app, **owner** (or Manager — `network.manage`).
- **Preconditions**: an approved Business.
- **Steps**: go to `stops/new`, add a Stop. Go to `routes/new`, create
  a Route, assign it a sequence of Stops (must include the new one).
- **Expected result**: Route appears in `routes`, its Stop list in the
  right order.
- **Worth trying**: try creating a Route with fewer than 2 Stops —
  confirm it's rejected (booking search requires at least 2 active
  Stops on a Route to be useful).

### 3.2 Fleet: VehicleType, Vehicle, Driver

- **App + role**: client-admin-app, **owner**.
- **Steps**: `vehicle-types/new` (set a seat capacity), `vehicles/new`
  (assign the VehicleType, a registration number), `drivers/new`.
- **Expected result**: each appears in its own list screen.
- **Worth trying**: a Vehicle's assigned VehicleType can't be changed
  once it has Seats generated against it — try it and see what the UI
  does.

### 3.3 Schedule → Trip generation

- **App + role**: client-admin-app, **owner**.
- **Preconditions**: a Route, a Vehicle.
- **Steps**: go to `schedules/new`. Set days of week, a departure
  time, an effective date range, assign the Route/Vehicle. Save.
- **Expected result**: nothing appears in `trips` immediately — Trips
  are generated by a **daily Celery Beat job** (`generate_trips`,
  01:00 UTC), not synchronously on Schedule save. Either wait for the
  next run, or (local dev) trigger it directly:
  `docker compose exec backend python manage.py shell -c "from apps.scheduling.tasks import generate_trips; generate_trips()"`.
- **Expected result (after generation)**: Trips appear in `trips`,
  one per matching day in the generation horizon.
- **Note**: Fares and Seat layouts both have client-admin screens now
  (§3.4 below, and `vehicle-types/:id/seats`). This entry used to say
  they existed only as backend + `seed_e2e_users` data.

### 3.4 Fare grid (stop-pair pricing)

- **App + role**: client-admin-app, **owner** (or Manager —
  `fares.manage`; `fares.view` gets a read-only grid).
- **Preconditions**: a Business with fare pricing mode **per segment**
  (§2.1) and a Route with at least 3 Stops. The seeded "Integra E2E
  Per-Segment Fare Business" and its "Apapa → Ojota" route are exactly
  this.
- **Steps**: `routes` → the route's **Fares** link (or `fares` →
  "Price by stop pair"). Type an amount into some cells, watch the
  unsaved-change count, then **Save fares**.
- **Expected result**: only forward stop pairs are editable; edited
  cells highlight; the save reports how many fares changed and the
  amounts come back in the server's own `450.00` formatting.
- **Worth trying**: save with nothing edited — the button stays
  disabled. Re-type the same price in a different format (`1500` over
  `1500.00`) — still not a change, because re-saving would churn the
  fare's version history for nothing.
- **Worth trying**: clear a priced cell and save. It must ask first,
  naming the segments by stop. Confirm, then try to book that segment
  as a passenger — it should fail with "no fare configured", which is
  exactly what clearing a cell means.
- **Worth trying**: open the same screen for a **flat**-priced
  Business. It should warn and disable every cell rather than let you
  enter prices that would never be read.
- **Worth trying**: navigate the grid with the keyboard alone — Tab
  along a row, Up/Down between rows of a column.

## 4. Booking (customer-app)

### 4.1 Search → book a seat

- **App + role**: customer-app, as **passenger**.
- **Preconditions**: the seeded bookable fixture (Ikeja → CMS).
- **Steps**: log in, `search`. Search Ikeja → CMS for any of the next
  8 days. Pick a Trip, pick a seat (`1A`, say) on the seat picker,
  confirm.
- **Expected result**: lands on `my-bookings` with a new row, status
  `pending_payment`, a 15-minute seat hold running.
- **Worth trying**: open the same seat in a second browser/incognito
  session as a second passenger before paying — confirm it's
  unavailable (this is the ADR-0004 concurrency guarantee, visible
  from the UI, not just the backend test suite).

### 4.2 Cancel a pending booking

- **App + role**: customer-app, as **passenger**.
- **Preconditions**: 4.1, not yet paid.
- **Steps**: on `my-bookings`, click Cancel on the row, confirm.
- **Expected result**: status → `cancelled`, seat immediately
  bookable again by someone else.

### 4.3 Let a hold expire

- **App + role**: customer-app, as **passenger**.
- **Preconditions**: 4.1.
- **Steps**: don't pay, don't cancel. Wait past the hold window (or,
  local dev, trigger the sweep directly:
  `docker compose exec backend python manage.py shell -c "from apps.seating.tasks import expire_seat_holds; expire_seat_holds()"`).
- **Expected result**: Booking status → `expired` on its own, seat
  released.

---

## 5. Payment

### 5.1 Pay a booking

- **App + role**: customer-app, as **passenger**.
- **Preconditions**: a `pending_payment` Booking (4.1).
- **Steps**: on `my-bookings`, click "Pay now." You're redirected to a
  real Paystack test-mode checkout page. Use the test card from §0.
- **Expected result**: redirected back, and — once Paystack's webhook
  reaches the backend — the Booking's status flips to `paid` (may take
  a few seconds; refresh `my-bookings` if it hasn't updated yet).
- **Worth trying**: abandon checkout partway (close the tab) — confirm
  the Booking just stays `pending_payment`, not stuck in some broken
  intermediate state.

### 5.2 Payment/ledger/wallet visibility

- **App + role**: client-admin-app, as **owner** (or Staff —
  `payments.view`/`ledger.view`/`wallet.view` are all granted to
  Staff too).
- **Preconditions**: 5.1 completed at least once.
- **Steps**: visit `payments`, `ledger`, `wallet` in turn. On
  `wallet`, look up the passenger's user id (from 5.1) to see their
  wallet balance.
- **Expected result**: `payments` shows the PaymentIntent from 5.1;
  `ledger` shows a three-line journal entry (wallet, business
  clearing, platform commission); `wallet` shows the passenger's
  balance.
- **Note**: `wallet` only supports lookup by exact passenger id today
  — no name/email search yet, named on the screen itself.

---

## 6. Tap & Go

### 6.1 Issue a credential

- **App + role**: customer-app, as **passenger**.
- **Steps**: go to `credentials`. Issue a new one (channel `qr` or
  `nfc`, optional label).
- **Expected result**: the raw token and a scannable QR are shown
  **exactly once** — refresh the page and it's gone (the backend never
  lets it be re-fetched, only its hash is stored). Either copy the raw
  token now, or skip straight to 6.2 using the seeded fixed token
  instead (`e2e-tap-credential-fixed-token`).
- **Worth trying**: revoke a credential (from the list below the
  issuance form), then try tapping with it in 6.2 — confirm it's
  rejected as inactive.

### 6.2 Record a tap

- **App + role**: validator-app, as **owner** (validator-app signs in
  via the client-admin JWT audience, same account works).
- **Preconditions**: a tap-and-go Trip (the seeded CBD Loop fixture)
  and a credential token (6.1, or the fixed seeded one).
- **Steps**: log in, go to `record`. Pick today's date, pick the CBD
  Loop trip, type/paste the token, choose Board, pick a stop (Gate A),
  submit.
- **Expected result**: a success alert showing the journey's status
  (`open`) — no fare shown yet, since alighting is what prices it.
  Record a second tap (Alight, a later stop) against the **same
  token** to close the journey and see the fare.
- **Worth trying**: try boarding the same token twice in a row without
  alighting in between — confirm it's rejected (one open journey per
  passenger, enforced at the DB level).

---

## 7. Ticketing

### 7.1 View a ticket's QR

- **App + role**: customer-app, as **passenger**.
- **Preconditions**: a `paid` Booking (5.1) on the **reservation**-mode
  fixture (Ikeja → CMS — not the tap-and-go one; tap-and-go Trips
  never produce Tickets).
- **Steps**: on `my-bookings`, click "View tickets" on the paid row.
- **Expected result**: one QR code per seat on the Booking, status
  `issued`.

### 7.2 Validate a ticket

- **App + role**: validator-app, as **owner**.
- **Preconditions**: 7.1's QR payload (the raw text under/around the
  QR image — copy it, not a photo of the code, since there's no camera
  scan in this build).
- **Steps**: go to `validate-ticket`. Pick today's date, pick the same
  Ikeja → CMS trip the ticket was issued for, paste the payload,
  submit.
- **Expected result**: success alert — status `boarded`, passenger
  name, seat number, from/to stop.
- **Worth trying**: submit the exact same payload again — same result,
  no error (idempotent replay). Now try it against a *different* Trip
  than the one it was issued for — confirm it's rejected as the wrong
  trip. Try a payload with one character changed — confirm it's
  rejected as an invalid signature, not silently accepted.

---

## 8. Super-admin extras

### 8.1 Business search + Paystack account config

- **App + role**: super-admin-app, as **platform staff**.
- **Steps**: go to `businesses`, search by name. Open a result, go to
  its Paystack account config. If unconfigured, it shows "not
  configured" rather than an error.
- **Expected result**: can set/update the Business's Paystack account
  reference.

### 8.2 Settlement runs

- **App + role**: super-admin-app, as **platform staff**.
- **Steps**: from a Business's detail, go to settlement-runs.
- **Not fully walkable in this guide**: triggering a real payout needs
  a Paystack **Transfer Recipient** already set up for the Business
  (real or test-mode bank account details registered with Paystack
  beyond what a single test-card checkout provides). The screen itself
  — existing runs table, the trigger form, its error handling — is
  reachable and viewable regardless.

---

## 9. Worth trying — cross-cutting

A few things worth checking once, that prove something structural
rather than one feature:

- **Cross-client isolation**: log into client-admin-app as **owner**
  (belongs to "Integra E2E Test Client"). Register a second, entirely
  separate Client (1.1) with different data. Confirm neither account
  can see the other's Businesses/Bookings/staff through any list
  screen, ever — not just "the UI doesn't show a link to it," actually
  gone from every list/detail request.
- **RBAC beyond 2.4**: as **staff colleague** (Staff role), try
  `staff/invite` (Owner/Manager-only) and confirm it's blocked the
  same way business creation was.
- **Idempotency-Key replay**: this is easiest to see via the API
  directly rather than the UI — POST the same booking-creation request
  twice with the same `Idempotency-Key` header and confirm you get the
  identical Booking back the second time, not a second Booking or an
  error.
- **An expired ticket**: issue a ticket, wait past its validity window
  (or adjust `TICKET_VALID_AFTER_MINUTES` down for a quick local test),
  then try validating it — confirm a clear "expired" rejection, not a
  false "boarded."
