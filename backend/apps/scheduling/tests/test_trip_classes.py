"""Trip classes through scheduling — docs/specs/15-trip-classes.md.

Three rules live here, all enforced in `services` rather than only in a
serializer: the Route allow-list, immutability once sold, and the
vehicle-class match at assignment.
"""

import datetime

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking
from apps.booking.tests.factories import BookingFactory
from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.network.tests.factories import RouteFactory

from ..models import Schedule, Trip
from ..services import (
    TripClassLocked,
    TripClassNotAvailableOnRoute,
    VehicleClassMismatch,
    assign_trip_resources,
    create_manual_trip,
    set_trip_class,
)
from ..tasks import generate_trips_for_schedule
from .factories import ScheduleFactory, TripFactory

pytestmark = pytest.mark.django_db

PREMIUM = Business.TripClass.PREMIUM
STANDARD = Business.TripClass.STANDARD
MINI = Business.TripClass.MINI


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


# --- Defaults ------------------------------------------------------------


def test_everything_defaults_to_standard() -> None:
    """The class every pre-existing row backfilled to, which is what
    makes the migration behaviour-preserving. If a default drifts, every
    already-configured operator silently changes what they are selling.
    """
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        schedule = ScheduleFactory(client=client, route=route)
        trip = TripFactory(client=client, route=route)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business)

    assert schedule.trip_class == STANDARD
    assert trip.trip_class == STANDARD
    assert vehicle_type.trip_class == STANDARD
    assert route.available_trip_classes == []


# --- Snapshot ------------------------------------------------------------


def test_generated_trips_take_their_class_from_the_schedule() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        schedule = ScheduleFactory(
            client=client,
            route=route,
            trip_class=PREMIUM,
            days_of_week=[1, 2, 3, 4, 5, 6, 7],
            effective_from=datetime.date(2020, 1, 1),
        )
        created = generate_trips_for_schedule(schedule, horizon_days=1)

    assert created
    assert all(trip.trip_class == PREMIUM for trip in created)


def test_editing_a_schedules_class_does_not_retro_change_generated_trips() -> None:
    """Snapshot semantics, the same as booking_mode. A departure already
    generated — and possibly already sold — must not silently become a
    different class of service because a future plan changed."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        schedule = ScheduleFactory(
            client=client,
            route=route,
            trip_class=PREMIUM,
            days_of_week=[1, 2, 3, 4, 5, 6, 7],
            effective_from=datetime.date(2020, 1, 1),
        )
        created = generate_trips_for_schedule(schedule, horizon_days=0)
        schedule.trip_class = MINI
        schedule.save(update_fields=["trip_class"])
        refreshed = Trip.objects.get(pk=created[0].pk)

    assert refreshed.trip_class == PREMIUM


# --- Route allow-list ----------------------------------------------------


def test_an_empty_allow_list_permits_any_class() -> None:
    """`[]` means no restriction, not "nothing allowed" — the reading
    that keeps every Route predating spec 15 working."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, available_trip_classes=[])
        trip = create_manual_trip(
            route=route,
            service_date=datetime.date(2026, 12, 1),
            departure_time=datetime.time(7, 0),
            vehicle=None,
            driver=None,
            created_by=staff,
            trip_class=PREMIUM,
        )

    assert trip.trip_class == PREMIUM


def test_a_class_outside_the_allow_list_is_refused() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, available_trip_classes=[STANDARD])
        with pytest.raises(TripClassNotAvailableOnRoute):
            create_manual_trip(
                route=route,
                service_date=datetime.date(2026, 12, 1),
                departure_time=datetime.time(7, 0),
                vehicle=None,
                driver=None,
                created_by=staff,
                trip_class=PREMIUM,
            )


def test_creating_a_schedule_outside_the_allow_list_is_a_400() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, available_trip_classes=[STANDARD])

    response = _auth_client(staff).post(
        reverse("schedule-list-create"),
        {
            "route": str(route.id),
            "days_of_week": [1],
            "departure_time": "07:30:00",
            "effective_from": "2026-01-01",
            "trip_class": PREMIUM,
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "trip_class" in response.data


def test_narrowing_the_allow_list_leaves_existing_schedules_alone() -> None:
    """Narrowing a plan must not silently invalidate services already
    running. The Schedule keeps its class and keeps generating."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, available_trip_classes=[STANDARD, PREMIUM])
        schedule = ScheduleFactory(client=client, route=route, trip_class=PREMIUM)
        route.available_trip_classes = [STANDARD]
        route.save(update_fields=["available_trip_classes"])
        refreshed = Schedule.objects.get(pk=schedule.pk)

    assert refreshed.trip_class == PREMIUM


# --- Immutability once sold ---------------------------------------------


def test_class_can_be_changed_while_nothing_is_sold() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=STANDARD)
        updated = set_trip_class(trip=trip, trip_class=PREMIUM, updated_by=staff)

    assert updated.trip_class == PREMIUM
    assert AuditLog.objects.filter(action="trip.class_changed").exists()


def test_a_pending_payment_booking_locks_the_class() -> None:
    """A held seat is a live offer at a quoted price — the price was
    snapshotted against a rule for the *old* class, so moving the class
    would leave the booking unexplainable by any rule still findable."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=STANDARD)
        BookingFactory(
            client=client, trip=trip, business=trip.business, status=Booking.Status.PENDING_PAYMENT
        )
        with pytest.raises(TripClassLocked):
            set_trip_class(trip=trip, trip_class=PREMIUM, updated_by=staff)


def test_a_paid_booking_locks_the_class() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=STANDARD)
        BookingFactory(client=client, trip=trip, business=trip.business, status=Booking.Status.PAID)
        with pytest.raises(TripClassLocked):
            set_trip_class(trip=trip, trip_class=PREMIUM, updated_by=staff)


def test_only_cancelled_bookings_leave_the_class_free() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=STANDARD)
        BookingFactory(
            client=client, trip=trip, business=trip.business, status=Booking.Status.CANCELLED
        )
        BookingFactory(
            client=client, trip=trip, business=trip.business, status=Booking.Status.EXPIRED
        )
        updated = set_trip_class(trip=trip, trip_class=PREMIUM, updated_by=staff)

    assert updated.trip_class == PREMIUM


def test_resending_the_class_a_sold_trip_already_has_is_a_no_op() -> None:
    """Idempotent, matching transition_trip_status's handling of a
    request to the current status. Rejecting this would make a harmless
    retry look like an error."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=PREMIUM)
        BookingFactory(client=client, trip=trip, business=trip.business, status=Booking.Status.PAID)
        updated = set_trip_class(trip=trip, trip_class=PREMIUM, updated_by=staff)

    assert updated.trip_class == PREMIUM
    assert not AuditLog.objects.filter(action="trip.class_changed").exists()


def test_the_class_endpoint_returns_409_when_sold() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=STANDARD)
        BookingFactory(client=client, trip=trip, business=trip.business, status=Booking.Status.PAID)

    response = _auth_client(staff).post(
        reverse("trip-class", kwargs={"pk": str(trip.id)}), {"trip_class": PREMIUM}
    )

    assert response.status_code == status.HTTP_409_CONFLICT


def test_the_class_endpoint_updates_an_unsold_trip() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, trip_class=STANDARD)

    response = _auth_client(staff).post(
        reverse("trip-class", kwargs={"pk": str(trip.id)}), {"trip_class": PREMIUM}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["trip_class"] == PREMIUM


# --- Vehicle class match ------------------------------------------------


def _trip_and_vehicles(trip_class: str = PREMIUM):  # type: ignore[no-untyped-def]
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        trip = TripFactory(client=client, route=route, trip_class=trip_class)
        premium_type = VehicleTypeFactory(
            client=client, business=route.business, trip_class=PREMIUM
        )
        mini_type = VehicleTypeFactory(client=client, business=route.business, trip_class=MINI)
        premium_vehicle = VehicleFactory(
            client=client, business=route.business, vehicle_type=premium_type
        )
        mini_vehicle = VehicleFactory(
            client=client, business=route.business, vehicle_type=mini_type
        )
    return client, trip, premium_vehicle, mini_vehicle


def test_assigning_a_matching_class_vehicle_is_allowed() -> None:
    client, trip, premium_vehicle, _mini = _trip_and_vehicles()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        updated = assign_trip_resources(
            trip=trip, vehicle=premium_vehicle, driver=None, updated_by=staff
        )

    assert updated.vehicle_id == premium_vehicle.id


def test_assigning_a_mismatched_class_vehicle_is_refused() -> None:
    """Selling Premium and running a Mini is a refund event, and this
    system has no refund service — spec 10's `trip.oversold` already
    showed that an audit record nobody can act on is not a control."""
    client, trip, _premium, mini_vehicle = _trip_and_vehicles()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)), pytest.raises(VehicleClassMismatch):
        assign_trip_resources(trip=trip, vehicle=mini_vehicle, driver=None, updated_by=staff)


def test_the_mismatch_message_names_both_classes() -> None:
    client, trip, _premium, mini_vehicle = _trip_and_vehicles()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)), pytest.raises(VehicleClassMismatch) as exc:
        assign_trip_resources(trip=trip, vehicle=mini_vehicle, driver=None, updated_by=staff)

    assert PREMIUM in str(exc.value)
    assert MINI in str(exc.value)


def test_unassigning_a_vehicle_is_always_allowed() -> None:
    """The class belongs to the Trip, not to whatever is currently
    running it, so removing the vehicle can never conflict."""
    client, trip, premium_vehicle, _mini = _trip_and_vehicles()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        assign_trip_resources(trip=trip, vehicle=premium_vehicle, driver=None, updated_by=staff)
        updated = assign_trip_resources(trip=trip, vehicle=None, driver=None, updated_by=staff)

    assert updated.vehicle_id is None


def test_the_assignment_endpoint_rejects_a_mismatched_vehicle() -> None:
    client, trip, _premium, mini_vehicle = _trip_and_vehicles()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("trip-assignment-update", kwargs={"pk": str(trip.id)}),
        {"vehicle": str(mini_vehicle.id)},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "vehicle" in response.data


def test_changing_class_is_refused_while_a_vehicle_of_the_old_class_is_assigned() -> None:
    """set_trip_class re-checks the vehicle, so this path cannot reach a
    state create_manual_trip would have refused."""
    client, trip, premium_vehicle, _mini = _trip_and_vehicles()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        assign_trip_resources(trip=trip, vehicle=premium_vehicle, driver=None, updated_by=staff)
        with pytest.raises(VehicleClassMismatch):
            set_trip_class(trip=trip, trip_class=MINI, updated_by=staff)


# --- Filtering -----------------------------------------------------------


def test_trip_list_filters_by_class() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        TripFactory(client=client, route=route, trip_class=PREMIUM)
        TripFactory(client=client, route=route, trip_class=STANDARD)

    response = _auth_client(staff).get(reverse("trip-list-create"), {"trip_class": PREMIUM})

    assert response.status_code == status.HTTP_200_OK
    assert [row["trip_class"] for row in response.data["results"]] == [PREMIUM]
