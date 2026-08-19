# Integra AFC — Executive Overview

**Audience**: executive stakeholders involved in the project. No
technical background assumed — technical terms are explained in plain
language on first use. For full technical detail, see the companion
document, `docs/architecture.md`.

---

## 1. What Integra AFC is, and why

African transport operators — commuter shuttles, intercity buses, metro
systems — largely run fare collection today through fragmented, manual,
or cash-based processes: paper tickets, informal cash handling, no
shared system across routes or vehicles, no unified view of revenue or
operations. That makes it hard for an operator to know what's actually
happening across their fleet, hard for them to reduce leakage and
fraud, and hard for a platform provider to serve more than one operator
without rebuilding everything each time.

**Integra AFC is a single platform that multiple transport operators
run their fare collection on, each seeing their own fully
white-labeled version of it.** "White-labeled" means each operator's
staff and passengers experience the product under that operator's own
branding and domain — they don't see or know it's a shared platform
underneath. One backend serves many operators; each operator's data is
kept strictly separate (§4).

The platform is built around three audiences, each with their own
dedicated app:

- **Passengers** — accounts and booking; wallets are a future phase.
- **An operator's own staff** — managing their routes, vehicles,
  drivers, schedules, and trips day to day.
- **Integra's own platform staff** — vetting and onboarding new
  operators, with oversight across all of them.

---

## 2. Where things stand today

The project is built in phases, and **every phase is independently
verified before being called done** — not just built and assumed to
work, but re-checked end-to-end (automated tests, accessibility,
security review, visual review) with a dated report naming exactly
what was found. As of today, five phases are complete on that basis:

| Phase | What it delivered | Status |
|---|---|---|
| **0 — Foundation** | The underlying scaffolding: the shared backend, the three apps, secure login, and the automated testing setup everything else builds on | ✅ Done |
| **1 — Identity, Client & Business** | Operators can register, verify their identity and business documents (compliance review), and manage staff with proper role-based access | ✅ Done |
| **2 — Admin interfaces** | The actual screens operator staff and Integra staff use day to day for everything Phase 1 built | ✅ Done |
| **3 — Network, Scheduling & Fleet** | Routes, stops, vehicles, drivers, and recurring trip schedules — the full operational picture of "what runs, where, and when" | ✅ Done |
| **4 — Fares, Seating & Booking** | Pricing, seat maps, and the actual booking flow — a passenger can search, pick a seat, and reserve it, end to end | ✅ Done (see note below) |
| **5 — Payments, Wallet & Ledger** | Taking payment, passenger wallets, financial record-keeping, paying operators out | ✅ Backend done (§3) — a passenger can pay for a booking end to end, and operators can now be paid out. No passenger/staff-facing screens for any of it yet |
| **6 — Ticketing** | Digital ticket issuance and validation | ⏳ Not started |

In plain terms: **the foundation, the compliance/onboarding process,
the admin tooling, the full operational model (routes, fleet,
schedules), and now the passenger booking flow itself all exist and
work today.** A passenger can reserve a seat; they cannot yet pay for
it. That's the next phase.

**A note on how Phase 4 reached "done"**: most of it shipped normally,
reviewed slice by slice as it was built. The final piece — the
passenger-facing booking screens, plus a related fare-pricing
improvement — was instead built in one continuous pass by an external
tool, without the usual review pauses in between. It has since been
caught up to the same verification standard as everything else (see
`docs/status-report-2026-08-14.md` §2–3 for the full, honest account),
and nothing wrong was found in the code itself — but it's worth
stakeholders knowing the process slipped once, even though the outcome
held up.

---

## 3. What's next, and what it's waiting on

**Phase 4 is done, including the question of how two passengers can't
both book the same seat at the same time** — the trickiest part of it,
covering even the case where two passengers want *overlapping but not
identical* portions of the same trip (one boards at stop 2 and leaves
at stop 5, another boards at stop 4). That design decision is finalized
and proven: enforced at the database level, verified by a test that
fires six simultaneous booking attempts at the same seat and confirms
exactly one succeeds.

Phase 5 (Payments, Wallet & Ledger) is the next milestone — where the
platform starts doing what it's ultimately for commercially: taking
money for a booking, not just holding one. **The two decisions that were
blocking it are now both made** (2026-08-14):

1. **Payment partner: Paystack.** Confirmed with the product owner.
   One honest caveat, surfaced before the decision was made rather than
   after: Paystack doesn't currently operate in Botswana, so the
   Botswana metro operator will need a second payment partner before it
   can go live on payments specifically — everything else it does
   (routes, schedules, bookings) is unaffected. That second decision is
   deliberately deferred until it's actually needed.
2. **How money is recorded** — the ledger design (double-entry
   bookkeeping, so every movement of money is fully traceable and
   auditable) is now formally finalized, including the handful of
   remaining modeling questions (how a platform commission is split out
   of a payment, how payouts to an operator are batched and tracked).

**Phase 5 is now fully planned out, and all three of its build stages
are done — its backend work is complete.** The underlying accounting
system — the ledger that records every movement of money, built
exactly to the finalized design above — was built and verified first.
The second stage, connecting that ledger to Paystack, made it possible
for a passenger to pay for a booking and have it actually go through,
with the money correctly recorded the moment it's confirmed. **The
third and final stage, just finished, closes the loop**: Integra's own
staff can now batch up an operator's accumulated earnings for a period
and trigger a real payout to that operator's bank account through
Paystack, with the outcome confirmed automatically once Paystack
reports back. All three stages are independently verified (470
automated tests passing, up from 383), each one deliberately paused
for review before the next started — the same disciplined,
one-stage-at-a-time approach used earlier for seat booking (§2). No
passenger- or staff-facing screen exists yet for any of this (it's all
been verified directly against the system, not through the app) —
building those screens is separate, upcoming work, and is now the
natural next conversation for this phase.

**A separate, smaller phase — tap-and-go fare pricing — now has both its
backend and a working staff app built.** This is for operators like the
Botswana metro that don't use seat reservations: a passenger boards,
taps in, later taps out, and the system works out what they owe based
on distance travelled. It's scoped narrowly to *working out the fare*,
not collecting it — collection still depends on Phase 5. The one open
design question this needed to answer — what a passenger actually taps
or scans — is settled: either a QR code or an NFC-enabled phone, card,
or watch, whichever a given passenger prefers. A conductor can now
actually record a tap: a fourth, installable phone/tablet app was built
for exactly that job, standing in for a dedicated validator app until
one is built as its own later phase. What's still missing is a
passenger-facing screen to obtain the QR code/NFC credential in the
first place — a small, deliberately deferred piece, not a blocker to
demonstrating the rest.

A third decision — how a digital ticket is made tamper-proof, including
for a scanning device with no live internet connection — still has a
"documented direction, not yet finalized" status, but only needs to be
settled before Phase 6 (Ticketing), which comes after Phase 5.

---

## 4. Risk & compliance posture

For a platform handling multiple operators' data (and, in later
phases, their money), the two questions that matter most are: *can one
operator ever see another's data*, and *is there a reliable record of
who did what*.

- **Data isolation is enforced twice, independently.** The system
  doesn't rely on one safeguard remembering to filter data correctly —
  there are two separate, independent checks (one in the application,
  one at the database level itself) that both have to fail for one
  operator's data to ever reach another. This was a deliberate design
  requirement from the start, not something added after a concern was
  raised, and it's actively tested against on every phase.
- **Compliance workflows are built and working**: both the operator
  entity itself and each individual business it runs go through a
  document-verification review process (KYC/KYB — standard
  "know your customer / know your business" identity and legitimacy
  checks) before being approved, reviewed by Integra staff through a
  dedicated queue.
- **Every sensitive action is logged, permanently.** Approvals,
  rejections, staff invitations, and operational changes all write to
  an audit trail that cannot be edited or deleted after the fact, only
  added to — standard practice for anything that may later need to be
  reviewed or reconstructed.
- **Staff access is role-based**, not all-or-nothing — an operator's
  staff only see and can do what their assigned role permits.

**Named honestly, not glossed over** — two things that are designed
for, but not yet in their production-ready form:
- Uploaded compliance documents are currently stored on local disk
  rather than in cloud storage (e.g. Amazon S3) — the production
  storage approach is planned but not yet built.
- Routing traffic correctly for operators' own custom domains
  (so each operator's branding shows up on their own web address) is
  designed but the production network setup to make that work isn't
  deployed yet.

Neither of these blocks anything built so far; both are flagged here
because a platform at this stage should have them named, not
discovered later.

---

## 5. Infrastructure, in business terms

The system runs on a small, standard, well-understood set of
open-source infrastructure — not exotic or hard-to-staff technology:

- **PostgreSQL** — the database, and specifically the layer that
  enforces the operator-data-isolation described above.
- **Redis** — fast temporary storage used for things like rate-limiting
  and background job coordination.
- **Celery** — runs scheduled background work automatically, e.g. the
  daily job that turns a recurring schedule ("this route runs every
  weekday at 7:30am") into that day's actual, concrete trip.
- **Docker Compose** — how the whole stack (database, cache, backend,
  background workers) runs together today, in development.
- **AWS** is the intended production deployment target — this is
  documented as the plan but **has not yet been provisioned**. There is
  no current infrastructure cost being incurred beyond development
  environments, and no cost estimate exists yet for production
  deployment; that will need to be scoped separately when production
  provisioning is planned.

This document deliberately does not include cost figures, staffing
levels, or a delivery timeline for future phases — none of that exists
in the project's source material yet, and rather than estimate it,
this is flagged as an open input the business side should provide or
request.

---

## 6. Bottom line

Five phases in, Integra AFC has a solid, independently-verified
foundation: secure multi-tenant infrastructure, a working
compliance/onboarding process, full admin tooling for operator staff,
the complete operational model of routes, fleet, and schedules, and now
a working passenger booking flow, seat-locking design included. Nearly
every phase has been built to a written spec, reviewed against a fixed
checklist, and reported on honestly — including what wasn't perfect and
what was deliberately deferred. The one exception, named plainly rather
than smoothed over: the last piece of Phase 4 skipped its usual review
pauses and was caught up to the same standard after the fact (§2).

Phase 5 is where the platform started doing the thing it exists to do
commercially — take money for a booking, not just hold one — and it now
does, all the way through to paying an operator out. Both decisions
gating it — which payment partner, and how the financial ledger is
designed — were made up front, and the platform was built out on top of
them one verified stage at a time: the ledger itself, then the actual
Paystack connection a passenger uses to pay, then the payout mechanism
that closes the loop back to the operator. The pause between stages did
its job every time: deciding both foundational questions before any
code was written avoided the kind of expensive rework this project's
process exists to prevent, and stopping for review between each of the
three build stages caught a genuine, non-obvious bug each time before
it could reach anything real. What's left for this phase now is not
backend work at all — it's the passenger- and staff-facing screens for
money the backend already moves correctly, and a second payment partner
for the one market (Botswana) the current one doesn't cover.
