"""GET /routes/browse/ — the passenger-facing Route list. See
docs/specs/4-fares-seating-booking-frontend.md §3.2."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory

from ..models import Route
from .factories import RouteFactory, RouteStopFactory, StopFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _bookable_route(
    client: object, *, business: object | None = None, **overrides: object
) -> Route:
    """A Route with two active Stops — the minimum that has a bookable
    segment, and therefore the minimum this endpoint will return."""
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        if business is None:
            business = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        route = RouteFactory(client=client, business=business, **overrides)
        for sequence in (1, 2):
            stop = StopFactory(client=client, business=business)
            RouteStopFactory(client=client, route=route, stop=stop, sequence=sequence)
        return route


def test_passenger_can_browse_bookable_routes_with_embedded_business_and_stops() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    route = _bookable_route(client)

    response = _auth_client(passenger).get(reverse("route-browse"))

    assert response.status_code == status.HTTP_200_OK
    rows = response.data["results"]
    assert [row["id"] for row in rows] == [str(route.id)]
    assert rows[0]["business"] == {"id": route.business_id, "name": route.business.name}
    assert [stop["sequence"] for stop in rows[0]["stops"]] == [1, 2]


def test_browse_excludes_a_route_with_fewer_than_two_active_stops() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    bookable = _bookable_route(client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        # One stop only — no segment to book.
        one_stop_route = RouteFactory(client=client, business=business)
        lone_stop = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=one_stop_route, stop=lone_stop, sequence=1)
        # No stops at all.
        RouteFactory(client=client, business=business)

    response = _auth_client(passenger).get(reverse("route-browse"))

    assert [row["id"] for row in response.data["results"]] == [str(bookable.id)]


def test_browse_counts_and_embeds_only_active_stops() -> None:
    """A Route whose second Stop was deactivated has no bookable segment
    left, so it must not appear at all — and an active Route's own
    deactivated Stops must not be embedded as pickable options."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        route = RouteFactory(client=client, business=business)
        active_a = StopFactory(client=client, business=business)
        active_b = StopFactory(client=client, business=business)
        inactive = StopFactory(client=client, business=business, is_active=False)
        for sequence, stop in enumerate((active_a, active_b, inactive), start=1):
            RouteStopFactory(client=client, route=route, stop=stop, sequence=sequence)

        dropped = RouteFactory(client=client, business=business)
        kept_stop = StopFactory(client=client, business=business)
        dropped_stop = StopFactory(client=client, business=business, is_active=False)
        RouteStopFactory(client=client, route=dropped, stop=kept_stop, sequence=1)
        RouteStopFactory(client=client, route=dropped, stop=dropped_stop, sequence=2)

    response = _auth_client(passenger).get(reverse("route-browse"))

    rows = response.data["results"]
    assert [row["id"] for row in rows] == [str(route.id)]
    assert [stop["id"] for stop in rows[0]["stops"]] == [str(active_a.id), str(active_b.id)]


def test_browse_excludes_an_inactive_route() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    active = _bookable_route(client)
    _bookable_route(client, status=Route.Status.INACTIVE)

    response = _auth_client(passenger).get(reverse("route-browse"))

    assert [row["id"] for row in response.data["results"]] == [str(active.id)]


def test_browse_excludes_a_draft_route() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    active = _bookable_route(client)
    _bookable_route(client, status=Route.Status.DRAFT)

    response = _auth_client(passenger).get(reverse("route-browse"))

    assert [row["id"] for row in response.data["results"]] == [str(active.id)]


def test_browse_excludes_an_archived_route() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    active = _bookable_route(client)
    _bookable_route(client, status=Route.Status.ARCHIVED)

    response = _auth_client(passenger).get(reverse("route-browse"))

    assert [row["id"] for row in response.data["results"]] == [str(active.id)]


def test_browse_spans_every_business_under_the_passengers_client() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        lagos = BusinessFactory(
            client=client, name="Lagos Shuttle Co", kyb_status=Business.KybStatus.APPROVED
        )
        abuja = BusinessFactory(
            client=client, name="Abuja Shuttle Co", kyb_status=Business.KybStatus.APPROVED
        )
    lagos_route = _bookable_route(client, business=lagos)
    abuja_route = _bookable_route(client, business=abuja)

    response = _auth_client(passenger).get(reverse("route-browse"))

    rows = response.data["results"]
    assert {row["id"] for row in rows} == {str(lagos_route.id), str(abuja_route.id)}
    assert {row["business"]["name"] for row in rows} == {"Lagos Shuttle Co", "Abuja Shuttle Co"}


def test_browse_narrows_to_one_business_when_filtered() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        wanted = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        other = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
    wanted_route = _bookable_route(client, business=wanted)
    _bookable_route(client, business=other)

    response = _auth_client(passenger).get(reverse("route-browse"), {"business": str(wanted.id)})

    assert [row["id"] for row in response.data["results"]] == [str(wanted_route.id)]


def test_browse_400s_on_an_unknown_business_filter() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _bookable_route(client)

    response = _auth_client(passenger).get(
        reverse("route-browse"), {"business": "00000000-0000-0000-0000-000000000000"}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_browse_400s_on_another_clients_business_filter() -> None:
    """Same unknown-or-foreign-id-→400 posture the staff list views take
    — never a silently empty or unfiltered list."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    _bookable_route(client_a)
    route_b = _bookable_route(client_b)

    response = _auth_client(passenger_a).get(
        reverse("route-browse"), {"business": str(route_b.business_id)}
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_browse_never_returns_another_clients_routes() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    own = _bookable_route(client_a)
    _bookable_route(client_b)

    response = _auth_client(passenger_a).get(reverse("route-browse"))

    assert [row["id"] for row in response.data["results"]] == [str(own.id)]


def test_browse_is_open_to_a_passenger_who_is_403ed_by_the_staff_route_list() -> None:
    """The whole reason this endpoint exists: passengers hold no
    Role/Permission, so GET /routes/ 403s them (docs/adr/0003)."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    _bookable_route(client)
    api = _auth_client(passenger)

    assert api.get(reverse("route-browse")).status_code == status.HTTP_200_OK
    assert api.get(reverse("route-list-create")).status_code == status.HTTP_403_FORBIDDEN


def test_browse_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    _bookable_route(client)

    response = APIClient().get(reverse("route-browse"))

    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_browse_query_count_does_not_scale_with_route_count(
    django_assert_max_num_queries,  # type: ignore[no-untyped-def]
) -> None:
    """The embedded stops are batched per request, not per row — the
    same N+1 guard RouteSerializer's own docstring describes."""
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
    for _ in range(5):
        _bookable_route(client, business=business)

    with django_assert_max_num_queries(8):
        response = _auth_client(passenger).get(reverse("route-browse"))

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5
