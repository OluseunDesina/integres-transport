import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

from ..models import Route, RouteStop, Stop
from .factories import RouteFactory, RouteStopFactory, StopFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _approved_business(client: object, **overrides: object) -> Business:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED, **overrides)


def _route(client: object, **overrides: object) -> Route:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return RouteFactory(client=client, **overrides)


def _stop(client: object, **overrides: object) -> Stop:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return StopFactory(client=client, **overrides)


def _route_stop(client: object, **overrides: object) -> RouteStop:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return RouteStopFactory(client=client, **overrides)


# --- Route ---------------------------------------------------------------


def test_client_staff_can_create_a_route_for_an_approved_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("route-list-create"),
        {"business": str(business.id), "name": "Ikeja Express"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["name"] == "Ikeja Express"
    assert response.data["stops"] == []
    with tenant_context(str(client.id)):
        route = Route.objects.get(pk=response.data["id"])
    assert route.business_id == business.id
    entry = AuditLog.objects.get(action="route.created")
    assert entry.client_id == client.id


def test_route_creation_rejected_when_business_not_kyb_approved() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.PENDING)

    response = _auth_client(staff).post(
        reverse("route-list-create"), {"business": str(business.id), "name": "Ikeja Express"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "business" in response.data


def test_route_creation_rejected_for_a_business_belonging_to_another_client() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    business_b = _approved_business(client_b)

    response = _auth_client(staff_a).post(
        reverse("route-list-create"), {"business": str(business_b.id), "name": "Hijack"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_staff_role_user_can_list_but_not_create_routes() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    business = _approved_business(client)

    api = _auth_client(staff_role_user)
    list_response = api.get(reverse("route-list-create"))
    create_response = api.post(
        reverse("route-list-create"), {"business": str(business.id), "name": "Blocked"}
    )

    assert list_response.status_code == status.HTTP_200_OK
    assert create_response.status_code == status.HTTP_403_FORBIDDEN


def test_passenger_cannot_list_routes() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("route-list-create"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_list_only_returns_the_callers_own_routes() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    _route(client_a, name="A's route")
    _route(client_b, name="B's route")

    response = _auth_client(staff_a).get(reverse("route-list-create"))

    assert response.status_code == status.HTTP_200_OK
    names = [row["name"] for row in response.data["results"]]
    assert names == ["A's route"]


def test_patch_updates_mutable_fields_and_is_audit_logged() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)

    response = _auth_client(staff).patch(
        reverse("route-update", kwargs={"pk": str(route.id)}), {"name": "Renamed Route"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["name"] == "Renamed Route"
    entry = AuditLog.objects.get(action="route.updated")
    assert entry.metadata["name"] == "Renamed Route"


def test_patch_cannot_change_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    other_business = _approved_business(client)

    response = _auth_client(staff).patch(
        reverse("route-update", kwargs={"pk": str(route.id)}),
        {"business": str(other_business.id)},
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        route.refresh_from_db()
    assert route.business_id != other_business.id


def test_cross_client_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b)

    response = _auth_client(staff_a).patch(
        reverse("route-update", kwargs={"pk": str(route_b.id)}), {"name": "Hijacked"}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- Stop ------------------------------------------------------------------


def test_client_staff_can_create_a_stop_with_an_address() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("stop-list-create"),
        {"business": str(business.id), "name": "Ikeja Bus Park", "address": "12 Awolowo Rd"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    entry = AuditLog.objects.get(action="stop.created")
    assert entry.client_id == client.id


def test_stop_creation_requires_an_address_or_coordinates() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("stop-list-create"), {"business": str(business.id), "name": "Nowhere"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_stop_creation_with_only_coordinates_is_allowed() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("stop-list-create"),
        {
            "business": str(business.id),
            "name": "GPS Point",
            "latitude": "6.524379",
            "longitude": "3.379206",
        },
    )

    assert response.status_code == status.HTTP_201_CREATED


def test_patch_clearing_the_only_location_data_is_rejected() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    stop = _stop(client, address="Somewhere", latitude=None, longitude=None)

    response = _auth_client(staff).patch(
        reverse("stop-update", kwargs={"pk": str(stop.id)}), {"address": ""}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


# --- Route<->Stop ordering ---------------------------------------------


def test_set_route_stops_creates_the_ordered_set() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    stop_a = _stop(client, business=route.business)
    stop_b = _stop(client, business=route.business)

    response = _auth_client(staff).put(
        reverse("route-stops-update", kwargs={"pk": str(route.id)}),
        {"stops": [str(stop_b.id), str(stop_a.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert [s["id"] for s in response.data["stops"]] == [str(stop_b.id), str(stop_a.id)]
    assert [s["sequence"] for s in response.data["stops"]] == [1, 2]


def test_set_route_stops_rejects_a_stop_from_a_different_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    foreign_stop = _stop(client)  # different business (own SubFactory)

    response = _auth_client(staff).put(
        reverse("route-stops-update", kwargs={"pk": str(route.id)}),
        {"stops": [str(foreign_stop.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_set_route_stops_rejects_duplicates() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    stop = _stop(client, business=route.business)

    response = _auth_client(staff).put(
        reverse("route-stops-update", kwargs={"pk": str(route.id)}),
        {"stops": [str(stop.id), str(stop.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_set_route_stops_replaces_the_previous_set_not_appends() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    stop_a = _stop(client, business=route.business)
    stop_b = _stop(client, business=route.business)
    _route_stop(client, route=route, stop=stop_a, sequence=1)

    response = _auth_client(staff).put(
        reverse("route-stops-update", kwargs={"pk": str(route.id)}),
        {"stops": [str(stop_b.id)]},
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        remaining = list(RouteStop.objects.filter(route=route))
    assert len(remaining) == 1
    assert remaining[0].stop_id == stop_b.id


# --- ?business= query filtering -------------------------------------


def test_route_list_filters_by_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business_a = _approved_business(client)
    business_b = _approved_business(client)
    route_a = _route(client, business=business_a)
    _route(client, business=business_b)

    response = _auth_client(staff).get(
        reverse("route-list-create"), {"business": str(business_a.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(route_a.id)]


def test_route_list_rejects_unknown_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).get(
        reverse("route-list-create"), {"business": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_route_list_rejects_another_clients_business_query_param() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    business_b = _approved_business(client_b)

    response = _auth_client(staff_a).get(
        reverse("route-list-create"), {"business": str(business_b.id)}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_stop_list_filters_by_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business_a = _approved_business(client)
    business_b = _approved_business(client)
    stop_a = _stop(client, business=business_a)
    _stop(client, business=business_b)

    response = _auth_client(staff).get(
        reverse("stop-list-create"), {"business": str(business_a.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    ids = [row["id"] for row in response.data["results"]]
    assert ids == [str(stop_a.id)]


def test_stop_list_rejects_unknown_business_query_param() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).get(
        reverse("stop-list-create"), {"business": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_stop_list_rejects_another_clients_business_query_param() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    business_b = _approved_business(client_b)

    response = _auth_client(staff_a).get(
        reverse("stop-list-create"), {"business": str(business_b.id)}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
