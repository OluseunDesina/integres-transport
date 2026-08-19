# ADR-0004: Per-segment seat concurrency strategy

Status: **Accepted.** The concurrency spike test required by the last
bullet of §3 (`apps/seating/tests/test_seat_concurrency.py`) exists and
passes reliably (6 concurrent workers, run repeatedly, exactly one
succeeds every time). Built in Phase 4 Slice 2 alongside the real
`SeatReservation` model and its exclusion constraint — see that
migration/test for the mechanism in place, and the note below for one
real behavior the spike test itself surfaced that wasn't anticipated
when this ADR was first decided.

## Context

Seat inventory is per-segment: a seat booked A→B must remain available
for C→D on the same trip, and two concurrent requests for an
overlapping segment on the same seat must not both succeed. The brief
calls this "the single most important modeling decision in the system"
but does not specify the concurrency mechanism. This is tracked here so
it is decided deliberately, with a proof-of-concept, before Phase 4
code is written — not discovered when Phase 4's mandatory
concurrent-booking test starts flaking.

This ADR also settles a related, previously-undecided business rule:
seat holds and confirmed bookings only exist for Businesses running in
`reservation` mode. A `tap_and_go` Business (Metro is the reference
example) has no seat selection step at all, so it never creates a
`SeatReservation` row and this entire mechanism is inert for it. How
`tap_and_go` fare collection actually works is a real, still-open
question — explicitly not answered here, and not silently assumed
either; it is a named non-goal of `docs/specs/4-fares-seating-booking.md`.

## Decision

**Mechanism**: Postgres range types plus a `GiST` exclusion constraint
(`EXCLUDE USING gist`, requiring the `btree_gist` extension already
enabled in the dev Postgres image since Phase 0) on
`(seat_id, trip_id, segment_range) WHERE overlaps`, so the database
itself atomically rejects two overlapping-segment reservations for the
same physical seat — correctness enforced by a constraint, not solely
by application-level locking.

**1. Segment storage: explicit `(from_stop, to_stop)` pair, not a raw
integer range.** A reservation stores the actual `Stop` foreign keys a
passenger boards/alights at — that's what an admin, support agent, or
receipt needs to display, not a sequence number. Application code
validates `from_stop` precedes `to_stop` in the Route's `RouteStop`
ordering. The exclusion constraint itself still needs a genuine range
type to do its overlap check, so a `segment_range` (`int4range`) column
is *derived* from `RouteStop.sequence` at write time and exists purely
as the constraint's enforcement mechanism — never read or written
directly by application logic, never surfaced in an API response.

**2. `SeatHold` and `Booking` share one lifecycle, one table, one
constraint.** Rather than two different correctness mechanisms (an
advisory lock for the temporary hold, the exclusion constraint for the
confirmed booking) that could drift out of sync with each other, a
single `SeatReservation` row represents both states through a `status`
column: `held` → `confirmed` (on payment success, Phase 5) / `expired`
(hold window passed) / `released` (explicit cancellation). **One**
exclusion constraint, scoped with `WHERE status IN ('held',
'confirmed')`, protects both a live hold and a confirmed booking
identically — an `expired`/`released` row never blocks a new hold on
the same seat/segment, without needing separate cleanup logic to keep
two mechanisms consistent.

**3. Hold duration is a per-Business setting, configurable only by
Integra platform staff.** `Business.seat_hold_minutes` (default 15)
sets how long a `held` `SeatReservation` survives before a Celery Beat
job (mirroring `apps.scheduling`'s existing daily Trip-generation job)
sweeps it to `expired`. This is deliberately **not** editable by the
operator's own client-admin staff — only via a super-admin-gated
endpoint — so an operator cannot lengthen their own hold window to
tie up inventory competitors could otherwise sell. Confirmed directly
with the product owner as a business rule, not inferred.

## Options considered

- **Integer range over raw stop-sequence position** (the original
  proposed direction). Simpler constraint plumbing (no derived column
  needed — the range *is* the stored value), but sequence numbers on
  their own are not what a human reading a reservation record needs to
  see. Rejected in favor of the explicit stop-pair, which costs one
  derived, internal-only column in exchange for materially more
  readable data.
- **`SeatHold` on an advisory lock, `Booking` on the exclusion
  constraint** (the original second option). Avoids putting `held` rows
  in the same constraint-checked table as confirmed bookings, but means
  two independent correctness mechanisms have to agree with each other
  forever — an advisory lock says nothing to the exclusion constraint
  and vice versa, so a bug in either one's cleanup path could let a
  hold and a booking silently overlap. Rejected: one lifecycle under
  one constraint is a stronger, simpler guarantee, and matches how the
  business rule itself was described (a hold "becomes" a booking, it
  isn't a different kind of thing).
- **Operator-configurable hold duration.** Simpler permission model (no
  new super-admin-only endpoint). Rejected per the product owner's
  explicit rule above — hold duration affects other operators'
  competitive access to the same inventory question space only in the
  sense that a longer hold window is a lever an operator could misuse
  against their own passengers/inventory turnover, and Integra as the
  platform operator is the correct party to control it.

## Consequences

- Database-level correctness for the core booking invariant,
  independent of application bugs — at the cost of Postgres-specific
  SQL (exclusion constraints, range types) that a future database
  migration away from Postgres would need to reimplement deliberately,
  not incidentally.
- `Business` gains two new fields in Phase 4 despite being "done" since
  Phase 1: `seat_hold_minutes` (super-admin-only mutable) and
  `fare_pricing_mode` (see `docs/specs/4-fares-seating-booking.md`,
  unrelated to this ADR but landing in the same migration wave).

**Implementation note (Slice 2, the concurrency spike, done)**: one
real Postgres behavior the spike test surfaced live, not anticipated
when this ADR was first decided — under genuine N-way concurrent
contention for the same seat/segment, Postgres does not always resolve
every losing transaction with a clean exclusion-constraint violation
(`IntegrityError`). Some are instead chosen as the victim of a genuine
deadlock between transactions each waiting on another's row lock while
checking the constraint (`OperationalError: deadlock detected`,
SQLSTATE `40P01`). `apps.seating.services.create_reservation` catches
both and treats them identically — a caller doesn't need to know which
one happened, only that this specific attempt on this seat/segment
could not be completed and should be retried. Confirmed via 5
consecutive clean runs of the 6-worker spike test after the fix, not
just one passing run.
