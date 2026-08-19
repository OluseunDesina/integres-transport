from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.fares.services import FareNotConfigured
from apps.fares.tests.factories import FareRuleFactory, FareSegmentRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory
from apps.seating.models import SeatReservation
from apps.seating.services import SeatUnavailable, create_reservation
from apps.seating.tests.factories import SeatFactory
from apps.seating.tests.helpers import fare_pricing_for

from ..models import Booking
from ..services import cancel_booking, create_booking
from .factories import BookingFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _trip_with_two_stops_and_vehicle(client: object, capacity: int = 2):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=capacity)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        trip = TripFactory(client=client, route=route, business=route.business, vehicle=vehicle)
    return trip, stop_a, stop_b, vehicle_type


# --- create_booking (service-level) ----------------------------------------


def test_create_booking_success_prices_from_the_flat_fare_and_holds_the_seat() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="750.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="key-1",
        )
        reservations = list(SeatReservation.objects.filter(booking=booking))

    assert booking.status == Booking.Status.PENDING_PAYMENT
    assert booking.total_amount == Decimal("750.00")
    assert booking.currency == trip.business.currency
    assert len(reservations) == 1
    assert reservations[0].amount == Decimal("750.00")
    assert reservations[0].fare_rule_id is not None
    assert reservations[0].status == SeatReservation.Status.HELD
    entry = AuditLog.objects.get(action="booking.created")
    assert entry.target_id == str(booking.id)


def test_create_booking_sums_the_fare_once_per_seat() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat_1 = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_2 = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[
                {"seat": seat_1, "from_stop": stop_a, "to_stop": stop_b},
                {"seat": seat_2, "from_stop": stop_a, "to_stop": stop_b},
            ],
            idempotency_key="key-2",
        )
    assert booking.total_amount == Decimal("200.00")


def test_create_booking_per_segment_mode_uses_the_matching_segment_rule() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = Business.objects.get(pk=trip.business_id)
        business.fare_pricing_mode = Business.FarePricingMode.PER_SEGMENT
        business.save(update_fields=["fare_pricing_mode"])
        FareSegmentRuleFactory(
            client=client,
            route=trip.route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            amount="300.00",
        )
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        fresh_trip = Trip.objects.get(pk=trip.id)
        booking = create_booking(
            trip=fresh_trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="key-3",
        )
    assert booking.total_amount == Decimal("300.00")


def test_create_booking_raises_fare_not_configured_and_persists_nothing() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        with pytest.raises(FareNotConfigured):
            create_booking(
                trip=trip,
                passenger=passenger,
                seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
                idempotency_key="key-4",
            )
        assert Booking.objects.filter(passenger=passenger).count() == 0
        assert SeatReservation.objects.filter(seat=seat).count() == 0


def test_create_booking_rolls_back_entirely_if_any_requested_seat_is_unavailable() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    passenger_2 = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat_free = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_taken = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        other_booking = BookingFactory(client=client, trip=trip, business=trip.business)
        create_reservation(
            trip=trip,
            seat=seat_taken,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=other_booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )

        with pytest.raises(SeatUnavailable):
            create_booking(
                trip=trip,
                passenger=passenger_2,
                seats=[
                    {"seat": seat_free, "from_stop": stop_a, "to_stop": stop_b},
                    {"seat": seat_taken, "from_stop": stop_a, "to_stop": stop_b},
                ],
                idempotency_key="key-5",
            )

        assert Booking.objects.filter(passenger=passenger_2).count() == 0
        assert SeatReservation.objects.filter(seat=seat_free).count() == 0


def test_create_booking_replay_with_the_same_key_and_body_returns_the_original() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        seats = [{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}]
        first = create_booking(
            trip=trip, passenger=passenger, seats=seats, idempotency_key="replay-key"
        )
        second = create_booking(
            trip=trip, passenger=passenger, seats=seats, idempotency_key="replay-key"
        )
        assert first.id == second.id
        assert Booking.objects.filter(passenger=passenger).count() == 1


def test_create_booking_raises_conflict_when_the_same_key_is_reused_for_a_different_request() -> (
    None
):
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat_1 = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_2 = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat_1, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="dupe-key",
        )
        with pytest.raises(IdempotencyKeyConflict):
            create_booking(
                trip=trip,
                passenger=passenger,
                seats=[{"seat": seat_2, "from_stop": stop_a, "to_stop": stop_b}],
                idempotency_key="dupe-key",
            )


# --- cancel_booking (service-level) ----------------------------------------


def test_cancel_booking_releases_held_reservations_and_records_the_reason() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="cancel-key",
        )
        updated = cancel_booking(booking=booking, cancelled_by=passenger, reason="Changed mind")
        reservation = SeatReservation.objects.get(booking=booking)

    assert updated.status == Booking.Status.CANCELLED
    assert updated.cancellation_reason == "Changed mind"
    assert reservation.status == SeatReservation.Status.RELEASED
    entry = AuditLog.objects.get(action="booking.cancelled")
    assert entry.metadata["reason"] == "Changed mind"


def test_cancel_booking_is_a_no_op_once_already_moved_on_from_pending_payment() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="noop-key",
        )
        booking.status = Booking.Status.EXPIRED
        booking.save(update_fields=["status"])
        before = AuditLog.objects.filter(action="booking.cancelled").count()

        updated = cancel_booking(booking=booking, cancelled_by=passenger, reason="too late")

    assert updated.status == Booking.Status.EXPIRED
    assert AuditLog.objects.filter(action="booking.cancelled").count() == before


# --- POST /bookings/ endpoint ------------------------------------------


def test_passenger_can_create_a_booking() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="750.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-1",
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["status"] == Booking.Status.PENDING_PAYMENT
    assert response.data["total_amount"] == "750.00"
    assert response.data["currency"] == trip.business.currency
    assert len(response.data["seats"]) == 1
    assert response.data["seats"][0]["amount"] == "750.00"
    assert response.data["seats"][0]["seat"] == "1A"


def test_create_booking_requires_the_idempotency_key_header() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_create_booking_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)

    response = APIClient().post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-2",
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_create_booking_rejects_a_tap_and_go_trip() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        trip.booking_mode = Business.BookingMode.TAP_AND_GO
        trip.save(update_fields=["booking_mode"])

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-3",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_create_booking_rejects_a_non_scheduled_trip() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        trip.status = Trip.Status.CANCELLED
        trip.save(update_fields=["status"])

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-4",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_create_booking_rejects_a_seat_from_a_different_vehicle_type() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, _vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        foreign_seat = SeatFactory(
            client=client, vehicle_type=VehicleTypeFactory(client=client, capacity=1)
        )

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {
                    "seat": str(foreign_seat.id),
                    "from_stop": str(stop_a.id),
                    "to_stop": str(stop_b.id),
                }
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-5",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_create_booking_returns_404_when_no_fare_is_configured() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-6",
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_create_booking_returns_409_when_the_seat_is_already_held() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        other_booking = BookingFactory(client=client, trip=trip, business=trip.business)
        create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=other_booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )

    response = _auth_client(passenger).post(
        reverse("booking-list-create"),
        {
            "trip": str(trip.id),
            "seats": [
                {"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}
            ],
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="endpoint-key-7",
    )
    assert response.status_code == status.HTTP_409_CONFLICT


def test_create_booking_replay_at_the_endpoint_does_not_create_a_second_booking() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="100.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)

    body = {
        "trip": str(trip.id),
        "seats": [{"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}],
    }
    api = _auth_client(passenger)
    first = api.post(
        reverse("booking-list-create"), body, format="json", HTTP_IDEMPOTENCY_KEY="endpoint-replay"
    )
    second = api.post(
        reverse("booking-list-create"), body, format="json", HTTP_IDEMPOTENCY_KEY="endpoint-replay"
    )

    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_201_CREATED
    assert first.data["id"] == second.data["id"]
    with tenant_context(str(client.id)):
        assert Booking.objects.filter(passenger=passenger).count() == 1


# --- GET /bookings/ endpoint (staff) ----------------------------------------


def test_booking_list_requires_the_booking_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("booking-list-create"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_staff_with_booking_view_can_list_bookings_filtered_by_trip_and_status() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    other_trip, other_a, other_b, other_vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        FareRuleFactory(
            client=client, route=other_trip.route, business=other_trip.business, amount="50.00"
        )
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        other_seat = SeatFactory(client=client, vehicle_type=other_vehicle_type)
        matching = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="list-key-1",
        )
        create_booking(
            trip=other_trip,
            passenger=passenger,
            seats=[{"seat": other_seat, "from_stop": other_a, "to_stop": other_b}],
            idempotency_key="list-key-2",
        )

    response = _auth_client(staff).get(reverse("booking-list-create"), {"trip": str(trip.id)})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(matching.id)]


def test_booking_list_query_count_does_not_scale_with_booking_count(
    django_assert_max_num_queries,
) -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=5)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        for index in range(5):
            seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=f"{index}A")
            passenger = PassengerUserFactory(client=client)
            create_booking(
                trip=trip,
                passenger=passenger,
                seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
                idempotency_key=f"query-count-{index}",
            )

    with django_assert_max_num_queries(12):
        response = _auth_client(staff).get(reverse("booking-list-create"))
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5


# --- GET /bookings/mine/ endpoint --------------------------------------


def test_bookings_mine_lists_only_the_callers_own_bookings() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    passenger_a = PassengerUserFactory(client=client)
    passenger_b = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat_a = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_b = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        own_booking = create_booking(
            trip=trip,
            passenger=passenger_a,
            seats=[{"seat": seat_a, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="mine-key-1",
        )
        create_booking(
            trip=trip,
            passenger=passenger_b,
            seats=[{"seat": seat_b, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="mine-key-2",
        )

    response = _auth_client(passenger_a).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(own_booking.id)]


# --- POST /bookings/{id}/cancel/ endpoint -------------------------------


def test_passenger_can_cancel_their_own_pending_booking() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="cancel-endpoint-1",
        )

    response = _auth_client(passenger).post(
        reverse("booking-cancel", kwargs={"pk": str(booking.id)}), {"reason": "No longer needed"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == Booking.Status.CANCELLED
    assert response.data["cancellation_reason"] == "No longer needed"


def test_cancelling_someone_elses_booking_is_forbidden() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    owner = PassengerUserFactory(client=client)
    other = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=owner,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="cancel-endpoint-2",
        )

    response = _auth_client(other).post(reverse("booking-cancel", kwargs={"pk": str(booking.id)}))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_cancelling_an_already_cancelled_booking_is_rejected() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="cancel-endpoint-3",
        )

    api = _auth_client(passenger)
    first = api.post(reverse("booking-cancel", kwargs={"pk": str(booking.id)}))
    second = api.post(reverse("booking-cancel", kwargs={"pk": str(booking.id)}))

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_400_BAD_REQUEST


def test_cancel_booking_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="cancel-endpoint-4",
        )

    response = APIClient().post(reverse("booking-cancel", kwargs={"pk": str(booking.id)}))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_cancel_booking_404s_for_another_clients_booking() -> None:
    client_a = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    client_b = ClientFactory()
    trip_b, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client_b)
    passenger_b = PassengerUserFactory(client=client_b)
    with tenant_context(str(client_b.id)):
        FareRuleFactory(
            client=client_b, route=trip_b.route, business=trip_b.business, amount="50.00"
        )
        seat = SeatFactory(client=client_b, vehicle_type=vehicle_type)
        booking_b = create_booking(
            trip=trip_b,
            passenger=passenger_b,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="cross-client-cancel",
        )

    response = _auth_client(passenger_a).post(
        reverse("booking-cancel", kwargs={"pk": str(booking_b.id)})
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- BookingSerializer.trip nesting -------------------------------------
# docs/specs/4-fares-seating-booking-frontend.md §3.4 — my-bookings and the
# client-admin bookings list both render a route name and departure time,
# which a bare trip FK id can't supply.


def _one_booking(client: object):  # type: ignore[no-untyped-def]
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="nesting-key",
        )
    return trip, passenger, booking


def test_bookings_mine_nests_the_trip_with_its_route_and_departure() -> None:
    client = ClientFactory()
    trip, passenger, booking = _one_booking(client)

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["id"] == str(booking.id)
    assert row["trip"]["id"] == trip.id
    assert row["trip"]["route"] == {"id": trip.route_id, "name": trip.route.name}
    assert row["trip"]["scheduled_departure_at"] == trip.scheduled_departure_at
    assert row["trip"]["service_date"] == trip.service_date


def test_staff_booking_list_nests_the_trip_too() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, _passenger, booking = _one_booking(client)

    response = _auth_client(staff).get(reverse("booking-list-create"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["id"] == str(booking.id)
    assert row["trip"]["route"] == {"id": trip.route_id, "name": trip.route.name}


def test_bookings_mine_query_count_does_not_scale_with_booking_count(
    django_assert_max_num_queries,  # type: ignore[no-untyped-def]
) -> None:
    """The nested trip.route must come from select_related("trip__route"),
    not one extra query per row."""
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=5)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        for index in range(5):
            seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=f"1{index}")
            create_booking(
                trip=trip,
                passenger=passenger,
                seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
                idempotency_key=f"mine-count-{index}",
            )

    with django_assert_max_num_queries(12):
        response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5
