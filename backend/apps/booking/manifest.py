"""Who is aboard a trip — see docs/specs/18-manifest-and-staff-booking.md.

A composition, not a domain. Every field here already existed across
`booking`, `seating`, `ticketing`, `tapngo` and `identity`; nothing
assembled them, so an operator standing at a bus door had no screen to
look at and `booking-list` filtered by trip was the closest thing.

## Why this returns a `kind`, not just a list

Following the precedent `GET /trips/{id}/availability/` set in
docs/specs/10-booking-modes.md: a bare array made two very different
states indistinguishable. A **pay-as-you-go** trip sells no `Booking`
and issues no `Ticket` at all, so a manifest that returned `[]` for one
would tell an operator the bus is empty when it is full. `kind` branches
the query, not just the label — PAYG reads `tapngo.FareJourney` instead.

## Why a module of its own, not `services.py`

`apps.booking.services` owns the write path, and its docstring is about
the booking transaction and its idempotency. This is a read that reaches
across four other apps; keeping it separate stops the write service
growing imports it has no business holding.
"""

from collections import defaultdict
from decimal import Decimal
from typing import Any, TypedDict

from django.db.models import QuerySet

from apps.analytics.services import seats_sold_and_total
from apps.businesses.models import Business
from apps.scheduling.models import Trip
from apps.seating.models import SeatReservation
from apps.tapngo.models import FareJourney
from apps.ticketing.models import Ticket

from .models import Booking

#: What `results` is a list of, for each `kind`. Both shapes carry
#: `passenger_name` and never a passenger's contact details — the
#: manifest is the most identifying screen in the operator console, and
#: matching a face to a seat needs no phone number.
PREPAID = "prepaid"
PAY_AS_YOU_GO = "pay_as_you_go"

#: Module-level and named in `SPECTACULAR_SETTINGS["ENUM_NAME_OVERRIDES"]`.
#: Without the override drf-spectacular names a generated enum after a
#: **hash of its own choice set**, so adding a third `kind` later would
#: silently rename the type `schema.ts` exports — the defect spec 17
#: slice 1 hit and recorded. `import_string` cannot walk into a nested
#: class, so this cannot live on a `TextChoices`.
MANIFEST_KIND_CHOICES = [
    (PREPAID, "Prepaid"),
    (PAY_AS_YOU_GO, "Pay as you go"),
]

#: Booking statuses excluded from the manifest unless asked for.
#: `pending_payment` is **not** among them, deliberately: an operator
#: needs to know a held seat is unpaid, and hiding it is how a seat gets
#: sold twice in practice.
_EXCLUDED_BOOKING_STATUSES = (Booking.Status.CANCELLED, Booking.Status.EXPIRED)


class Totals(TypedDict):
    passengers: int
    boarded: int
    #: `None` when no vehicle is assigned — unknowable, not zero. The
    #: same distinction `apps.ticketing.capacity` owns and spec 10's
    #: availability envelope exists to preserve.
    capacity: int | None


def _passenger_name(first_name: str, last_name: str, email: str) -> str:
    """A name to read off a list, falling back to the email local part.

    A blank cell beside a seat number is worse than an imperfect name:
    it reads as "nobody", and the seat is sold.
    """
    full = f"{first_name} {last_name}".strip()
    return full or email.split("@")[0]


def ticket_queryset(*, trip: Trip, include_cancelled: bool) -> QuerySet[Ticket]:
    """One row per **ticket**, not per booking.

    A four-passenger open-seating booking issues four tickets, each
    separately scannable, and a reservation booking issues one per
    `SeatReservation`. Listing bookings would put four people on one
    line and make "who is aboard" unanswerable.

    Ordering is declared here rather than inherited: `Ticket.Meta` and
    `Seat.Meta` are both `-created_at`, which would scatter a group
    around the vehicle — the same trap docs/specs/10-booking-modes.md
    records for quick-book seat allocation. Seat number where seats
    exist, issuance order where they do not.

    `select_related` is sized to exactly what `ticket_row` reads. The
    query count must not grow with the row count, which a
    `CaptureQueriesContext` test pins.
    """
    queryset = Ticket.objects.filter(trip=trip).select_related(
        "booking",
        "booking__passenger",
        "seat_reservation",
        "seat_reservation__seat",
    )
    if not include_cancelled:
        queryset = queryset.exclude(booking__status__in=_EXCLUDED_BOOKING_STATUSES)
    return queryset.order_by(
        "seat_reservation__seat__seat_number",
        "passenger_index",
        "issued_at",
    )


def ticket_row(ticket: Ticket) -> dict[str, Any]:
    """One manifest line.

    `fare` comes from the `SeatReservation` purchase-time snapshot where
    there is one, and from the booking total divided by its passenger
    count for open seating, where there is no per-seat row to snapshot.
    Never from a live fare lookup: a manifest must show what was
    actually charged, not what the same journey would cost today.
    """
    booking = ticket.booking
    reservation = ticket.seat_reservation
    passenger = booking.passenger

    if reservation is not None:
        fare: Decimal | None = reservation.amount
        seat_number: str | None = reservation.seat.seat_number
    else:
        seat_number = None
        fare = (
            booking.total_amount / booking.passenger_count
            if booking.passenger_count
            else booking.total_amount
        )

    return {
        "ticket_id": str(ticket.id),
        "booking_id": str(booking.id),
        "booking_reference": booking.reference,
        "passenger_name": _passenger_name(
            passenger.first_name, passenger.last_name, passenger.email
        ),
        "seat_number": seat_number,
        "ticket_status": ticket.status,
        "booking_status": booking.status,
        "fare": fare,
        "currency": booking.currency,
        "boarded_at": ticket.boarded_at,
        # Only ever true when `include_cancelled` let the row through, so
        # a cancelled seat is visibly cancelled rather than merely
        # present.
        "is_cancelled": booking.status in _EXCLUDED_BOOKING_STATUSES,
    }


def unticketed_booking_queryset(*, trip: Trip, include_cancelled: bool) -> QuerySet[Booking]:
    """Bookings on this trip that have **no ticket yet**.

    A ticket is issued at payment, so an unpaid booking has none — which
    meant a `Ticket`-only manifest could not show one, and the module's
    own rule that "`pending_payment` is not excluded, deliberately" was
    true of the filter and false of the result.

    That gap was invisible until slice 2: with **no cash account in the
    ledger** (ADR-0006), a counter booking that the passenger has not yet
    paid for is the *ordinary* outcome of booking at a desk, not an edge
    case. An agent who sold a seat and then could not see it on the
    manifest is precisely the "seat gets sold twice" failure the rule
    above exists to prevent.
    """
    ticketed = Ticket.objects.filter(trip=trip).values("booking_id")
    queryset = (
        Booking.objects.filter(trip=trip).exclude(id__in=ticketed).select_related("passenger")
    )
    if not include_cancelled:
        queryset = queryset.exclude(status__in=_EXCLUDED_BOOKING_STATUSES)
    return queryset.order_by("created_at")


def _reservations_by_booking(bookings: list[Booking]) -> dict[Any, list[SeatReservation]]:
    """One batched query, grouped — `SeatReservation.booking` uses
    `related_name="+"`, so there is no reverse manager to `prefetch`
    (the same reason `apps.booking.views` groups them by hand)."""
    grouped: dict[Any, list[SeatReservation]] = defaultdict(list)
    reservations = SeatReservation.objects.filter(
        booking_id__in=[booking.id for booking in bookings]
    ).select_related("seat")
    for reservation in reservations:
        grouped[reservation.booking_id].append(reservation)
    return grouped


def _unticketed_row(
    booking: Booking, *, seat_number: str | None, fare: Decimal | None
) -> dict[str, Any]:
    """The same shape as `ticket_row`, with the ticket's own fields null.

    Null rather than an invented status: there is no ticket, and
    inventing a `not_issued` member of `Ticket.Status` would put a value
    in the enum that no `Ticket` row can ever hold. The screen renders
    the null as "Not issued".
    """
    passenger = booking.passenger
    return {
        "ticket_id": None,
        "booking_id": str(booking.id),
        "booking_reference": booking.reference,
        "passenger_name": _passenger_name(
            passenger.first_name, passenger.last_name, passenger.email
        ),
        "seat_number": seat_number,
        "ticket_status": None,
        "booking_status": booking.status,
        "fare": fare,
        "currency": booking.currency,
        "boarded_at": None,
        "is_cancelled": booking.status in _EXCLUDED_BOOKING_STATUSES,
    }


def unticketed_rows(*, trip: Trip, include_cancelled: bool) -> list[dict[str, Any]]:
    """One row per held seat, or per place on an open-seating booking —
    the same "never one line for four people" rule `ticket_queryset`
    follows."""
    bookings = list(unticketed_booking_queryset(trip=trip, include_cancelled=include_cancelled))
    reservations = _reservations_by_booking(bookings)

    rows: list[dict[str, Any]] = []
    for booking in bookings:
        held = reservations.get(booking.id, [])
        if held:
            rows.extend(
                _unticketed_row(
                    booking, seat_number=reservation.seat.seat_number, fare=reservation.amount
                )
                for reservation in held
            )
            continue
        # Open seating: no per-seat rows to snapshot, so the fare is the
        # booking total shared out, exactly as `ticket_row` does it.
        count = booking.passenger_count or 1
        fare = booking.total_amount / count if booking.passenger_count else booking.total_amount
        rows.extend(_unticketed_row(booking, seat_number=None, fare=fare) for _ in range(count))
    return rows


def _row_sort_key(row: dict[str, Any]) -> tuple[bool, str, str]:
    """Seats first, in seat order; then the seatless, grouped by booking.

    Declared here rather than left to the database because the list is
    now a merge of two queries — and `Ticket.Meta`/`Seat.Meta` order by
    `-created_at`, which would scatter a group around the vehicle.
    """
    seat_number = row["seat_number"]
    return (seat_number is None, seat_number or "", row["booking_reference"])


def prepaid_rows(*, trip: Trip, include_cancelled: bool) -> list[dict[str, Any]]:
    """Every prepaid manifest line: issued tickets **and** held-but-unpaid
    bookings, in one order.

    A list rather than a queryset because it is a merge of two. Bounded
    by one trip — at most a vehicle's worth of rows — so materialising it
    is what makes a single consistent ordering possible, and the query
    count still does not grow with the row count.
    """
    tickets = ticket_queryset(trip=trip, include_cancelled=include_cancelled)
    rows = [ticket_row(ticket) for ticket in tickets]
    rows.extend(unticketed_rows(trip=trip, include_cancelled=include_cancelled))
    rows.sort(key=_row_sort_key)
    return rows


def journey_queryset(*, trip: Trip) -> QuerySet[FareJourney]:
    """Pay-as-you-go: the people who tapped on.

    `include_cancelled` has no meaning here — a journey is not
    cancellable, it is opened by a tap and closed by another — so it is
    not a parameter. An **open** journey is someone still aboard, which
    is exactly who an operator asking "who is on this bus" wants first;
    hence boarding order, oldest first.
    """
    return (
        FareJourney.objects.filter(trip=trip)
        .select_related("passenger", "board_stop", "alight_stop")
        .order_by("boarded_at")
    )


def journey_row(journey: FareJourney) -> dict[str, Any]:
    passenger = journey.passenger
    return {
        "journey_id": str(journey.id),
        "passenger_name": _passenger_name(
            passenger.first_name, passenger.last_name, passenger.email
        ),
        "board_stop": journey.board_stop.name,
        # Both null while the journey is open. Rendered as in-progress
        # rather than as a blank, which would read as missing data.
        "alight_stop": journey.alight_stop.name if journey.alight_stop else None,
        "journey_status": journey.status,
        "fare": journey.amount,
        "currency": journey.currency,
        "boarded_at": journey.boarded_at,
        "alighted_at": journey.alighted_at,
    }


def manifest_kind(trip: Trip) -> str:
    return (
        PAY_AS_YOU_GO
        if trip.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO
        else PREPAID
    )


def trip_summary(trip: Trip) -> dict[str, Any]:
    return {
        "id": str(trip.id),
        "route": trip.route.name,
        "trip_class": trip.trip_class,
        "service_date": trip.service_date,
        "scheduled_departure_at": trip.scheduled_departure_at,
        "status": trip.status,
        "booking_mode": trip.booking_mode,
        "fare_collection_mode": trip.fare_collection_mode,
        "vehicle": trip.vehicle.registration_number if trip.vehicle else None,
        "driver": trip.driver.name if trip.driver else None,
    }


def totals(*, trip: Trip, kind: str, include_cancelled: bool) -> Totals:
    """Counted over the whole trip, never over the current page.

    `capacity` reuses `apps.analytics.services.seats_sold_and_total`,
    which already owns the open-seating-vs-`Seat`-count branch and the
    "no vehicle assigned means unknowable, not zero" rule. Re-deriving
    it here would be a second copy of both, and they would drift.
    """
    _, capacity = seats_sold_and_total(trip)

    if kind == PAY_AS_YOU_GO:
        journeys = journey_queryset(trip=trip)
        return {
            # Everyone who tapped on, whether or not they have tapped
            # off again.
            "passengers": journeys.count(),
            # A tap *is* the boarding on a PAYG trip, so every journey
            # counts. The two numbers being equal is correct, not a bug.
            "boarded": journeys.count(),
            "capacity": capacity,
        }

    # Counted off the same merged rows the list is built from, not off
    # `Ticket` alone. A held-but-unpaid seat is a passenger the operator
    # must account for; counting only ticketed ones would put a number
    # at the top of the screen that disagreed with the rows beneath it.
    rows = prepaid_rows(trip=trip, include_cancelled=include_cancelled)
    return {
        "passengers": len(rows),
        "boarded": sum(1 for row in rows if row["ticket_status"] == Ticket.Status.BOARDED),
        "capacity": capacity,
    }
