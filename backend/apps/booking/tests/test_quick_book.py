"""Quick book — reservation mode with seat choice turned off,
docs/specs/10-booking-modes.md slice 4.

The passenger says how many places; the operator's seats are allocated
for them. It is **not** open seating: real `SeatReservation` rows are
written against real `Seat`s, so the departure keeps its seat map, its
GiST exclusion constraint and its per-seat tickets. Only the *choosing*
is gone.

Slice 1 added `Business.seat_selection_enabled` as a stored field that
nothing read. These tests are what make it mean something.
"""

import datetime

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.services import create_booking
from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.serializers import CustomerTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.seating.models import Seat, SeatReservation
from apps.seating.tests.factories import SeatFactory
from apps.ticketing.capacity import TripNotConfigured, TripSoldOut
from apps.ticketing.models import Ticket

pytestmark = pytest.mark.django_db


def _auth_client(user: object) -> APIClient:
    token = CustomerTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _quick_book_trip(client, *, seat_count=4, seat_selection_enabled=False, with_vehicle=True):  # type: ignore[no-untyped-def]
    business = BusinessFactory(
        client=client,
        booking_mode_default=Business.BookingMode.RESERVATION,
        seat_selection_enabled=seat_selection_enabled,
    )
    route = RouteFactory(client=client, business=business)
    stop_a = StopFactory(client=client, business=business)
    stop_b = StopFactory(client=client, business=business)
    RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
    RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)

    vehicle = None
    if with_vehicle:
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=seat_count)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        # Deliberately created out of row order, so the allocation order
        # asserted below is the one this code chooses rather than the
        # one the rows happened to be inserted in — `Seat.Meta.ordering`
        # is `-created_at`, which would hand out 1D first.
        for row, column, seat_number in reversed(
            [(1, 1, "1A"), (1, 2, "1B"), (1, 3, "1C"), (1, 4, "1D")][:seat_count]
        ):
            SeatFactory(
                client=client,
                vehicle_type=vehicle_type,
                seat_number=seat_number,
                row=row,
                column=column,
            )

    departure = timezone.now() + datetime.timedelta(hours=2)
    trip = TripFactory(
        client=client,
        route=route,
        business=business,
        vehicle=vehicle,
        booking_mode=Business.BookingMode.RESERVATION,
        service_date=departure.date(),
        scheduled_departure_at=departure,
    )
    FareRuleFactory(client=client, route=route, business=business, amount="500.00")
    return trip, stop_a, stop_b


class TestAllocation:
    def test_allocates_seats_in_row_order_and_prices_per_passenger(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=2,
                from_stop=stop_a,
                to_stop=stop_b,
                idempotency_key="quick-1",
            )
            reservations = list(
                SeatReservation.objects.filter(booking=booking).select_related("seat")
            )

        assert booking.passenger_count == 2
        assert str(booking.total_amount) == "1000.00"
        # Real reservations against real seats — this is reservation
        # mode, not open seating.
        assert sorted(r.seat.seat_number for r in reservations) == ["1A", "1B"]

    def test_a_second_booking_gets_the_next_free_seats(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client)
            create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=2,
                from_stop=stop_a,
                to_stop=stop_b,
                idempotency_key="quick-1",
            )
            second = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=2,
                from_stop=stop_a,
                to_stop=stop_b,
                idempotency_key="quick-2",
            )
            seat_numbers = sorted(
                r.seat.seat_number
                for r in SeatReservation.objects.filter(booking=second).select_related("seat")
            )

        assert seat_numbers == ["1C", "1D"]

    def test_refuses_all_or_nothing_when_too_few_seats_remain(self) -> None:
        """The spec's own edge case. A group is never split across a
        booking that half-succeeded."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client, seat_count=2)
            with pytest.raises(TripSoldOut):
                create_booking(
                    trip=trip,
                    passenger=PassengerUserFactory(client=client),
                    passenger_count=3,
                    from_stop=stop_a,
                    to_stop=stop_b,
                    idempotency_key="too-many",
                )
            assert SeatReservation.objects.filter(trip=trip).count() == 0

    def test_refuses_a_trip_with_no_vehicle_as_not_configured(self) -> None:
        """Distinct from sold out, for the reason docs/adr/0008 gives:
        an operator fixes one and a passenger fixes the other."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client, with_vehicle=False)
            with pytest.raises(TripNotConfigured):
                create_booking(
                    trip=trip,
                    passenger=PassengerUserFactory(client=client),
                    passenger_count=1,
                    from_stop=stop_a,
                    to_stop=stop_b,
                    idempotency_key="no-bus",
                )

    def test_issues_one_seated_ticket_per_allocated_seat(self) -> None:
        from apps.booking.services import mark_booking_paid

        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=2,
                from_stop=stop_a,
                to_stop=stop_b,
                idempotency_key="quick-paid",
            )
        mark_booking_paid(booking=booking)

        with platform_staff_bypass():
            tickets = list(Ticket.all_objects.filter(booking=booking))

        assert len(tickets) == 2
        # Seated tickets, unlike open seating's — the passenger did not
        # choose the seat, but they still have one.
        assert all(ticket.seat_reservation_id is not None for ticket in tickets)


class TestApi:
    def test_a_passenger_books_by_passenger_count(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client)
            passenger = PassengerUserFactory(client=client)

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {
                "trip": str(trip.id),
                "passenger_count": 2,
                "from_stop": str(stop_a.id),
                "to_stop": str(stop_b.id),
            },
            format="json",
            HTTP_IDEMPOTENCY_KEY="quick-api-1",
        )

        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["total_amount"] == "1000.00"

    def test_sending_seats_is_refused_rather_than_ignored(self) -> None:
        """A passenger who sent `seats` believed they were choosing one.
        Dropping it silently would hand them a booking they did not ask
        for."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client)
            passenger = PassengerUserFactory(client=client)
            some_seat = Seat.objects.filter(vehicle_type_id=trip.vehicle.vehicle_type_id).first()
            assert some_seat is not None

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {
                "trip": str(trip.id),
                "seats": [
                    {
                        "seat": str(some_seat.id),
                        "from_stop": str(stop_a.id),
                        "to_stop": str(stop_b.id),
                    }
                ],
            },
            format="json",
            HTTP_IDEMPOTENCY_KEY="quick-api-seats",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "assigns seats" in str(response.data["seats"])

    def test_a_seat_selecting_business_still_requires_seats(self) -> None:
        """The switch is what changes the contract — with it on, nothing
        about the existing reservation flow moves."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client, seat_selection_enabled=True)
            passenger = PassengerUserFactory(client=client)

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {
                "trip": str(trip.id),
                "passenger_count": 2,
                "from_stop": str(stop_a.id),
                "to_stop": str(stop_b.id),
            },
            format="json",
            HTTP_IDEMPOTENCY_KEY="quick-api-off",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert "seats" in response.data

    def test_availability_reports_seat_selection_off_so_the_client_can_branch(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client)
            passenger = PassengerUserFactory(client=client)

        response = _auth_client(passenger).get(
            reverse("trip-availability", kwargs={"pk": str(trip.id)}),
            {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.data["seat_selection_enabled"] is False
        # The seats are still reported: an operator-facing view of the
        # same trip legitimately wants the map even when passengers do
        # not get to choose from it.
        assert len(response.data["seats"]) == 4

    def test_availability_reports_seat_selection_off_for_open_seating(self) -> None:
        """Never true where there are no seats to pick — a client that
        read the Business field instead would render a seat map for a
        trip that has none."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stop_a, stop_b = _quick_book_trip(client, seat_selection_enabled=True)
            trip.booking_mode = Business.BookingMode.OPEN_SEATING
            trip.save(update_fields=["booking_mode"])
            passenger = PassengerUserFactory(client=client)

        response = _auth_client(passenger).get(
            reverse("trip-availability", kwargs={"pk": str(trip.id)}),
            {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
        )

        assert response.data["seat_selection_enabled"] is False
