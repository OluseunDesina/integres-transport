import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.tests.factories import BookingFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..models import Seat, SeatReservation
from ..services import (
    SeatsInUse,
    SeatUnavailable,
    create_reservation,
    generate_seat_layout,
    get_availability,
    replace_vehicle_type_seats,
)
from .factories import SeatFactory
from .helpers import fare_pricing_for

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


def _booking(client: object, **overrides: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return BookingFactory(client=client, **overrides)


# --- get_availability / create_reservation (service-level) ---------------


def test_get_availability_is_empty_when_trip_has_no_vehicle_assigned() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(client=client, route=route, business=route.business)
        availability = get_availability(trip=trip, from_stop=stop_a, to_stop=stop_b)
    assert availability == []


def test_get_availability_marks_a_held_seat_unavailable_and_others_available() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    with tenant_context(str(client.id)):
        held_seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        free_seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        create_reservation(
            trip=trip,
            seat=held_seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )
        availability = {
            row["seat"].id: row["is_available"]
            for row in get_availability(trip=trip, from_stop=stop_a, to_stop=stop_b)
        }
    assert availability[held_seat.id] is False
    assert availability[free_seat.id] is True


def test_get_availability_treats_a_confirmed_reservation_as_unavailable_too() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        reservation = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )
        reservation.status = SeatReservation.Status.CONFIRMED
        reservation.save(update_fields=["status"])
        availability = get_availability(trip=trip, from_stop=stop_a, to_stop=stop_b)
    assert availability[0]["is_available"] is False


def test_get_availability_ignores_expired_and_released_reservations() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        reservation = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )
        reservation.status = SeatReservation.Status.EXPIRED
        reservation.save(update_fields=["status"])
        availability = get_availability(trip=trip, from_stop=stop_a, to_stop=stop_b)
    assert availability[0]["is_available"] is True


def test_create_reservation_raises_seat_unavailable_for_an_overlapping_segment() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking_1 = BookingFactory(client=client, trip=trip, business=trip.business)
        booking_2 = BookingFactory(client=client, trip=trip, business=trip.business)
        create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking_1,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )
        with pytest.raises(SeatUnavailable):
            create_reservation(
                trip=trip,
                seat=seat,
                from_stop=stop_a,
                to_stop=stop_b,
                booking=booking_2,
                hold_minutes=15,
                **fare_pricing_for(client=client, route=trip.route, business=trip.business),
            )


def test_create_reservation_rejects_stops_not_on_the_route() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        foreign_stop = StopFactory(client=client, business=trip.business)
        with pytest.raises(ValueError, match="Both stops must be on the route"):
            create_reservation(
                trip=trip,
                seat=seat,
                from_stop=foreign_stop,
                to_stop=stop_b,
                booking=booking,
                hold_minutes=15,
                **fare_pricing_for(client=client, route=trip.route, business=trip.business),
            )


def test_create_reservation_sets_held_until_from_hold_minutes() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type)
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        reservation = create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=trip.business.seat_hold_minutes,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )
    assert reservation.status == SeatReservation.Status.HELD
    assert reservation.held_until is not None


# --- VehicleTypeSeatsView endpoint -----------------------------------------


def test_client_staff_can_replace_a_vehicle_types_seats() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=3)

    response = _auth_client(staff).put(
        reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)}),
        {"seats": [{"seat_number": "1A", "row": 1, "column": 1}, {"seat_number": "1B"}]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert [row["seat_number"] for row in response.data] == ["1A", "1B"]
    assert [row["row"] for row in response.data] == [1, None]
    entry = AuditLog.objects.get(action="vehicle_type.seats_updated")
    assert entry.client_id == client.id


def test_replacing_seats_rejects_duplicates() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=3)

    response = _auth_client(staff).put(
        reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)}),
        {"seats": [{"seat_number": "1A"}, {"seat_number": "1A"}]},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_replacing_seats_rejects_exceeding_capacity() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=1)

    response = _auth_client(staff).put(
        reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)}),
        {"seats": [{"seat_number": "1A"}, {"seat_number": "1B"}]},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_replacing_seats_replaces_the_previous_set_not_appends() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=3)
        SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="OLD")

    response = _auth_client(staff).put(
        reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)}),
        {"seats": [{"seat_number": "1A"}]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        remaining = list(Seat.objects.filter(vehicle_type=vehicle_type))
    assert [seat.seat_number for seat in remaining] == ["1A"]


def test_replace_vehicle_type_seats_works_under_platform_staff_bypass() -> None:
    """Regression test for a manager-targeting bug: `Seat.objects.filter(...).delete()`
    silently matches zero rows under `apps.core.rls.platform_staff_bypass()`
    (no Python tenancy contextvar set — the bypass only changes Postgres
    GUCs), the exact failure `apps.network.services.set_route_stops` was
    already fixed for. This function mirrored that hard-delete-and-recreate
    shape but not the `all_objects` fix, so a caller with no request-scoped
    tenancy context (a management command, e.g. seed_e2e_users) would
    silently end up with both the old and new seats present instead of a
    clean replace. Calls the service function directly under a bypass,
    with no `tenant_context` active, the way such a caller actually would."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=3)
        SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="OLD")

    with platform_staff_bypass():
        replace_vehicle_type_seats(
            vehicle_type=vehicle_type,
            seats=[{"seat_number": "1A", "row": None, "column": None}],
            updated_by=staff,
        )

    with tenant_context(str(client.id)):
        remaining = list(Seat.objects.filter(vehicle_type=vehicle_type))
    assert [seat.seat_number for seat in remaining] == ["1A"]


def test_staff_role_user_can_list_but_not_replace_seats() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=3)

    api = _auth_client(staff_role_user)
    list_response = api.get(reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)}))
    put_response = api.put(
        reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)}),
        {"seats": [{"seat_number": "1A"}]},
        format="json",
    )

    assert list_response.status_code == status.HTTP_200_OK
    assert put_response.status_code == status.HTTP_403_FORBIDDEN


def test_passenger_cannot_list_seats() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client)

    response = _auth_client(passenger).get(
        reverse("vehicle-type-seats", kwargs={"pk": str(vehicle_type.id)})
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


# --- generate_seat_layout() (service-level) --------------------------------


def test_generate_seat_layout_computes_row_letter_numbering_with_no_aisle() -> None:
    layout = generate_seat_layout(
        rows=2, columns=3, aisle_after_column=None, numbering_scheme="row_letter"
    )
    assert layout == [
        {"seat_number": "1A", "row": 1, "column": 1},
        {"seat_number": "1B", "row": 1, "column": 2},
        {"seat_number": "1C", "row": 1, "column": 3},
        {"seat_number": "2A", "row": 2, "column": 1},
        {"seat_number": "2B", "row": 2, "column": 2},
        {"seat_number": "2C", "row": 2, "column": 3},
    ]


def test_generate_seat_layout_with_an_aisle_creates_a_column_gap_but_removes_no_seat() -> None:
    """aisle_after_column models a real physical aisle: the stored
    `column` integer jumps by 2 across it (so a renderer can detect
    where to draw the gap), but the row's real seat count is unchanged
    (docs/specs/8-seat-map-generation.md) — still `rows * columns`
    seats, still contiguous A/B/C/D seat numbers."""
    layout = generate_seat_layout(
        rows=1, columns=4, aisle_after_column=2, numbering_scheme="row_letter"
    )
    assert [seat["seat_number"] for seat in layout] == ["1A", "1B", "1C", "1D"]
    assert [seat["column"] for seat in layout] == [1, 2, 4, 5]
    assert len(layout) == 4


# --- VehicleTypeSeatsGenerateView endpoint ----------------------------------


def test_generate_endpoint_creates_seats_with_row_and_column() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=6)

    response = _auth_client(staff).post(
        reverse("vehicle-type-seats-generate", kwargs={"pk": str(vehicle_type.id)}),
        {"rows": 2, "columns": 3},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert [row["seat_number"] for row in response.data] == [
        "1A",
        "1B",
        "1C",
        "2A",
        "2B",
        "2C",
    ]
    assert [row["row"] for row in response.data] == [1, 1, 1, 2, 2, 2]
    entry = AuditLog.objects.get(action="vehicle_type.seats_updated")
    assert entry.client_id == client.id


def test_generate_endpoint_rejects_capacity_exceeded() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=4)

    response = _auth_client(staff).post(
        reverse("vehicle-type-seats-generate", kwargs={"pk": str(vehicle_type.id)}),
        {"rows": 2, "columns": 3},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_generate_endpoint_rejects_an_aisle_at_or_past_the_last_column() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=8)

    response = _auth_client(staff).post(
        reverse("vehicle-type-seats-generate", kwargs={"pk": str(vehicle_type.id)}),
        {"rows": 2, "columns": 4, "aisle_after_column": 4},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_generate_endpoint_requires_seating_manage_permission() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    with tenant_context(str(client.id)):
        vehicle_type = VehicleTypeFactory(client=client, capacity=4)

    response = _auth_client(staff_role_user).post(
        reverse("vehicle-type-seats-generate", kwargs={"pk": str(vehicle_type.id)}),
        {"rows": 2, "columns": 2},
        format="json",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_regenerating_seats_with_active_reservations_returns_409_not_500() -> None:
    """Regression test for the real, previously-unhandled bug this spec
    fixes: `Seat.all_objects.filter(...).delete()` raised a raw
    `ProtectedError` (surfacing as a 500) when a Seat being replaced
    still had a `SeatReservation` against it
    (docs/specs/8-seat-map-generation.md's "Edge cases" §1)."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=2)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )

    response = _auth_client(staff).post(
        reverse("vehicle-type-seats-generate", kwargs={"pk": str(vehicle_type.id)}),
        {"rows": 1, "columns": 2},
        format="json",
    )

    assert response.status_code == status.HTTP_409_CONFLICT
    assert "1 seat(s)" in response.data["detail"]
    with tenant_context(str(client.id)):
        remaining = list(Seat.objects.filter(vehicle_type=vehicle_type))
    assert [remaining_seat.seat_number for remaining_seat in remaining] == ["1A"]


def test_replace_vehicle_type_seats_raises_seats_in_use_at_the_service_layer() -> None:
    """Same regression as above, called directly at the service layer —
    proves the SeatsInUse contract independent of the view's exception
    mapping."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        booking = BookingFactory(client=client, trip=trip, business=trip.business)
        create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=15,
            **fare_pricing_for(client=client, route=trip.route, business=trip.business),
        )

        with pytest.raises(SeatsInUse):
            replace_vehicle_type_seats(
                vehicle_type=vehicle_type,
                seats=[{"seat_number": "1B", "row": None, "column": None}],
                updated_by=staff,
            )


# --- TripAvailabilityView endpoint -----------------------------------------


def test_trip_availability_endpoint_returns_seats_with_availability() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    trip, stop_a, stop_b, vehicle_type = _trip_with_two_stops_and_vehicle(client, capacity=1)
    with tenant_context(str(client.id)):
        SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")

    response = _auth_client(passenger).get(
        reverse("trip-availability", kwargs={"pk": str(trip.id)}),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )

    assert response.status_code == status.HTTP_200_OK
    # An envelope, not a bare array, as of docs/specs/10-booking-modes.md
    # — the array could not say *why* it was empty.
    assert response.data["booking_mode"] == "reservation"
    assert response.data["status"] == "open"
    assert response.data["capacity_remaining"] is None
    assert len(response.data["seats"]) == 1
    assert response.data["seats"][0]["seat"]["seat_number"] == "1A"
    assert response.data["seats"][0]["is_available"] is True


def test_trip_availability_endpoint_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    trip, stop_a, stop_b, _vehicle_type = _trip_with_two_stops_and_vehicle(client)

    response = APIClient().get(
        reverse("trip-availability", kwargs={"pk": str(trip.id)}),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_trip_availability_endpoint_404s_for_another_clients_trip() -> None:
    client_a = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    client_b = ClientFactory()
    trip_b, stop_a, stop_b, _vehicle_type = _trip_with_two_stops_and_vehicle(client_b)

    response = _auth_client(passenger_a).get(
        reverse("trip-availability", kwargs={"pk": str(trip_b.id)}),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND
