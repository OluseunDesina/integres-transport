# ADR-0008: Open-seating capacity enforcement

Status: **Accepted** (2026-08-26). This unblocks
`docs/specs/10-booking-modes.md`'s open-seating slice.

Deliberately **not** contingent on a concurrency spike test the way
ADR-0004 was, and it is worth saying why, since the two look
superficially alike. ADR-0004 gated itself on a spike because its
mechanism — a Postgres GiST exclusion constraint over a derived range
column, via `btree_gist` — was novel to this codebase and genuinely
unproven; committing Phase 4's whole seat data model to something
nobody here had built warranted proof first. This ADR selects
`select_for_update()`, which this backend already uses at 16+ call
sites across 8 apps (`apps/payments` alone has seven, and
`apps/booking`, `apps/fares`, `apps/clients`, `apps/businesses`,
`apps/ledger`, `apps/scheduling`, `apps/tapngo`, `apps/seating` and
`apps/ticketing` all use it). There is no novel mechanism whose
correctness is in question, so the decision stands on reasoning and
the concurrency test is a **regression test owned by the implementing
spec** — the same relationship `apps/ticketing/services.py`'s own
row lock has to its tests. ADRs 0002, 0006 and 0007 were likewise
Accepted as decisions with no test precondition.

## Context

`docs/specs/10-booking-modes.md` introduces `open_seating`: a passenger
buys a ticket for a specific departure and segment, pays up front, and
gets a scannable ticket, but is never assigned a seat. Two variants are
in scope, selected per Business by `capacity_enforced`: a departure
that can sell out, and one that cannot.

The capacity-enforced variant needs a rule for "is there room?", and
that rule has to be **segment-aware** for the same reason seat
inventory already is (ADR-0004): on a 10-stop intercity route, a
passenger riding stops 1→3 and a passenger riding 6→9 never occupy the
vehicle at the same time and must not compete for the same place.
Counting tickets per trip would wrongly refuse the second one.

So the question is: given a vehicle capacity `N` and a requested
segment `[from, to)`, how do we guarantee that the number of sold
tickets whose segments overlap `[from, to)` never exceeds `N`, under
concurrent requests?

ADR-0004 solved the structurally similar seat problem with a GiST
exclusion constraint. That works there because the invariant is
*mutual exclusion* — at most **one** reservation may overlap a given
(seat, segment). Here the invariant is a *count* — at most **N** may
overlap. Postgres has no declarative constraint for "at most N
overlapping ranges", so the exclusion-constraint approach does not
carry over, and enforcement has to move into application code guarded
by an explicit lock.

That is a real weakening compared to ADR-0004, where the database
itself was the final backstop and the ORM was only the first line. It
is recorded plainly in Consequences below rather than glossed over.

A second constraint shapes the answer: capacity is not always known. A
`Trip` has a nullable `vehicle` (`on_delete=SET_NULL`), and capacity is
read through `vehicle.vehicle_type.capacity`. A trip with no vehicle
assigned yet has no knowable capacity at all.

## Decision

**Serialize capacity checks on the `Trip` row.** Inside the booking
transaction, take `SELECT ... FOR UPDATE` on the `Trip`, count sold
tickets whose segment overlaps the requested one, compare against the
vehicle's capacity, and insert only if there is room.

**When capacity is unknown — no vehicle assigned — and
`capacity_enforced` is true, the trip is not bookable.** Selling an
unbounded number of places onto a vehicle nobody has chosen yet is a
worse failure than a clear refusal an operator can fix by assigning a
vehicle.

This is **not a new rule invented for open seating.** Reservation mode
already behaves this way: `apps.seating.services.get_availability`
returns an empty list for a vehicle-less trip, and its docstring names
that "the same non-error *not yet configured* state … not a 400/404".
Open seating adopts the identical treatment, surfaced through the
shared `status: "not_configured"` that
`docs/specs/10-booking-modes.md` defines for both modes — so the two
modes give one answer rather than two accidental ones.

Worth stating plainly because it is easy to misread as an edge case:
**a trip with no vehicle is the normal early state of nearly every
trip.** The Celery generator creates trips from schedules with no
`vehicle` at all, and staff assign one later. So this path is
exercised constantly, not rarely.

> The refusal itself is a **product call, not a technical necessity**,
> and is reversible without revisiting the mechanism above — selling
> freely until a vehicle is assigned, or selling with a warning, are
> both implementable. Refusing is chosen because an oversold departure
> is discovered by passengers at the roadside, whereas a refused
> booking is discovered by an operator who can act on it.

## Options considered

- **Option A — GiST exclusion constraint, as ADR-0004.** Rejected:
  not expressible. An exclusion constraint enforces "no two rows
  overlap", not "no more than N rows overlap". There is no way to
  parameterise it by vehicle capacity.

- **Option B — Counter table per (trip, segment).** A row per stop pair
  per trip holding a sold count, with a `CHECK (sold <= capacity)`.
  This *would* restore a database-level backstop, which is its real
  attraction. Rejected for now on cost: it needs a row per stop pair
  (45 for a 10-stop route), a backfill whenever a route's stops change
  (`set_route_stops` already hard-deletes and recreates), and a second
  write path to keep in sync with ticket issuance and cancellation —
  meaningful complexity and a new class of drift bug, for a workload
  that does not yet have the contention to justify it.

- **Option C — Postgres advisory locks keyed on trip id.** Equivalent
  serialization without touching the `Trip` row. Rejected: advisory
  locks are invisible to anyone reading the models, are not released by
  transaction rollback in every mode, and this codebase has no existing
  advisory-lock usage to pattern-match against.

- **Option D (chosen) — `select_for_update()` on the `Trip` row.**
  Chosen because it is correct, uses the idiom already established
  throughout this backend, needs no new tables or sync paths, and is
  trivially readable at the call site. Its cost — booking on a single
  trip becomes serial — is acceptable: contention is per-departure, not
  global, and a single shuttle departure is not a high-write hot spot.

## Consequences

**Easier.** One obvious place where the invariant lives. No new model,
no counter drift, no backfill coupled to route edits. The mechanism is
the same one a reader has already met throughout this backend.

**Harder.** Concurrent bookings against one departure serialize, so
booking throughput per trip is bounded by transaction duration.

**The database is no longer the backstop.** This is the first
concurrency invariant in this system that no DDL enforces. Unlike
ADR-0004, nothing prevents an oversold segment if application code is
bypassed — a raw SQL insert, a future service that forgets the lock, or
a `bulk_create` path added later. Two standing obligations follow, and
they do not expire now that this ADR is Accepted:

1. Every write path to open-seating tickets goes through the one
   service function that takes the lock. No `Ticket` rows for
   open-seating trips are created directly, anywhere.
2. `docs/specs/10-booking-modes.md`'s test plan carries a real
   concurrency test (threads, committed transactions,
   `@pytest.mark.django_db(transaction=True)`) proving N racing
   requests for the last place yield exactly one success — mirroring
   `apps/seating/tests/test_seat_concurrency.py` and
   `apps/tapngo/tests/test_tapngo_concurrency.py`. It is a required
   test of that slice, not a precondition of this decision.

**Revisit if:** capacity stops being a single number per trip
(standing vs seated allowances, class-of-service tiers), or if per-trip
lock contention becomes measurable. Either pushes toward Option B,
which also restores the database-level backstop this choice gives up.

---

## Amendment (2026-08-28): capacity counts issued tickets, and oversell
## is tolerated rather than prevented

This ADR was written assuming capacity would be **enforced** — refuse
the sale when full. A product decision taken during
`docs/specs/10-booking-modes.md`'s slice 2 changed that, and the change
is significant enough to record here rather than only in the spec.

**The decision.** Capacity counts **issued tickets only**. An unpaid
booking holds nothing, because holding places for people who may never
pay was judged worse for a shuttle operator than occasionally
overselling. An oversold departure is remedied commercially — a refund,
or a credit to the passenger's wallet for a future trip.

**What that costs.** Tickets are issued at payment, so N passengers can
each be told there is room, all pay, and the departure oversells. The
`select_for_update()` on the `Trip` row cannot prevent it: the racing
bookings are unpaid and therefore invisible to the count. The "N racing
requests yield exactly one success" property this ADR's Decision
section implies **does not hold**, and the mandatory concurrency test
correspondingly does not assert it.

**What still holds, and why the lock stays.** The lock's job moved from
prevention to detection, which is worth having:

- **A consistent count.** Concurrent issuances cannot both read a stale
  total, so the ticket count on a trip is exactly the number issued.
- **No silent oversell.** Every issuance that crosses the line records
  a `trip.oversold` audit event naming the trip, the segment, the
  capacity and the sold count — which is what makes the refund decision
  actionable rather than hypothetical. `apps/ticketing/capacity.py`
  owns this, and its module docstring is the primary reference.
- **A real gate at booking time.** A departure already full of *paid*
  passengers still refuses new bookings. The gate cannot see in-flight
  payments; it is not nothing.

So the honest statement of the guarantee is **"no oversell is ever
silent"**, not "no oversell ever happens".

**Standing obligation 1 is unchanged and now matters more**, since the
count is the only thing standing between a departure and an unrecorded
oversell: every open-seating ticket write goes through
`apps.ticketing.services.issue_open_seating_tickets`. There is still no
database constraint to catch a path that forgets.

**Named gap.** The remedy this decision depends on does not exist in
code. `apps.ledger.services.get_or_create_refund_contra_account` exists
but nothing writes to it; there is no refund service, and
`apps/wallet/services.py` is read-only — a wallet is credited only by a
paid Paystack top-up. Recording the oversell is what stops it being
invisible in the meantime, but **acting on the record is currently
manual**. Building that path is tracked as its own slice.
