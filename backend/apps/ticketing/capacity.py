"""Open-seating capacity — docs/adr/0008 and
docs/specs/10-booking-modes.md.

**This module owns the whole invariant.** ADR-0008's first standing
obligation is that every write path to open-seating tickets goes
through the one function that takes the lock, because Postgres cannot
express "no more than N ranges overlap" and there is therefore no
database constraint to catch a path that forgets. A `Ticket` row
created for an open-seating trip anywhere else is a bug, not a
shortcut.

## What the lock actually guarantees

Less than ADR-0008 originally assumed, and it is worth being exact.

That ADR was written expecting capacity to be *enforced* — refuse the
sale when full. A product decision (2026-08-27) changed the unit of
counting to **issued tickets only**: an unpaid booking holds nothing,
because holding places for people who may never pay was judged worse
for a shuttle operator than occasionally overselling. An oversold
departure is remedied commercially instead, by refund or wallet credit.

The consequence is unavoidable: tickets are issued at payment, so N
passengers can each be told there is room, all pay, and the departure
oversells. `select_for_update()` on the `Trip` row cannot prevent that
— the racing bookings are unpaid and so invisible to the count.

What the lock still buys, and why it stays:

- **A consistent count.** Two concurrent issuances cannot both read a
  stale total and each believe they took the last place.
- **A deterministic record of every oversell.** `issue_place` never
  refuses at payment time — the money is already taken, and stranding a
  paid passenger without a ticket is worse than an oversold bus — but
  it records an `AuditLog` entry naming the booking. That is what makes
  the refund decision actionable rather than hypothetical.

So the honest statement of the guarantee is: **no oversell is ever
silent**, not "no oversell ever happens".

`check_capacity` is still a real gate at booking time — it refuses a
sale into a departure already full of *paid* passengers, which is the
common case. It just cannot see in-flight payments.
"""

from __future__ import annotations

from dataclasses import dataclass

from django.db.models import Q
from psycopg.types.range import Range

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.network.models import Stop
from apps.scheduling.models import Trip

from .models import Ticket

# Statuses that still occupy a place. A revoked or expired ticket has
# released its place; a boarded one obviously has not.
OCCUPYING_STATUSES = (Ticket.Status.ISSUED, Ticket.Status.BOARDED)


class TripNotConfigured(Exception):
    """The trip has no vehicle, so its capacity is unknowable.

    Deliberately distinct from "sold out": an operator fixes this by
    assigning a vehicle, and telling a passenger a departure is full
    when nobody has chosen a bus for it yet is simply false. Conflating
    the two is the specific defect docs/specs/10-booking-modes.md's
    availability envelope exists to fix.

    Not a rare edge case — the Celery generator creates every scheduled
    trip with no vehicle and staff assign one later, so this is the
    normal early state of nearly every trip.
    """


class TripSoldOut(Exception):
    """Every place overlapping the requested segment is already sold."""


@dataclass(frozen=True)
class Capacity:
    """`remaining is None` means unlimited — either the Business does
    not enforce capacity, or the trip is not capacity-managed at all."""

    total: int | None
    sold: int
    remaining: int | None


def segment_overlap_filter(*, from_sequence: int, to_sequence: int) -> Q:
    """Tickets whose sold segment overlaps `[from_sequence, to_sequence)`.

    The half-open range is what makes a 1→3 passenger and a 3→6
    passenger not compete: one alights exactly where the other boards.
    Identical semantics to `seating.SeatReservation.segment_range`,
    which is why `Ticket` carries the same derived column.
    """
    return Q(segment_range__overlap=Range(from_sequence, to_sequence)) & Q(
        status__in=OCCUPYING_STATUSES
    )


def get_capacity(*, trip: Trip, from_sequence: int, to_sequence: int) -> Capacity:
    """Places sold and remaining for one segment of one trip.

    Read-only and lock-free — this backs the availability endpoint,
    where a slightly stale number is fine and taking a row lock per page
    view would not be. The booking and issuance paths call
    `check_capacity`/`issue_place` instead, which lock.
    """
    sold = Ticket.all_objects.filter(
        segment_overlap_filter(from_sequence=from_sequence, to_sequence=to_sequence),
        trip=trip,
    ).count()

    if not trip.business.capacity_enforced:
        return Capacity(total=None, sold=sold, remaining=None)

    vehicle = trip.vehicle
    if vehicle is None:
        # Unknowable, not unlimited. Reporting it as unlimited would be
        # the worse failure — see TripNotConfigured.
        return Capacity(total=None, sold=sold, remaining=None)

    total = vehicle.vehicle_type.capacity
    return Capacity(total=total, sold=sold, remaining=max(total - sold, 0))


def check_capacity(*, trip: Trip, from_sequence: int, to_sequence: int, places: int) -> None:
    """Refuses a sale that a departure demonstrably cannot take.

    **Must be called inside a transaction that already holds
    `select_for_update()` on `trip`** — `apps.booking.services.create_booking`
    takes it. Without the lock two concurrent bookings can read the same
    total; with it they cannot.

    Raises `TripNotConfigured` when capacity is unknowable and
    `TripSoldOut` when it is known and exhausted. A Business with
    `capacity_enforced = False` is never refused.
    """
    if not trip.business.capacity_enforced:
        return

    if trip.vehicle is None:
        raise TripNotConfigured(
            "This departure has no vehicle assigned yet, so it is not open for booking."
        )

    capacity = get_capacity(trip=trip, from_sequence=from_sequence, to_sequence=to_sequence)
    assert capacity.remaining is not None  # capacity_enforced + a vehicle
    if capacity.remaining < places:
        raise TripSoldOut("This departure is full for the journey you selected.")


def record_oversell_if_any(
    *, trip: Trip, from_stop: Stop, to_stop: Stop, from_sequence: int, to_sequence: int
) -> int:
    """Records — never refuses — an oversold departure at issuance time.

    Called after tickets are written, inside the same locked
    transaction. Returns the number of places sold beyond capacity (0
    when there is no oversell).

    Refusing here is not an option: `mark_booking_paid` runs from the
    Paystack webhook with the passenger's money already taken, and a
    paid passenger with no ticket is worse than an oversold bus. So the
    only useful thing to do is make it loud. Without this an oversell
    would be invisible until the roadside.
    """
    if not trip.business.capacity_enforced or trip.vehicle is None:
        return 0

    capacity = get_capacity(trip=trip, from_sequence=from_sequence, to_sequence=to_sequence)
    assert capacity.total is not None
    oversold_by = capacity.sold - capacity.total
    if oversold_by <= 0:
        return 0

    record_audit_event(
        actor=None,
        action="trip.oversold",
        target=trip,
        client_id=str(trip.client_id),
        from_stop_id=str(from_stop.id),
        to_stop_id=str(to_stop.id),
        capacity=str(capacity.total),
        sold=str(capacity.sold),
        oversold_by=str(oversold_by),
    )
    return oversold_by


def is_open_seating(trip: Trip) -> bool:
    return trip.booking_mode == Business.BookingMode.OPEN_SEATING
