"""apps.seating.services.change_seat — docs/specs/22-marketplace.md
slice 3's "Change seat" link. Service-level tests only; the HTTP-level
ownership/gating tests live with their own endpoints
(apps/booking/tests/test_booking.py, apps/marketplace/tests/
test_marketplace_booking_flow.py)."""

import pytest

from apps.booking.models import Traveler
from apps.booking.services import create_booking
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..models import SeatReservation
from ..services import ReservationNotChangeable, SeatUnavailable, change_seat
from .factories import SeatFactory

pytestmark = pytest.mark.django_db


def _trip_with_two_seats(client: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=2)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        trip = TripFactory(client=client, route=route, business=route.business, vehicle=vehicle)
        seat_a = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_b = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        FareRuleFactory(client=client, route=route, business=route.business, amount="500.00")
    return trip, stop_a, stop_b, seat_a, seat_b


def _held_booking_with_traveler(client: object):  # type: ignore[no-untyped-def]
    """`travelers` (plural), not explicit `seats` — the auto-allocate
    path `apps.marketplace`'s own booking-create call actually uses, and
    the only shape that ties a `Traveler` to the resulting
    `SeatReservation` (a mix of the two is not a real caller shape; see
    `create_booking`'s own docstring). Picks seat "1A" — `_allocate_seats`
    sorts by row/column/seat_number, and it is created first."""
    trip, stop_a, stop_b, seat_a, seat_b = _trip_with_two_seats(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            passenger_count=1,
            from_stop=stop_a,
            to_stop=stop_b,
            travelers=[
                {
                    "first_name": "Ada",
                    "last_name": "Lovelace",
                    "phone": "+2348000000000",
                    "email": "ada@example.com",
                }
            ],
            idempotency_key="change-seat-fixture",
        )
        reservation = SeatReservation.objects.get(booking=booking)
        assert reservation.seat_id == seat_a.id
    return trip, booking, reservation, seat_b


def test_change_seat_moves_the_hold_and_repoints_the_traveler() -> None:
    client = ClientFactory()
    trip, booking, reservation, seat_b = _held_booking_with_traveler(client)

    with tenant_context(str(client.id)):
        new_reservation = change_seat(
            reservation=reservation, new_seat=seat_b, hold_minutes=15, actor=booking.passenger
        )

        assert new_reservation.seat_id == seat_b.id
        assert new_reservation.status == SeatReservation.Status.HELD
        assert new_reservation.amount == reservation.amount
        assert new_reservation.booking_id == booking.id

        old = SeatReservation.objects.get(pk=reservation.pk)
        assert old.status == SeatReservation.Status.RELEASED

        traveler = Traveler.objects.get(booking=booking)
        assert traveler.seat_reservation_id == new_reservation.id
        assert traveler.first_name == "Ada"


def test_change_seat_refuses_a_seat_already_taken() -> None:
    client = ClientFactory()
    trip, booking, reservation, seat_b = _held_booking_with_traveler(client)
    other_passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        other_booking = create_booking(
            trip=trip,
            passenger=other_passenger,
            seats=[
                {
                    "seat": seat_b,
                    "from_stop": reservation.from_stop,
                    "to_stop": reservation.to_stop,
                }
            ],
            idempotency_key="change-seat-collision",
        )

        with pytest.raises(SeatUnavailable):
            change_seat(
                reservation=reservation, new_seat=seat_b, hold_minutes=15, actor=booking.passenger
            )

        # Refused cleanly — the original hold is untouched, not
        # half-released.
        unchanged = SeatReservation.objects.get(pk=reservation.pk)
        assert unchanged.status == SeatReservation.Status.HELD
        assert unchanged.seat_id == reservation.seat_id
        assert SeatReservation.objects.filter(booking=other_booking).exists()


def test_change_seat_refuses_a_reservation_that_is_no_longer_held() -> None:
    client = ClientFactory()
    trip, booking, reservation, seat_b = _held_booking_with_traveler(client)
    with tenant_context(str(client.id)):
        reservation.status = SeatReservation.Status.CONFIRMED
        reservation.save(update_fields=["status"])

        with pytest.raises(ReservationNotChangeable):
            change_seat(
                reservation=reservation, new_seat=seat_b, hold_minutes=15, actor=booking.passenger
            )
