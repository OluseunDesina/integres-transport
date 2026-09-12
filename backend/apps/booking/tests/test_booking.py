import datetime
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
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


def test_create_booking_rejects_a_pay_as_you_go_trip() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        trip.fare_collection_mode = Business.FareCollectionMode.PAY_AS_YOU_GO
        trip.save(update_fields=["fare_collection_mode"])

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


def test_bookings_mine_nests_the_trip_class() -> None:
    """docs/specs/15-trip-classes.md slice 3 — my-bookings and the ticket
    screen both name the service a passenger bought.

    Asserts a *non-default* class on purpose: every Trip defaults to
    `standard`, so a hardcoded default would pass a test written against
    one.
    """
    client = ClientFactory()
    trip, passenger, _booking = _one_booking(client)
    with tenant_context(str(client.id)):
        trip.trip_class = Business.TripClass.PREMIUM
        trip.save(update_fields=["trip_class"])

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"][0]["trip"]["trip_class"] == "premium"


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


# --- hold_expires_at / hold_expires_in_seconds (spec 21 slice 2) -----------


def test_bookings_mine_includes_a_live_hold_countdown() -> None:
    client = ClientFactory()
    trip, passenger, booking = _one_booking(client)

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    with tenant_context(str(client.id)):
        reservation = SeatReservation.objects.get(booking=booking)
        held_minutes = trip.business.seat_hold_minutes
    assert row["hold_expires_at"] == reservation.held_until
    # Within a few seconds of the full hold window — real wall-clock time
    # passes between `create_booking` and this assertion, so an exact
    # `held_minutes * 60` would be flaky.
    assert held_minutes * 60 - 5 <= row["hold_expires_in_seconds"] <= held_minutes * 60


def test_hold_expires_is_null_for_an_open_seating_booking() -> None:
    """The one edge case the spec states correctly: open seating holds
    no `SeatReservation` at all (`create_booking`'s own `open_seating`
    branch), so there is nothing to count down from."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client, booking_mode_default=Business.BookingMode.OPEN_SEATING
        )
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=10)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            booking_mode=Business.BookingMode.OPEN_SEATING,
        )
        FareRuleFactory(client=client, route=route, business=business, amount="500.00")
        passenger = PassengerUserFactory(client=client)
        create_booking(
            trip=trip,
            passenger=passenger,
            passenger_count=2,
            from_stop=stop_a,
            to_stop=stop_b,
            idempotency_key="open-seating-hold-null",
        )

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["hold_expires_at"] is None
    assert row["hold_expires_in_seconds"] is None


def test_hold_expires_is_a_real_countdown_for_a_quick_book_booking() -> None:
    """Corrects the spec's own claim that quick-book bookings hold
    nothing, the same way open-seating ones do — they do not.
    `apps.booking.tests.test_quick_book`'s own module docstring already
    states real `SeatReservation` rows are written; this is that fact
    read through the API surface this slice adds."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client,
            booking_mode_default=Business.BookingMode.RESERVATION,
            seat_selection_enabled=False,
        )
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=4)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        for seat_number in ("1A", "1B"):
            SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=seat_number)
        trip = TripFactory(client=client, route=route, business=business, vehicle=vehicle)
        FareRuleFactory(client=client, route=route, business=business, amount="50.00")
        passenger = PassengerUserFactory(client=client)
        create_booking(
            trip=trip,
            passenger=passenger,
            passenger_count=2,
            from_stop=stop_a,
            to_stop=stop_b,
            idempotency_key="quick-book-hold-real",
        )

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["hold_expires_at"] is not None
    assert row["hold_expires_in_seconds"] > 0


def test_hold_expires_is_null_once_the_booking_is_paid() -> None:
    """Payment moves every reservation from HELD to CONFIRMED
    (`apps.booking.services.create_booking`'s own line 466) without
    clearing `held_until` — reading a CONFIRMED row's stale `held_until`
    would resurrect a countdown on an already-paid booking, which the
    spec's own edge case forbids."""
    client = ClientFactory()
    trip, passenger, booking = _one_booking(client)
    with tenant_context(str(client.id)):
        SeatReservation.objects.filter(booking=booking).update(
            status=SeatReservation.Status.CONFIRMED
        )
        booking.status = Booking.Status.PAID
        booking.save(update_fields=["status"])

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["hold_expires_at"] is None
    assert row["hold_expires_in_seconds"] is None


def test_hold_expires_in_seconds_is_floored_at_zero_for_an_expired_but_unswept_hold() -> None:
    """The sweep task (`apps.seating.tasks.expire_seat_holds`) runs once
    a minute, so a HELD reservation can sit past its own `held_until`
    for up to that long. The countdown must read as "expiring now," not
    a negative number, until the sweep actually catches up."""
    client = ClientFactory()
    trip, passenger, booking = _one_booking(client)
    with tenant_context(str(client.id)):
        SeatReservation.objects.filter(booking=booking).update(
            held_until=timezone.now() - datetime.timedelta(seconds=30)
        )

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["hold_expires_at"] is not None
    assert row["hold_expires_in_seconds"] == 0


def test_hold_expires_at_is_the_earliest_of_several_seats() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat_a = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_b = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            seats=[
                {"seat": seat_a, "from_stop": stop_a, "to_stop": stop_b},
                {"seat": seat_b, "from_stop": stop_a, "to_stop": stop_b},
            ],
            idempotency_key="earliest-of-two",
        )
        reservations = list(SeatReservation.objects.filter(booking=booking).order_by("seat_id"))
        earlier = timezone.now() + datetime.timedelta(minutes=1)
        SeatReservation.objects.filter(pk=reservations[0].pk).update(held_until=earlier)

    response = _auth_client(passenger).get(reverse("booking-mine"))

    assert response.status_code == status.HTTP_200_OK
    row = response.data["results"][0]
    assert row["hold_expires_at"] == earlier


def test_hold_expires_fields_are_present_on_the_created_booking_response() -> None:
    """`POST /bookings/` returns a single `BookingSerializer` instance
    with no `reservations_by_booking` context — the fallback per-object
    query path in `_reservations`, exercised here rather than only on
    the list endpoints."""
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
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
        HTTP_IDEMPOTENCY_KEY="post-hold-fields",
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["hold_expires_at"] is not None
    assert response.data["hold_expires_in_seconds"] > 0


# --- ?business= / ?search= on GET /bookings/ ---------------------------
# docs/specs/14-design-system-and-ui-rebuild.md slice 3b. `business` was
# missing entirely, so client-admin's booking list spanned every Business
# under the Client while its header switcher claimed one was active — the
# same gap TripListQuerySerializer already records having had.


def _booking_for(client: object, *, route_name: str, passenger_email: str) -> Booking:
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        trip.route.name = route_name
        trip.route.save(update_fields=["name"])
        passenger = PassengerUserFactory(client=client, email=passenger_email)
        return BookingFactory(
            client=client, trip=trip, business=trip.business, passenger=passenger
        )


def test_booking_list_filters_by_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    create_default_roles(client)
    mine = _booking_for(client, route_name="Ikeja Express", passenger_email="a@example.com")
    _booking_for(client, route_name="Lekki Loop", passenger_email="b@example.com")

    response = _auth_client(staff).get(
        reverse("booking-list-create"), {"business": str(mine.business_id)}
    )

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(mine.id)]


def test_booking_list_rejects_an_unknown_business_query_param() -> None:
    # Silently returning an unfiltered list would be worse than a 400 —
    # the caller would believe it had scoped and had not.
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    create_default_roles(client)

    response = _auth_client(staff).get(
        reverse("booking-list-create"), {"business": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_booking_list_rejects_another_clients_business_query_param() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    create_default_roles(client_a)
    other = _booking_for(client_b, route_name="Ikeja Express", passenger_email="b@example.com")

    response = _auth_client(staff_a).get(
        reverse("booking-list-create"), {"business": str(other.business_id)}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_booking_list_search_matches_route_name_case_insensitively() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    create_default_roles(client)
    match = _booking_for(client, route_name="Ikeja Express", passenger_email="a@example.com")
    _booking_for(client, route_name="Lekki Loop", passenger_email="b@example.com")

    response = _auth_client(staff).get(reverse("booking-list-create"), {"search": "ikeja"})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(match.id)]


def test_booking_list_search_also_matches_passenger_email() -> None:
    # The other half of what a support call actually gives you.
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    create_default_roles(client)
    match = _booking_for(client, route_name="Ikeja Express", passenger_email="ada@example.com")
    _booking_for(client, route_name="Lekki Loop", passenger_email="bola@example.com")

    response = _auth_client(staff).get(reverse("booking-list-create"), {"search": "ada@"})

    assert [row["id"] for row in response.data["results"]] == [str(match.id)]


def test_booking_list_search_with_no_match_returns_empty_not_everything() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    create_default_roles(client)
    _booking_for(client, route_name="Ikeja Express", passenger_email="a@example.com")

    response = _auth_client(staff).get(reverse("booking-list-create"), {"search": "nothing here"})

    assert response.data["count"] == 0


def test_booking_list_blank_search_is_accepted_and_ignored() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    create_default_roles(client)
    _booking_for(client, route_name="Ikeja Express", passenger_email="a@example.com")

    response = _auth_client(staff).get(reverse("booking-list-create"), {"search": ""})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 1


def test_booking_list_search_never_reaches_another_clients_rows() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    create_default_roles(client_a)
    _booking_for(client_b, route_name="Ikeja Express", passenger_email="ada@example.com")

    response = _auth_client(staff_a).get(reverse("booking-list-create"), {"search": "Ikeja"})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 0


# --- reference (docs/specs/18-manifest-and-staff-booking.md slice 1) --------


def test_a_booking_gets_a_quotable_reference() -> None:
    """Until spec 18 a Booking's only identifier was its UUID, so a
    passenger had nothing to read out and the manifest had nothing to
    print."""
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
            idempotency_key="ref-1",
        )

    assert booking.reference.startswith("BKG-")
    # Crockford base32: no I, L, O or U, so nothing is ambiguous when
    # read aloud down a phone. Same alphabet as `Incident.reference`.
    body = booking.reference.removeprefix("BKG-")
    assert len(body) == 6
    assert set(body) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")


def test_two_bookings_in_one_business_get_different_references() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        references = set()
        for index in range(2):
            seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number=f"{index}A")
            booking = create_booking(
                trip=trip,
                passenger=PassengerUserFactory(client=client),
                seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
                idempotency_key=f"ref-uniq-{index}",
            )
            references.add(booking.reference)

    assert len(references) == 2


def test_an_idempotent_replay_returns_the_original_reference() -> None:
    """A retry must not mint a second reference for the same booking —
    the passenger has already been told the first one."""
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        kwargs = {
            "trip": trip,
            "passenger": passenger,
            "seats": [{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            "idempotency_key": "ref-replay",
        }
        first = create_booking(**kwargs)  # type: ignore[arg-type]
        replay = create_booking(**kwargs)  # type: ignore[arg-type]

    assert replay.id == first.id
    assert replay.reference == first.reference


def test_a_reference_collision_is_retried_rather_than_raised(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """The nested `transaction.atomic()` in `_create_booking_row` is what
    makes this survivable: without a savepoint the `IntegrityError`
    poisons the outer transaction and the retry dies on the next
    statement — and, worse, it would surface in `create_booking`'s own
    `except IntegrityError` handler as a bogus idempotency conflict."""
    from .. import services

    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat_one = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        seat_two = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="2A")
        taken = create_booking(
            trip=trip,
            passenger=PassengerUserFactory(client=client),
            seats=[{"seat": seat_one, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="ref-collide-first",
        )

        # The first draw collides with the reference already issued; the
        # second is free.
        draws = iter([taken.reference, "BKG-FREE01"])
        monkeypatch.setattr(services, "_generate_reference", lambda: next(draws))

        second = create_booking(
            trip=trip,
            passenger=PassengerUserFactory(client=client),
            seats=[{"seat": seat_two, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="ref-collide-second",
        )

    assert second.reference == "BKG-FREE01"


def test_the_reference_is_on_the_bookings_list_so_it_can_be_quoted() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="50.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = create_booking(
            trip=trip,
            passenger=PassengerUserFactory(client=client),
            seats=[{"seat": seat, "from_stop": stop_a, "to_stop": stop_b}],
            idempotency_key="ref-list",
        )

    response = _auth_client(staff).get(reverse("booking-list-create"))

    assert response.data["results"][0]["reference"] == booking.reference
