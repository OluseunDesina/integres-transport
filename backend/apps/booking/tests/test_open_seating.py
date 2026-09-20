"""Open-seating booking, capacity, and seatless tickets —
docs/specs/10-booking-modes.md slice 2.

The concurrency guarantees live in
`apps/ticketing/tests/test_open_seating_concurrency.py`; this module
covers the single-threaded behaviour.
"""

import datetime

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking
from apps.booking.services import create_booking, mark_booking_paid
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
from apps.seating.services import BookabilityStatus, get_bookability
from apps.ticketing import signing
from apps.ticketing.capacity import TripNotConfigured, TripSoldOut
from apps.ticketing.models import Ticket

pytestmark = pytest.mark.django_db


def _auth_client(user: object) -> APIClient:
    token = CustomerTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _open_seating_trip(client, *, capacity=10, capacity_enforced=True, with_vehicle=True, stops=3):
    """A three-stop open-seating trip by default, so overlapping and
    non-overlapping segments can both be exercised."""
    business = BusinessFactory(
        client=client,
        booking_mode_default=Business.BookingMode.OPEN_SEATING,
        capacity_enforced=capacity_enforced,
    )
    route = RouteFactory(client=client, business=business)
    stop_rows = []
    for sequence in range(1, stops + 1):
        stop = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop, sequence=sequence)
        stop_rows.append(stop)

    vehicle = None
    if with_vehicle:
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=capacity)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)

    departure = timezone.now() + datetime.timedelta(hours=2)
    trip = TripFactory(
        client=client,
        route=route,
        business=business,
        vehicle=vehicle,
        booking_mode=Business.BookingMode.OPEN_SEATING,
        service_date=departure.date(),
        scheduled_departure_at=departure,
    )
    FareRuleFactory(client=client, route=route, business=business, amount="500.00")
    return trip, stop_rows


class TestBooking:
    def test_creates_a_booking_priced_per_passenger(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=3,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key="k1",
            )

        assert booking.passenger_count == 3
        assert str(booking.total_amount) == "1500.00"
        assert booking.from_stop_id == stops[0].id
        assert booking.to_stop_id == stops[2].id

    def test_issues_one_seatless_ticket_per_passenger(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=3,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key="k1",
            )

        mark_booking_paid(booking=booking)

        with platform_staff_bypass():
            tickets = list(Ticket.all_objects.filter(booking=booking).order_by("passenger_index"))

        assert len(tickets) == 3
        assert [t.passenger_index for t in tickets] == [0, 1, 2]
        assert all(t.seat_reservation_id is None for t in tickets)
        # Each is independently scannable — the whole point of one row
        # per passenger rather than one per booking.
        assert len({t.signed_payload for t in tickets}) == 3

    def test_a_seatless_payload_verifies_and_carries_no_seat_claims(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[0],
                to_stop=stops[1],
                idempotency_key="k1",
            )
        mark_booking_paid(booking=booking)
        with platform_staff_bypass():
            ticket = Ticket.all_objects.get(booking=booking)

        claims = signing.verify_and_decode(payload=ticket.signed_payload)

        assert claims["ticket_id"] == str(ticket.id)
        assert claims["seat_reservation_id"] is None
        assert claims["seat_id"] is None
        assert claims["from_stop_id"] == str(stops[0].id)


class TestCapacity:
    def test_non_overlapping_segments_do_not_compete(self) -> None:
        """The whole point of segment-awareness: a passenger riding
        stops 1→2 and one riding 2→3 are never on the bus together, so a
        one-place vehicle can sell both."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, capacity=1)
            first = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[0],
                to_stop=stops[1],
                idempotency_key="k1",
            )
        mark_booking_paid(booking=first)

        with tenant_context(str(client.id)):
            second = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[1],
                to_stop=stops[2],
                idempotency_key="k2",
            )

        assert second.passenger_count == 1

    def test_overlapping_segments_do_compete(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, capacity=1)
            first = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key="k1",
            )
        mark_booking_paid(booking=first)

        with tenant_context(str(client.id)), pytest.raises(TripSoldOut):
            create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[1],
                to_stop=stops[2],
                idempotency_key="k2",
            )

    def test_a_vehicleless_trip_is_not_configured_not_sold_out(self) -> None:
        """The distinction this slice exists to make. Refusing with
        "sold out" would send a passenger away from a departure that has
        plenty of room and send the operator looking for the wrong
        problem."""
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, with_vehicle=False)
            with pytest.raises(TripNotConfigured):
                create_booking(
                    trip=trip,
                    passenger=PassengerUserFactory(client=client),
                    passenger_count=1,
                    from_stop=stops[0],
                    to_stop=stops[1],
                    idempotency_key="k1",
                )

    def test_capacity_not_enforced_sells_past_the_vehicle_size(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, capacity=1, capacity_enforced=False)
            first = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key="k1",
            )
        mark_booking_paid(booking=first)

        with tenant_context(str(client.id)):
            second = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=5,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key="k2",
            )

        assert second.passenger_count == 5


class TestBookability:
    def test_open_reports_remaining_capacity(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, capacity=4)
            result = get_bookability(trip=trip, from_stop=stops[0], to_stop=stops[2])

        assert result.status == BookabilityStatus.OPEN
        assert result.capacity_remaining == 4
        assert result.seats == []

    def test_sold_out_when_every_place_is_taken(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, capacity=1)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=1,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key="k1",
            )
        mark_booking_paid(booking=booking)

        with tenant_context(str(client.id)):
            result = get_bookability(trip=trip, from_stop=stops[0], to_stop=stops[2])

        assert result.status == BookabilityStatus.SOLD_OUT
        assert result.capacity_remaining == 0

    def test_not_configured_when_no_vehicle_is_assigned(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, with_vehicle=False)
            result = get_bookability(trip=trip, from_stop=stops[0], to_stop=stops[1])

        assert result.status == BookabilityStatus.NOT_CONFIGURED
        # Not 0 — that would read as "sold out" to any caller doing
        # arithmetic on it.
        assert result.capacity_remaining is None

    def test_unlimited_when_capacity_is_not_enforced(self) -> None:
        client = ClientFactory()
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, capacity=1, capacity_enforced=False)
            result = get_bookability(trip=trip, from_stop=stops[0], to_stop=stops[2])

        assert result.status == BookabilityStatus.OPEN
        assert result.capacity_remaining is None


class TestApi:
    def test_passenger_books_an_open_seating_trip(self) -> None:
        client = ClientFactory()
        passenger = PassengerUserFactory(client=client)
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client)

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {
                "trip": str(trip.id),
                "passenger_count": 2,
                "from_stop": str(stops[0].id),
                "to_stop": str(stops[2].id),
            },
            format="json",
            HTTP_IDEMPOTENCY_KEY="api-open-1",
        )

        assert response.status_code == status.HTTP_201_CREATED
        with tenant_context(str(client.id)):
            booking = Booking.objects.get(pk=response.data["id"])
        assert booking.passenger_count == 2

    def test_seats_are_rejected_on_an_open_seating_trip(self) -> None:
        """Rejected, not ignored — a passenger who sent `seats` believed
        they were choosing one."""
        client = ClientFactory()
        passenger = PassengerUserFactory(client=client)
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client)

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {
                "trip": str(trip.id),
                "seats": [
                    {
                        "seat": "00000000-0000-0000-0000-000000000000",
                        "from_stop": str(stops[0].id),
                        "to_stop": str(stops[1].id),
                    }
                ],
            },
            format="json",
            HTTP_IDEMPOTENCY_KEY="api-open-2",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_passenger_count_is_rejected_on_a_reservation_trip(self) -> None:
        client = ClientFactory()
        passenger = PassengerUserFactory(client=client)
        with tenant_context(str(client.id)):
            business = BusinessFactory(client=client)
            route = RouteFactory(client=client, business=business)
            stop_a = StopFactory(client=client, business=business)
            stop_b = StopFactory(client=client, business=business)
            RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
            RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
            trip = TripFactory(client=client, route=route, business=business)

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {"trip": str(trip.id), "passenger_count": 2},
            format="json",
            HTTP_IDEMPOTENCY_KEY="api-res-1",
        )

        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_a_sold_out_departure_and_an_unconfigured_one_answer_differently(self) -> None:
        """Both are 409, but the codes must differ: one is the
        passenger's problem, the other the operator's."""
        client = ClientFactory()
        passenger = PassengerUserFactory(client=client)
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client, with_vehicle=False)

        response = _auth_client(passenger).post(
            reverse("booking-list-create"),
            {
                "trip": str(trip.id),
                "passenger_count": 1,
                "from_stop": str(stops[0].id),
                "to_stop": str(stops[1].id),
            },
            format="json",
            HTTP_IDEMPOTENCY_KEY="api-notconf",
        )

        assert response.status_code == status.HTTP_409_CONFLICT
        assert response.data["code"] == "not_configured"
        assert "sold out" not in response.data["detail"].lower()


class TestValidation:
    """Boarding a seatless ticket, end to end through the real endpoint."""

    def _staff_client(self, client: object) -> APIClient:
        from apps.identity.serializers import ClientAdminTokenObtainSerializer
        from apps.identity.services import create_default_roles
        from apps.identity.tests.factories import ClientStaffUserFactory

        roles = create_default_roles(client)
        staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
        token = ClientAdminTokenObtainSerializer.get_token(staff)
        api = APIClient()
        api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
        return api

    def _paid_open_seating_booking(self, client, *, passenger_count=1):
        with tenant_context(str(client.id)):
            trip, stops = _open_seating_trip(client)
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                passenger_count=passenger_count,
                from_stop=stops[0],
                to_stop=stops[2],
                idempotency_key=f"paid-{passenger_count}",
            )
        mark_booking_paid(booking=booking)
        with platform_staff_bypass():
            tickets = list(Ticket.all_objects.filter(booking=booking).order_by("passenger_index"))
        return trip, booking, tickets

    def test_boards_a_seatless_ticket_and_reports_a_null_seat(self) -> None:
        client = ClientFactory()
        trip, _booking, tickets = self._paid_open_seating_booking(client)

        response = self._staff_client(client).post(
            reverse("ticket-validate", kwargs={"trip_id": str(trip.id)}),
            {"payload": tickets[0].signed_payload},
            format="json",
            HTTP_IDEMPOTENCY_KEY="validate-open-1",
        )

        assert response.status_code == status.HTTP_200_OK
        assert response.data["status"] == Ticket.Status.BOARDED
        # Null, not blank or invented — nobody was assigned a seat.
        assert response.data["seat_number"] is None
        # The journey still shows: it comes off the Ticket now, not
        # through a seat reservation that does not exist.
        assert response.data["from_stop"]
        assert response.data["to_stop"]

    def test_completes_the_booking_once_every_seatless_ticket_is_boarded(self) -> None:
        """`mark_booking_completed_if_fully_boarded` counts Tickets per
        Booking, so it should need no change for open seating — this
        asserts that rather than assuming it."""
        client = ClientFactory()
        trip, booking, tickets = self._paid_open_seating_booking(client, passenger_count=2)
        api = self._staff_client(client)
        url = reverse("ticket-validate", kwargs={"trip_id": str(trip.id)})

        first = api.post(
            url,
            {"payload": tickets[0].signed_payload},
            format="json",
            HTTP_IDEMPOTENCY_KEY="complete-1",
        )
        assert first.data["booking_status"] == Booking.Status.PAID

        second = api.post(
            url,
            {"payload": tickets[1].signed_payload},
            format="json",
            HTTP_IDEMPOTENCY_KEY="complete-2",
        )
        assert second.data["booking_status"] == Booking.Status.COMPLETED

        with platform_staff_bypass():
            booking.refresh_from_db()
        assert booking.status == Booking.Status.COMPLETED
