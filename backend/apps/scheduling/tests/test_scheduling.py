import datetime

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.fleet.tests.factories import DriverFactory, VehicleFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory

from ..models import Schedule, Trip
from .factories import ScheduleFactory, TripFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _route(client: object, **overrides: object) -> object:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return RouteFactory(client=client, **overrides)


def _schedule(client: object, **overrides: object) -> Schedule:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return ScheduleFactory(client=client, **overrides)


def _trip(client: object, **overrides: object) -> Trip:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return TripFactory(client=client, **overrides)


# --- Schedule --------------------------------------------------------------


def test_client_staff_can_create_a_schedule_for_a_route() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)

    response = _auth_client(staff).post(
        reverse("schedule-list-create"),
        {
            "route": str(route.id),
            "days_of_week": [3, 1, 2],
            "departure_time": "07:30:00",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["days_of_week"] == [1, 2, 3]
    assert str(response.data["business"]) == str(route.business_id)
    entry = AuditLog.objects.get(action="schedule.created")
    assert entry.client_id == client.id


def test_staff_role_user_can_list_but_not_create_schedules() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    route = _route(client)

    api = _auth_client(staff_role_user)
    list_response = api.get(reverse("schedule-list-create"))
    create_response = api.post(
        reverse("schedule-list-create"),
        {
            "route": str(route.id),
            "days_of_week": [1],
            "departure_time": "07:30:00",
            "effective_from": "2026-01-01",
        },
    )

    assert list_response.status_code == status.HTTP_200_OK
    assert create_response.status_code == status.HTTP_403_FORBIDDEN


def test_passenger_cannot_list_schedules() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("schedule-list-create"))

    assert response.status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.parametrize(
    "days_of_week",
    [[], [1, 1, 2], [0, 1], [1, 8]],
)
def test_schedule_creation_rejects_invalid_days_of_week(days_of_week: list[int]) -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)

    response = _auth_client(staff).post(
        reverse("schedule-list-create"),
        {
            "route": str(route.id),
            "days_of_week": days_of_week,
            "departure_time": "07:30:00",
            "effective_from": "2026-01-01",
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_cross_client_schedule_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    schedule_b = _schedule(client_b)

    response = _auth_client(staff_a).patch(
        reverse("schedule-update", kwargs={"pk": str(schedule_b.id)}), {"is_active": False}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_schedule_list_rejects_unknown_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).get(
        reverse("schedule-list-create"), {"business": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_deactivating_a_schedule_cancels_its_future_scheduled_trips() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    schedule = _schedule(client, effective_from=datetime.date(2020, 1, 1))
    future_trip = _trip(
        client,
        schedule=schedule,
        route=schedule.route,
        business=schedule.business,
        service_date=datetime.date(2099, 1, 5),
        status=Trip.Status.SCHEDULED,
    )
    in_progress_trip = _trip(
        client,
        schedule=schedule,
        route=schedule.route,
        business=schedule.business,
        service_date=datetime.date(2099, 1, 6),
        status=Trip.Status.IN_PROGRESS,
    )

    response = _auth_client(staff).patch(
        reverse("schedule-update", kwargs={"pk": str(schedule.id)}), {"is_active": False}
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        future_trip.refresh_from_db()
        in_progress_trip.refresh_from_db()
    assert future_trip.status == Trip.Status.CANCELLED
    assert future_trip.cancellation_reason == "Schedule deactivated"
    assert in_progress_trip.status == Trip.Status.IN_PROGRESS


# --- Trip: manual creation ---------------------------------------------------


def test_client_staff_can_create_a_manual_trip() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)

    response = _auth_client(staff).post(
        reverse("trip-list-create"),
        {
            "route": str(route.id),
            "service_date": "2026-09-01",
            "departure_time": "08:00:00",
        },
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["schedule"] is None
    assert response.data["status"] == "scheduled"
    entry = AuditLog.objects.get(action="trip.created")
    assert entry.client_id == client.id


def test_manual_trip_creation_ignores_a_schedule_field_in_the_body() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    other_schedule = _schedule(client)

    response = _auth_client(staff).post(
        reverse("trip-list-create"),
        {
            "route": str(route.id),
            "service_date": "2026-09-01",
            "departure_time": "08:00:00",
            "schedule": str(other_schedule.id),
        },
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["schedule"] is None


def test_manual_trip_creation_rejects_a_vehicle_from_a_different_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    with tenant_context(str(client.id)):
        other_vehicle = VehicleFactory(client=client)

    response = _auth_client(staff).post(
        reverse("trip-list-create"),
        {
            "route": str(route.id),
            "service_date": "2026-09-01",
            "departure_time": "08:00:00",
            "vehicle": str(other_vehicle.id),
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "vehicle" in response.data


def test_manual_trip_creation_rejects_a_driver_from_a_different_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    with tenant_context(str(client.id)):
        other_driver = DriverFactory(client=client)

    response = _auth_client(staff).post(
        reverse("trip-list-create"),
        {
            "route": str(route.id),
            "service_date": "2026-09-01",
            "departure_time": "08:00:00",
            "driver": str(other_driver.id),
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "driver" in response.data


def test_staff_role_user_can_list_but_not_create_trips() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    route = _route(client)

    api = _auth_client(staff_role_user)
    list_response = api.get(reverse("trip-list-create"))
    create_response = api.post(
        reverse("trip-list-create"),
        {"route": str(route.id), "service_date": "2026-09-01", "departure_time": "08:00:00"},
    )

    assert list_response.status_code == status.HTTP_200_OK
    assert create_response.status_code == status.HTTP_403_FORBIDDEN


def test_trip_list_filters_by_service_date_and_status() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    matching = _trip(
        client,
        route=route,
        business=route.business,
        service_date=datetime.date(2026, 9, 10),
        status=Trip.Status.SCHEDULED,
    )
    _trip(
        client,
        route=route,
        business=route.business,
        service_date=datetime.date(2026, 9, 11),
        status=Trip.Status.SCHEDULED,
    )

    response = _auth_client(staff).get(
        reverse("trip-list-create"), {"service_date": "2026-09-10", "status": "scheduled"}
    )

    assert response.status_code == status.HTTP_200_OK
    ids = {row["id"] for row in response.data["results"]}
    assert ids == {str(matching.id)}


def test_trip_list_filters_by_business() -> None:
    """A Client can run several Businesses, and client-admin's Trip list
    scopes to the active one the way every sibling list screen does —
    which needs a `?business=` param GET /trips/ didn't have."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    other_route = _route(client)
    mine = _trip(client, route=route, business=route.business)
    _trip(client, route=other_route, business=other_route.business)

    response = _auth_client(staff).get(
        reverse("trip-list-create"), {"business": str(route.business_id)}
    )

    assert response.status_code == status.HTTP_200_OK
    ids = {row["id"] for row in response.data["results"]}
    assert ids == {str(mine.id)}


def test_trip_list_rejects_unknown_business_query_param() -> None:
    """Same tenant-scoped-lookup-or-400 convention the sibling apps use —
    another Client's Business id must not silently return an unfiltered
    list."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).get(
        reverse("trip-list-create"), {"business": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_trip_list_rejects_unknown_route_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).get(
        reverse("trip-list-create"), {"route": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


# --- Trip: assignment ---------------------------------------------------


def test_assign_vehicle_and_driver_to_a_trip() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client)
    with tenant_context(str(client.id)):
        vehicle = VehicleFactory(client=client, business=trip.business)
        driver = DriverFactory(client=client, business=trip.business)

    response = _auth_client(staff).patch(
        reverse("trip-assignment-update", kwargs={"pk": str(trip.id)}),
        {"vehicle": str(vehicle.id), "driver": str(driver.id)},
    )

    assert response.status_code == status.HTTP_200_OK
    assert str(response.data["vehicle"]["id"]) == str(vehicle.id)
    assert str(response.data["driver"]["id"]) == str(driver.id)
    entry = AuditLog.objects.get(action="trip.assignment_updated")
    assert entry.client_id == client.id


def test_assignment_rejects_a_vehicle_from_a_different_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client)
    with tenant_context(str(client.id)):
        other_vehicle = VehicleFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("trip-assignment-update", kwargs={"pk": str(trip.id)}),
        {"vehicle": str(other_vehicle.id)},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "vehicle" in response.data


def test_cross_client_trip_assignment_is_a_404() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    trip_b = _trip(client_b)

    response = _auth_client(staff_a).patch(
        reverse("trip-assignment-update", kwargs={"pk": str(trip_b.id)}), {}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- Trip: status transitions ---------------------------------------------


@pytest.mark.parametrize(
    ("from_status", "to_status", "needs_reason"),
    [
        (Trip.Status.SCHEDULED, Trip.Status.IN_PROGRESS, False),
        (Trip.Status.SCHEDULED, Trip.Status.CANCELLED, True),
        (Trip.Status.IN_PROGRESS, Trip.Status.COMPLETED, False),
        (Trip.Status.IN_PROGRESS, Trip.Status.CANCELLED, True),
    ],
)
def test_legal_transitions_succeed_and_audit(
    from_status: str, to_status: str, needs_reason: bool
) -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=from_status)

    body = {"status": to_status}
    if needs_reason:
        body["reason"] = "Operational reason"

    response = _auth_client(staff).post(reverse("trip-status", kwargs={"pk": str(trip.id)}), body)

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == to_status
    entry = AuditLog.objects.get(action="trip.status_changed")
    assert entry.client_id == client.id


def test_illegal_transition_returns_400() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.COMPLETED)

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "scheduled"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_requesting_the_current_status_is_an_idempotent_no_op() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "scheduled"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert not AuditLog.objects.filter(action="trip.status_changed").exists()


def test_cancelling_without_a_reason_returns_400() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "cancelled"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "reason" in response.data


# --- actual departure/arrival times ---------------------------------
# docs/specs/16-operational-analytics.md slice 1. `status_changed_at` is
# one mutable field every transition overwrites, so it cannot say when a
# Trip departed once it has since completed — which is why delay is not
# derivable without these two.


def test_starting_a_trip_stamps_its_actual_departure_only() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)
    assert trip.actual_departure_at is None

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "in_progress"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["actual_departure_at"] is not None
    assert response.data["actual_arrival_at"] is None


def test_completing_a_trip_stamps_arrival_and_leaves_departure_alone() -> None:
    """The departure time must survive the transition that follows it —
    the whole failure `status_changed_at` has."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)
    api = _auth_client(staff)

    api.post(reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "in_progress"})
    with tenant_context(str(client.id)):
        departed_at = Trip.objects.get(pk=trip.pk).actual_departure_at
    response = api.post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "completed"}
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        after = Trip.objects.get(pk=trip.pk)
    assert after.actual_departure_at == departed_at
    assert after.actual_arrival_at is not None
    # And `status_changed_at` has moved on, which is exactly why the
    # departure time needed a column of its own.
    assert after.status_changed_at != departed_at


def test_a_trip_cancelled_before_departure_has_neither_time() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}),
        {"status": "cancelled", "reason": "Vehicle unavailable"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["actual_departure_at"] is None
    assert response.data["actual_arrival_at"] is None


def test_a_no_op_transition_stamps_nothing() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.IN_PROGRESS)

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}), {"status": "in_progress"}
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        assert Trip.objects.get(pk=trip.pk).actual_departure_at is None


def test_transition_does_not_rewrite_a_departure_time_that_already_happened() -> None:
    """`TRIP_TRANSITIONS` makes returning to `in_progress` unreachable
    through the API, but `transition_trip_status` trusts its caller to
    have checked that. An analytics field a future caller could silently
    falsify is worse than one that is occasionally stale."""
    from ..services import transition_trip_status

    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)

    with tenant_context(str(client.id)):
        trip = transition_trip_status(
            trip=trip, new_status=Trip.Status.IN_PROGRESS, reason="", actor=staff
        )
        first = trip.actual_departure_at
        trip = transition_trip_status(
            trip=trip, new_status=Trip.Status.COMPLETED, reason="", actor=staff
        )
        trip = transition_trip_status(
            trip=trip, new_status=Trip.Status.IN_PROGRESS, reason="", actor=staff
        )

    assert trip.actual_departure_at == first


def test_cancelling_a_trip_with_an_assigned_vehicle_keeps_the_assignment() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    trip = _trip(client, status=Trip.Status.SCHEDULED)
    with tenant_context(str(client.id)):
        vehicle = VehicleFactory(client=client, business=trip.business)
        trip.vehicle = vehicle
        trip.save(update_fields=["vehicle"])

    response = _auth_client(staff).post(
        reverse("trip-status", kwargs={"pk": str(trip.id)}),
        {"status": "cancelled", "reason": "Surge cancelled"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert str(response.data["vehicle"]["id"]) == str(vehicle.id)


# --- ?search= / ?is_active= on GET /schedules/ ------------------------
# docs/specs/14-design-system-and-ui-rebuild.md slice 3a. A Schedule has
# no name of its own, so search matches its route's — that is the thing
# an operator actually types.


def test_schedule_list_search_matches_route_name_case_insensitively() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    ikeja = _route(client, name="Ikeja Express")
    lekki = _route(client, name="Lekki Loop")
    match = _schedule(client, route=ikeja, business=ikeja.business)
    _schedule(client, route=lekki, business=lekki.business)

    response = _auth_client(staff).get(reverse("schedule-list-create"), {"search": "ikeja"})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(match.id)]


def test_schedule_list_search_with_no_match_returns_empty_not_everything() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, name="Ikeja Express")
    _schedule(client, route=route, business=route.business)

    response = _auth_client(staff).get(reverse("schedule-list-create"), {"search": "nope"})

    assert response.data["count"] == 0


def test_schedule_list_search_never_reaches_another_clients_rows() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b, name="Ikeja Express")
    _schedule(client_b, route=route_b, business=route_b.business)

    response = _auth_client(staff_a).get(reverse("schedule-list-create"), {"search": "Ikeja"})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 0


def test_schedule_list_filters_by_is_active() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    active = _schedule(client, route=route, business=route.business, is_active=True)
    inactive = _schedule(client, route=route, business=route.business, is_active=False)

    api = _auth_client(staff)
    actives = api.get(reverse("schedule-list-create"), {"is_active": "true"})
    inactives = api.get(reverse("schedule-list-create"), {"is_active": "false"})

    assert [row["id"] for row in actives.data["results"]] == [str(active.id)]
    assert [row["id"] for row in inactives.data["results"]] == [str(inactive.id)]


def test_schedule_list_without_is_active_returns_both() -> None:
    # Guards the QueryDict/BooleanField substitution — see the note in
    # this view's get_queryset().
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    _schedule(client, route=route, business=route.business, is_active=True)
    _schedule(client, route=route, business=route.business, is_active=False)

    response = _auth_client(staff).get(reverse("schedule-list-create"))

    assert response.data["count"] == 2


def test_schedule_serializer_carries_its_route_name() -> None:
    # A Schedule has no name of its own. Without this, the list screen
    # had to resolve it through a shared client-side store, and a
    # schedule whose route was not in that store's loaded page rendered
    # as a raw UUID.
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, name="Ikeja Express")
    _schedule(client, route=route, business=route.business)

    response = _auth_client(staff).get(reverse("schedule-list-create"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"][0]["route_name"] == "Ikeja Express"


# --- ?search= on GET /trips/ -------------------------------------------
# docs/specs/14-design-system-and-ui-rebuild.md slice 3b. A Trip has no
# name of its own, so search matches its route's — the same reasoning
# GET /schedules/ already carries.


def test_trip_list_search_matches_route_name_case_insensitively() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    ikeja = _route(client, name="Ikeja Express")
    lekki = _route(client, name="Lekki Loop")
    match = _trip(client, route=ikeja, business=ikeja.business)
    _trip(client, route=lekki, business=lekki.business)

    response = _auth_client(staff).get(reverse("trip-list-create"), {"search": "ikeja"})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(match.id)]


def test_trip_list_search_with_no_match_returns_empty_not_everything() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, name="Ikeja Express")
    _trip(client, route=route, business=route.business)

    response = _auth_client(staff).get(reverse("trip-list-create"), {"search": "nope"})

    assert response.data["count"] == 0


def test_trip_list_combines_search_with_the_business_filter() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    ikeja = _route(client, name="Ikeja Express")
    other = _route(client, name="Ikeja Express")
    match = _trip(client, route=ikeja, business=ikeja.business)
    _trip(client, route=other, business=other.business)

    response = _auth_client(staff).get(
        reverse("trip-list-create"), {"business": str(ikeja.business_id), "search": "Ikeja"}
    )

    assert [row["id"] for row in response.data["results"]] == [str(match.id)]


def test_trip_list_search_never_reaches_another_clients_rows() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b, name="Ikeja Express")
    _trip(client_b, route=route_b, business=route_b.business)

    response = _auth_client(staff_a).get(reverse("trip-list-create"), {"search": "Ikeja"})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 0
