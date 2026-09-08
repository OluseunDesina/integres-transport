"""Route status lifecycle, guards, duplicate and detail —
docs/specs/19-route-lifecycle.md."""

import datetime

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.models import FareRule
from apps.fares.tests.factories import FareRuleFactory, FareSegmentRuleFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory

from ..models import Route, RouteStop
from ..services import duplicate_route
from .factories import RouteFactory, RouteStopFactory, StopFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _route(client: object, **overrides: object) -> Route:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return RouteFactory(client=client, **overrides)


def _add_two_stops(client: object, route: Route) -> None:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        for sequence in (1, 2):
            stop = StopFactory(client=client, business=route.business)
            RouteStopFactory(client=client, route=route, stop=stop, sequence=sequence)


def _flat_fare(client: object, route: Route) -> None:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        FareRuleFactory(client=client, route=route, business=route.business)


def _segment_fare(client: object, route: Route) -> None:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        FareSegmentRuleFactory(client=client, route=route, business=route.business)


def _activatable_draft(client: object, **overrides: object) -> Route:
    """A route with two stops and a flat fare — the minimum that passes
    the `-> active` guard. Defaults to `draft`, overridable so the same
    helper can build e.g. an `inactive` route ready to reactivate."""
    overrides.setdefault("status", Route.Status.DRAFT)
    route = _route(client, **overrides)
    _add_two_stops(client, route)
    _flat_fare(client, route)
    return route


def _status(client: object, staff: User, route: Route, new_status: str, **body: object) -> Response:
    return _auth_client(staff).post(
        reverse("route-status", kwargs={"pk": str(route.id)}), {"status": new_status, **body}
    )


# --- Transition matrix -----------------------------------------------------


def test_draft_can_move_to_active_when_ready() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _activatable_draft(client)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "active"
    with tenant_context(str(client.id)):
        route.refresh_from_db()
    assert route.status == Route.Status.ACTIVE
    entry = AuditLog.objects.get(action="route.status_changed")
    assert entry.metadata["status"] == "active"


def test_draft_can_move_straight_to_archived() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.DRAFT)

    response = _status(client, staff, route, "archived")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "archived"


def test_draft_cannot_move_to_inactive() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.DRAFT)

    response = _status(client, staff, route, "inactive")

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_active_can_move_to_inactive_or_archived() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    to_inactive = _route(client, status=Route.Status.ACTIVE)
    to_archived = _route(client, status=Route.Status.ACTIVE)

    inactive_response = _status(client, staff, to_inactive, "inactive")
    archived_response = _status(client, staff, to_archived, "archived")

    assert inactive_response.status_code == status.HTTP_200_OK
    assert archived_response.status_code == status.HTTP_200_OK


def test_active_cannot_move_straight_to_draft() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)

    response = _status(client, staff, route, "draft")

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_inactive_can_move_back_to_active_or_to_archived() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    to_active = _activatable_draft(client, status=Route.Status.INACTIVE)
    to_archived = _route(client, status=Route.Status.INACTIVE)

    active_response = _status(client, staff, to_active, "active")
    archived_response = _status(client, staff, to_archived, "archived")

    assert active_response.status_code == status.HTTP_200_OK
    assert archived_response.status_code == status.HTTP_200_OK


def test_archived_can_only_restore_to_inactive_never_straight_to_active() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _activatable_draft(client, status=Route.Status.ARCHIVED)

    to_active = _status(client, staff, route, "active")
    to_inactive = _status(client, staff, route, "inactive")

    assert to_active.status_code == status.HTTP_400_BAD_REQUEST
    assert to_inactive.status_code == status.HTTP_200_OK
    assert to_inactive.data["status"] == "inactive"


def test_a_request_naming_the_current_status_is_a_no_op() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_200_OK
    # No audit row for a no-op — same convention as
    # apps.scheduling.services.transition_trip_status.
    assert not AuditLog.objects.filter(action="route.status_changed").exists()


# --- Activation guards -------------------------------------------------


def test_activation_is_refused_with_no_fare_configured() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.DRAFT)
    _add_two_stops(client, route)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_409_CONFLICT
    assert "fare" in response.data["detail"].lower()


def test_activation_is_refused_with_fewer_than_two_stops() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.DRAFT)
    _flat_fare(client, route)
    with tenant_context(str(client.id)):
        lone_stop = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=lone_stop, sequence=1)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_409_CONFLICT
    assert "stop" in response.data["detail"].lower()


def test_activation_succeeds_for_a_per_segment_business_with_a_segment_fare() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(
        client,
        status=Route.Status.DRAFT,
        business__fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT,
    )
    _add_two_stops(client, route)
    _segment_fare(client, route)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_200_OK


def test_activation_for_a_per_segment_business_ignores_a_flat_fare() -> None:
    """A FareRule existing for the route does not satisfy the guard when
    the Business is per-segment — apps.fares.services.route_fare_summary
    dispatches on the Business's own pricing mode, the same as
    get_fare()."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(
        client,
        status=Route.Status.DRAFT,
        business__fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT,
    )
    _add_two_stops(client, route)
    _flat_fare(client, route)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_409_CONFLICT


def test_reactivating_an_inactive_route_is_also_guarded() -> None:
    """The guard applies uniformly to any transition into `active`, not
    only `draft -> active` — see set_route_status's own docstring."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.INACTIVE)

    response = _status(client, staff, route, "active")

    assert response.status_code == status.HTTP_409_CONFLICT


# --- Archive guard -------------------------------------------------------


def test_archiving_is_refused_while_a_future_trip_is_scheduled() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)
    tomorrow = timezone.now().date() + datetime.timedelta(days=1)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=tomorrow,
            scheduled_departure_at=timezone.now() + datetime.timedelta(days=1),
            status=Trip.Status.SCHEDULED,
        )

    response = _status(client, staff, route, "archived")

    assert response.status_code == status.HTTP_409_CONFLICT
    assert "1" in response.data["detail"]


def test_archiving_is_allowed_with_only_past_or_cancelled_trips() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)
    yesterday = timezone.now().date() - datetime.timedelta(days=1)
    tomorrow = timezone.now().date() + datetime.timedelta(days=1)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=yesterday,
            scheduled_departure_at=timezone.now() - datetime.timedelta(days=1),
            status=Trip.Status.COMPLETED,
        )
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=tomorrow,
            scheduled_departure_at=timezone.now() + datetime.timedelta(days=1),
            status=Trip.Status.CANCELLED,
        )

    response = _status(client, staff, route, "archived")

    assert response.status_code == status.HTTP_200_OK


def test_past_trips_never_block_archiving() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)
    last_week = timezone.now().date() - datetime.timedelta(days=7)
    with tenant_context(str(client.id)):
        TripFactory(
            client=client,
            route=route,
            business=route.business,
            service_date=last_week,
            scheduled_departure_at=timezone.now() - datetime.timedelta(days=7),
            status=Trip.Status.SCHEDULED,
        )

    response = _status(client, staff, route, "archived")

    assert response.status_code == status.HTTP_200_OK


# --- PATCH vs the status endpoint ----------------------------------------


def test_patch_cannot_move_status() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)

    response = _auth_client(staff).patch(
        reverse("route-detail", kwargs={"pk": str(route.id)}), {"status": "archived"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "status" in response.data


def test_patch_updates_distance_and_duration() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)

    response = _auth_client(staff).patch(
        reverse("route-detail", kwargs={"pk": str(route.id)}),
        {"distance_km": "12.50", "estimated_duration_minutes": 45},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["distance_km"] == "12.50"
    assert response.data["estimated_duration_minutes"] == 45


def test_editing_an_archived_route_is_rejected() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ARCHIVED)

    response = _auth_client(staff).patch(
        reverse("route-detail", kwargs={"pk": str(route.id)}), {"name": "Renamed"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_status_endpoint_requires_network_manage_not_just_view() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    route = _route(client, status=Route.Status.ACTIVE)

    response = _status(client, staff_role_user, route, "inactive")

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_status_cross_client_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b, status=Route.Status.ACTIVE)

    response = _status(client_a, staff_a, route_b, "inactive")

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- Duplicate -------------------------------------------------------------


def test_duplicate_copies_stops_in_order_forces_draft_clears_code() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE, name="Ikeja Express", code="IKJ-1")
    _add_two_stops(client, route)

    response = _auth_client(staff).post(reverse("route-duplicate", kwargs={"pk": str(route.id)}))

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["status"] == "draft"
    assert response.data["name"] == "Ikeja Express (copy)"
    assert response.data["code"] == ""
    assert [s["sequence"] for s in response.data["stops"]] == [1, 2]
    entry = AuditLog.objects.get(action="route.duplicated")
    assert entry.metadata["source_route_id"] == str(route.id)


def test_duplicate_copies_no_fares_schedules_or_trips() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)
    _add_two_stops(client, route)
    _flat_fare(client, route)
    with tenant_context(str(client.id)):
        TripFactory(client=client, route=route, business=route.business)

    response = _auth_client(staff).post(reverse("route-duplicate", kwargs={"pk": str(route.id)}))

    assert response.status_code == status.HTTP_201_CREATED
    copy_id = response.data["id"]
    with tenant_context(str(client.id)):
        assert not Trip.objects.filter(route_id=copy_id).exists()
        assert not FareRule.objects.filter(route_id=copy_id).exists()


def test_duplicating_an_archived_route_is_allowed() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ARCHIVED)

    response = _auth_client(staff).post(reverse("route-duplicate", kwargs={"pk": str(route.id)}))

    assert response.status_code == status.HTTP_201_CREATED


def test_duplicating_a_route_with_no_stops_is_allowed() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)

    response = _auth_client(staff).post(reverse("route-duplicate", kwargs={"pk": str(route.id)}))

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["stops"] == []


def test_duplicate_requires_network_manage() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    route = _route(client)

    response = _auth_client(staff_role_user).post(
        reverse("route-duplicate", kwargs={"pk": str(route.id)})
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_duplicate_cross_client_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b)

    response = _auth_client(staff_a).post(
        reverse("route-duplicate", kwargs={"pk": str(route_b.id)})
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_duplicate_route_under_platform_staff_bypass_with_no_tenancy_contextvar() -> None:
    """The third place this exact mistake has been available
    (`set_route_stops`, `apps.fleet.services.replace_vehicle_type_seats`):
    under `platform_staff_bypass()` the Python tenancy contextvar is
    unset, so `.objects` would silently match zero stops to copy.
    `duplicate_route` uses `all_objects` throughout for exactly this
    reason — this calls it with no `tenant_context` active at all."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)
    _add_two_stops(client, route)

    with platform_staff_bypass():
        copy = duplicate_route(route=route, duplicated_by=staff)

    with tenant_context(str(client.id)):
        copied_stops = list(RouteStop.objects.filter(route=copy).order_by("sequence"))
    assert len(copied_stops) == 2


# --- Detail ------------------------------------------------------------


def test_detail_includes_stop_count_schedule_count_and_fare_summary() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.ACTIVE)
    _add_two_stops(client, route)
    _flat_fare(client, route)

    response = _auth_client(staff).get(reverse("route-detail", kwargs={"pk": str(route.id)}))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["stop_count"] == 2
    assert response.data["schedule_count"] == 0
    assert response.data["current_fare_summary"] == {
        "pricing_mode": "flat",
        "configured": True,
        "rule_count": 1,
    }


def test_detail_reports_unconfigured_when_no_fare_exists() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client, status=Route.Status.DRAFT)

    response = _auth_client(staff).get(reverse("route-detail", kwargs={"pk": str(route.id)}))

    assert response.data["current_fare_summary"]["configured"] is False
    assert response.data["current_fare_summary"]["rule_count"] == 0


def test_detail_cross_client_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b)

    response = _auth_client(staff_a).get(reverse("route-detail", kwargs={"pk": str(route_b.id)}))

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_detail_requires_network_view() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route = _route(client)

    response = _auth_client(passenger).get(reverse("route-detail", kwargs={"pk": str(route.id)}))

    assert response.status_code == status.HTTP_403_FORBIDDEN
