"""Fat-service layer for Seat inventory and seat reservations — see
docs/specs/4-fares-seating-booking.md §4 and docs/adr/0004."""

import string
from datetime import timedelta
from decimal import Decimal
from typing import Any, TypedDict

from django.db import IntegrityError, OperationalError, transaction
from django.db.models.deletion import ProtectedError
from django.utils import timezone
from psycopg.types.range import Range

from apps.booking.models import Booking
from apps.core.audit import record_audit_event
from apps.fares.models import FareRule, FareSegmentRule
from apps.fleet.models import VehicleType
from apps.identity.models import User
from apps.network.models import RouteStop, Stop
from apps.scheduling.models import Trip

from .models import Seat, SeatReservation


class SeatUnavailable(Exception):
    """Raised when the exclusion constraint rejects a reservation —
    mapped to a 409 by the view layer. The database's own constraint is
    the source of truth (docs/adr/0004); this never pre-checks and
    trusts the result, since that would reintroduce the exact race the
    constraint exists to close."""


class SeatsInUse(Exception):
    """Raised when replacing a VehicleType's seats would delete a Seat
    that still has a SeatReservation against it (held, confirmed,
    expired, or released — `on_delete=PROTECT` doesn't distinguish
    status). Mapped to a 409 by the view layer — see
    docs/specs/8-seat-map-generation.md's "Edge cases" §1."""


class SeatAvailability(TypedDict):
    seat: Seat
    is_available: bool


class SeatSpec(TypedDict):
    seat_number: str
    row: int | None
    column: int | None


def replace_vehicle_type_seats(
    *, vehicle_type: VehicleType, seats: list[SeatSpec], updated_by: User
) -> list[Seat]:
    """Bulk replace — mirrors apps.network.services.set_route_stops's
    hard-delete-and-recreate shape. `seats` is already validated
    non-duplicate (by seat_number) and within vehicle_type.capacity by
    the serializer (mirroring RouteStopsUpdateSerializer's own
    validate_stops).

    Deletes via `all_objects`, not `.objects`, for the exact reason
    `set_route_stops`'s own docstring documents: `apps.core.rls.platform_staff_bypass()`
    only changes Postgres-level GUCs, not the Python contextvar
    `TenantScopedManager` reads, so `.objects.filter(...).delete()`
    silently matches zero rows for a caller running under that bypass
    (a management command, e.g. `seed_e2e_users`) — a no-op delete
    followed by a recreate that then collides with the still-present
    old rows on `unique_seat_number_per_vehicle_type`. This function
    mirrored `set_route_stops`'s shape but not its fix; caught by
    inspection, not live, since `seed_e2e_users`' own call site already
    guards around it (skips reseeding a VehicleType that already has
    Seats, to avoid cascading away real SeatReservations) — that guard
    stays regardless of this fix, it protects a different concern.

    A Seat with a real SeatReservation against it can't be deleted
    (`SeatReservation.seat` is `on_delete=PROTECT`) — raises `SeatsInUse`
    instead of letting a raw `ProtectedError` surface as an unhandled
    500 (docs/specs/8-seat-map-generation.md's "Edge cases" §1)."""
    with transaction.atomic():
        try:
            Seat.all_objects.filter(vehicle_type=vehicle_type).delete()
        except ProtectedError as exc:
            in_use_count = len(exc.protected_objects)
            raise SeatsInUse(
                "This vehicle type's seats can't be regenerated: "
                f"{in_use_count} seat(s) have reservations against them"
            ) from exc
        created = [
            Seat.objects.create(
                client=vehicle_type.client,
                vehicle_type=vehicle_type,
                seat_number=seat["seat_number"],
                row=seat["row"],
                column=seat["column"],
            )
            for seat in seats
        ]
    record_audit_event(
        actor=updated_by,
        action="vehicle_type.seats_updated",
        target=vehicle_type,
        seat_numbers=[seat["seat_number"] for seat in seats],
    )
    return created


def generate_seat_layout(
    *,
    rows: int,
    columns: int,
    aisle_after_column: int | None,
    numbering_scheme: str,
) -> list[SeatSpec]:
    """Computes a full rows x columns seat layout —
    docs/specs/8-seat-map-generation.md. `aisle_after_column` models a
    real physical aisle: it consumes one column *slot* (so the stored
    `column` integer jumps by 2 across it, e.g. 1,2,4,5) without
    reducing the row's real seat count — `rows * columns` is still the
    exact number of seats produced, capacity validation is unaffected.
    `seat_number` numbers seats sequentially by position (still
    contiguous A,B,C,D...); only the persisted `column` integer carries
    the gap, which is what lets a renderer detect where to draw the
    aisle. `numbering_scheme="row_letter"` is the only scheme v1
    builds — validated by the serializer, not re-checked here."""
    column_letters = string.ascii_uppercase
    layout: list[SeatSpec] = []
    for row in range(1, rows + 1):
        column = 0
        for seat_index in range(1, columns + 1):
            column += 1
            if aisle_after_column is not None and column == aisle_after_column + 1:
                column += 1
            layout.append(
                SeatSpec(
                    seat_number=f"{row}{column_letters[seat_index - 1]}", row=row, column=column
                )
            )
    return layout


def _segment_sequence_range(*, route_id: Any, from_stop: Stop, to_stop: Stop) -> tuple[int, int]:
    """Resolves (from_sequence, to_sequence) via RouteStop — mirrors
    apps.fares.serializers's own stop-order validation. Raises
    ValueError if either stop isn't on the route or is out of order."""
    sequence_by_stop_id = {
        route_stop.stop_id: route_stop.sequence
        for route_stop in RouteStop.objects.filter(
            route_id=route_id, stop_id__in=[from_stop.id, to_stop.id]
        )
    }
    if from_stop.id not in sequence_by_stop_id or to_stop.id not in sequence_by_stop_id:
        raise ValueError("Both stops must be on the route.")
    from_sequence = sequence_by_stop_id[from_stop.id]
    to_sequence = sequence_by_stop_id[to_stop.id]
    if from_sequence >= to_sequence:
        raise ValueError("from_stop must come before to_stop on the route.")
    return from_sequence, to_sequence


def get_availability(*, trip: Trip, from_stop: Stop, to_stop: Stop) -> list[SeatAvailability]:
    """One row per active Seat on trip.vehicle's VehicleType. A Trip
    with no Vehicle assigned yet has no seats to check availability
    against — returns an empty list, the same non-error "not yet
    configured" state Seat's own docstring names for a VehicleType with
    zero Seat rows, not a 400/404."""
    vehicle = trip.vehicle
    if vehicle is None:
        return []
    from_sequence, to_sequence = _segment_sequence_range(
        route_id=trip.route_id, from_stop=from_stop, to_stop=to_stop
    )
    requested_range = Range(from_sequence, to_sequence)
    seats = list(Seat.objects.filter(vehicle_type_id=vehicle.vehicle_type_id, is_active=True))
    occupied_seat_ids = set(
        SeatReservation.objects.filter(
            trip=trip,
            status__in=[SeatReservation.Status.HELD, SeatReservation.Status.CONFIRMED],
            segment_range__overlap=requested_range,
        ).values_list("seat_id", flat=True)
    )
    return [{"seat": seat, "is_available": seat.id not in occupied_seat_ids} for seat in seats]


def create_reservation(
    *,
    trip: Trip,
    seat: Seat,
    from_stop: Stop,
    to_stop: Stop,
    booking: Booking,
    hold_minutes: int,
    amount: Decimal,
    fare_rule: FareRule | None = None,
    fare_segment_rule: FareSegmentRule | None = None,
) -> SeatReservation:
    """Always attempts the insert and lets the database's exclusion
    constraint decide (docs/adr/0004) — never pre-checks
    get_availability() and trusts it, which would reopen the exact race
    window the constraint exists to close (see this function's own
    concurrency proof: apps/seating/tests/test_seat_concurrency.py).

    Catches `OperationalError` alongside `IntegrityError`, not just the
    latter: empirically, under genuine N-way concurrent contention for
    the same seat/segment, Postgres does not always resolve every
    losing transaction with a clean exclusion-constraint violation
    (`IntegrityError`, SQLSTATE class 23) — some are instead chosen as
    the victim of a genuine deadlock between transactions each waiting
    on the other's row lock while checking the constraint
    (`OperationalError: deadlock detected`, SQLSTATE 40P01), caught
    live by this function's own concurrency spike test, not
    anticipated in advance. Both outcomes mean the same thing to a
    caller: this specific attempt could not be safely completed against
    this seat/segment right now — the passenger doesn't need to know
    which one happened, only that they should try again.

    `amount` / `fare_rule` / `fare_segment_rule` are the purchase-time
    snapshot — exactly one of the two rule FKs must be set (enforced
    by the SeatReservation CHECK constraint)."""
    if (fare_rule is None) == (fare_segment_rule is None):
        raise ValueError("Exactly one of fare_rule or fare_segment_rule must be set.")
    from_sequence, to_sequence = _segment_sequence_range(
        route_id=trip.route_id, from_stop=from_stop, to_stop=to_stop
    )
    try:
        with transaction.atomic():
            reservation = SeatReservation.objects.create(
                client=trip.client,
                trip=trip,
                seat=seat,
                booking=booking,
                from_stop=from_stop,
                to_stop=to_stop,
                segment_range=Range(from_sequence, to_sequence),
                status=SeatReservation.Status.HELD,
                held_until=timezone.now() + timedelta(minutes=hold_minutes),
                amount=amount,
                fare_rule=fare_rule,
                fare_segment_rule=fare_segment_rule,
            )
    except (IntegrityError, OperationalError) as exc:
        raise SeatUnavailable(
            f"Seat {seat.seat_number} is not available for this segment."
        ) from exc
    record_audit_event(
        actor=booking.passenger, action="seat_reservation.created", target=reservation
    )
    return reservation


def refresh_seat_holds(*, booking: Booking, hold_minutes: int) -> int:
    """Called by `apps.payments.services.initiate_payment()` at checkout
    start (docs/specs/5-payments-wallet-ledger.md's edge case 6) —
    extends every still-`HELD` `SeatReservation` for the booking to a
    fresh `hold_minutes` window from now, shrinking the "seat hold
    expires mid-checkout" race to "checkout takes longer than one fresh
    hold window," the same risk `create_reservation` already accepts,
    not a new one. Lives here, not in `apps.payments` or `apps.booking`
    — `apps.seating` already owns `held_until`/`hold_minutes` semantics
    end-to-end (docs/adr/0004).

    A booking with no `HELD` reservations left (already fully confirmed,
    expired, or released) simply updates zero rows — not an error;
    `initiate_payment()`'s own booking-status guard is what rejects an
    unpayable booking, not this function."""
    return SeatReservation.objects.filter(
        booking=booking, status=SeatReservation.Status.HELD
    ).update(held_until=timezone.now() + timedelta(minutes=hold_minutes))
