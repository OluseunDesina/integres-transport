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

The platform is built around four audiences, each with their own
dedicated app:

- **Passengers** — accounts, booking, a digital wallet they can top up
  and pay from, and digital tickets.
- **An operator's own staff** — managing their routes, vehicles,
  drivers, schedules, and trips day to day.
- **Integra's own platform staff** — vetting and onboarding new
  operators, with oversight across all of them.
- **An operator's on-the-ground conductors** — a fourth, installable
  app for recording taps and scanning tickets at the point of boarding,
  standing in for a dedicated mobile app until one is built.

---

## 2. Where things stand today

The project is built in phases, and **every phase is independently
verified before being called done** — not just built and assumed to
work, but re-checked end-to-end (automated tests, accessibility,
security review, visual review) with a dated report naming exactly
what was found. **As of today, the entire original phase plan is
complete, and three further enhancements have shipped on top of it:**

| Phase | What it delivered | Status |
|---|---|---|
| **0 — Foundation** | The underlying scaffolding: the shared backend, the four apps, secure login, and the automated testing setup everything else builds on | ✅ Done |
| **1 — Identity, Client & Business** | Operators can register, verify their identity and business documents (compliance review), and manage staff with proper role-based access | ✅ Done |
| **2 — Admin interfaces** | The actual screens operator staff and Integra staff use day to day for everything Phase 1 built | ✅ Done |
| **3 — Network, Scheduling & Fleet** | Routes, stops, vehicles, drivers, and recurring trip schedules — the full operational picture of "what runs, where, and when" | ✅ Done |
| **4 — Fares, Seating & Booking** | Pricing, seat maps, and the actual booking flow — a passenger can search, pick a seat, and reserve it, end to end | ✅ Done (see note below) |
| **4b — Tap-and-go fare pricing** | For operators without seat reservations (e.g. a metro system): board, tap, ride, tap out, and the fare is worked out automatically from distance travelled | ✅ Done |
| **5 — Payments, Wallet & Ledger** | Taking payment, financial record-keeping, paying operators out | ✅ Done — a passenger can pay for a booking end to end, and operators are paid out through a real payment partner |
| **6 — Ticketing** | Digital, tamper-proof tickets, issued automatically on payment and scannable by a conductor even with no live internet connection | ✅ Done |
| **7 — Passenger Wallet** *(enhancement)* | A passenger can top up a running balance and pay for a booking directly from it, instead of a card checkout every time | ✅ Done |
| **8 — Seat Map Generation** *(enhancement)* | Operator staff can generate a vehicle's seat layout (rows, columns, an aisle) instead of entering every seat by hand | ✅ Done |
| **9 — In-App Notifications** *(enhancement)* | A notification bell across every app: warns operator staff before a driver's license or a vehicle's insurance expires, reminds a passenger about an unused ticket, and alerts Integra staff to a new compliance submission waiting on their queue | ✅ Done |

In plain terms: **everything originally scoped is built, and so is
everything asked for since.** The three enhancement phases (7–9)
weren't part of the original plan — they were scoped and built in
response to real gaps found once the rest of the system was in use
(no way to pay from a running balance, no way to build a seat map
without hand-entering every seat, no way to be notified about
something before it became a problem). Each went through the same
spec-first, independently-verified process as everything before it.

**A note on how Phase 4 reached "done"**: most of it shipped normally,
reviewed slice by slice as it was built. The final piece — the
passenger-facing booking screens, plus a related fare-pricing
improvement — was instead built in one continuous pass by an external
tool, without the usual review pauses in between. It was caught up to
the same verification standard immediately afterward, and nothing
wrong was found in the code itself, but it's worth stakeholders
knowing the process slipped once — every phase since has kept to the
stop-and-review discipline that slip prompted.

**The passenger marketplace, redesigned (September 2026).** Beyond
the phases above, Integra now has a cross-operator marketplace: one
website where a traveller searches every operator on the platform at
once, the way flight sites compare airlines. Its look and flow were
rebuilt after studying six of the leading travel and mobility booking
sites — Omio and Busbud (Europe and North America's multi-operator
bus/train sites), FlixBus, Rome2Rio, BuuPass (Kenya's bus booking
leader) and Wakanow (Nigeria). The front page and search results now
follow what those sites have in common: one search bar, quick repeats of
recent searches, payment options stated up front, filters, and "Cheapest"
/ "Fastest" labels on results. The booking pages that follow a search
are being brought into line next.

---

## 3. What's next, and what it's waiting on

**There is no open phase right now — the full build plan is
complete.** Every design decision that once gated a phase (which
payment partner, how the financial ledger is structured, how a digital
ticket is made tamper-proof for a scanning device with no live
internet connection, how two passengers can't book the same seat at
the same time even for overlapping-but-not-identical portions of a
trip) was made, documented, and built out. What's next is a business
decision, not an engineering one: whichever of the items below the
business wants prioritized, or a new enhancement altogether.

What remains **deliberately deferred**, named plainly rather than
implied to be done:

- **A second payment partner for Botswana.** Paystack, the payment
  partner Integra uses everywhere else, doesn't operate there. The
  Botswana metro operator's routes, schedules, and bookings all work
  today — only taking payment specifically is blocked on this, and
  it's deferred until actually needed rather than solved speculatively.
- **A dedicated conductor mobile app.** The installable web app built
  for Phase 4b stands in for it today and does the same job (recording
  taps, validating tickets) — a native app is planned as later,
  separate work, not a current gap in what conductors can do.
- **Production-grade file storage.** Uploaded compliance documents are
  stored on local disk today rather than in cloud storage (e.g. Amazon
  S3) — fine for the current stage, not yet production-hardened.
- **Marketplace features every competitor has, but we can't show
  honestly yet.** All six booking sites studied show *popular routes*;
  most show *how many seats are left* and a wall of *partner operator
  logos*. We don't, because the system doesn't yet track route
  popularity, doesn't return seat availability with search results, and
  has no public list of marketplace operators. Each is a modest backend
  addition — a business call on which matters most. Customer reviews and
  "2M+ travellers"-style figures are left out for a simpler reason: we
  have none to cite, and won't invent them.
- **Operator custom domains.** Each operator's own branding is fully
  white-labeled inside the product, but the network setup to serve
  that under the operator's *own* web address isn't deployed yet — see
  §4.

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
- **Celery** — runs several pieces of scheduled background work
  automatically: turning a recurring schedule ("this route runs every
  weekday at 7:30am") into that day's actual, concrete trip; releasing
  a seat that was held but never paid for; and the daily checks behind
  the notification system (§2) that warn staff before a driver's
  license or a vehicle's insurance actually expires.
- **Docker Compose** — how the whole stack (database, cache, backend,
  background workers) runs together in development.
- **The platform is live**, deployed on Vercel (the backend and all 4
  apps) and Supabase (the database) — chosen over AWS specifically for
  a fast, low-overhead path to a real, working URL at this stage,
  rather than the heavier provisioning AWS would require before
  anything could be reached at all. Specific addresses aren't listed
  in this document; ask for them directly. There is no meaningful
  infrastructure cost being incurred beyond this, and no cost estimate
  exists yet for a hardened production environment (separate
  staging/production split, custom domains per operator) — that will
  need to be scoped separately when it's actually needed.

This document deliberately does not include cost figures, staffing
levels, or a delivery timeline for future phases — none of that exists
in the project's source material yet, and rather than estimate it,
this is flagged as an open input the business side should provide or
request.

---

## 6. Bottom line

**Integra AFC's full build plan is complete, and the platform is live.**
Every phase originally scoped — secure multi-tenant infrastructure, a
working compliance/onboarding process, full admin tooling, the
complete operational model of routes/fleet/schedules, seat-locking
booking, pay-as-you-go fare pricing, real payment collection and operator
payout through Paystack, and tamper-proof digital ticketing — has been
built to a written spec, reviewed against a fixed checklist, and
reported on honestly, including what wasn't perfect and what was
deliberately deferred. The one process exception, named plainly rather
than smoothed over: the last piece of Phase 4 skipped its usual review
pauses and was caught up to the same standard immediately after (§2).
Every phase since has kept to the discipline that slip prompted:
decide the hard questions before writing code, stop for independent
review between every build stage, and name what's deferred rather than
imply it's done. That discipline caught genuine, non-obvious bugs at
several points along the way — before any of them could reach
anything real.

**Three further enhancements shipped after the original plan finished**,
each in direct response to a real gap surfaced by actually using the
system rather than a gap anyone had originally anticipated: a
passenger wallet (top up once, pay from balance instead of a full
checkout every time), seat map generation (build a vehicle's layout
from a few numbers instead of entering every seat by hand), and
in-app notifications (staff warned before a compliance document
expires, a passenger reminded about a ticket they haven't used,
Integra's own team alerted to a new submission waiting on their
queue). Each went through the same process as everything before it —
nothing here was rushed to compensate for being unplanned.

What's left is not engineering work waiting on a decision — it's a
short, named list of deliberately deferred items (§3) and a business
choice about what to prioritize next.
