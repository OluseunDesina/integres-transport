"""apps.network.services.find_route_stop_matches_across_clients — the
marketplace's cross-Client variant of find_route_stop_matches. See
docs/adr/0009 and docs/specs/22-marketplace.md."""

import pytest

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context

from ..models import Route
from ..services import find_route_stop_matches_across_clients
from .factories import RouteFactory, RouteStopFactory, StopFactory

pytestmark = pytest.mark.django_db


def test_matches_a_route_belonging_to_a_different_client_entirely() -> None:
    """The whole point: a caller whose own Client owns nothing here
    still finds this Route, unlike the same-Client `find_route_stop_matches`."""
    other_client = ClientFactory()
    with tenant_context(str(other_client.id)):
        route = RouteFactory(client=other_client)
        yaba = StopFactory(client=other_client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=other_client, business=route.business, name="Ikeja")
        RouteStopFactory(client=other_client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=other_client, route=route, stop=ikeja, sequence=2)

    # Deliberately outside any tenant_context — a marketplace passenger's
    # own request context never matches `other_client`.
    matches = find_route_stop_matches_across_clients(origin="yaba", destination="ikeja")

    assert [(m.route.id, m.from_stop.id, m.to_stop.id) for m in matches] == [
        (route.id, yaba.id, ikeja.id)
    ]
    assert matches[0].stops_between == 0


def test_excludes_a_draft_route_even_though_it_would_be_visible_same_client() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, status=Route.Status.DRAFT)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

    matches = find_route_stop_matches_across_clients(origin="yaba", destination="ikeja")

    assert matches == []


def test_excludes_a_route_whose_business_kyb_is_not_approved() -> None:
    """The predicate `find_route_stop_matches` never needed: RLS's own
    Client-scoping incidentally guaranteed "this Business belongs to a
    Client I already trust" there, which stops being true here."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.SUBMITTED)
        route = RouteFactory(client=client, business=business)
        yaba = StopFactory(client=client, business=business, name="Yaba")
        ikeja = StopFactory(client=client, business=business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

    matches = find_route_stop_matches_across_clients(origin="yaba", destination="ikeja")

    assert matches == []


def test_excludes_an_inactive_stop() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(
            client=client, business=route.business, name="Ikeja", is_active=False
        )
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

    matches = find_route_stop_matches_across_clients(origin="yaba", destination="ikeja")

    assert matches == []


def test_still_excludes_the_reverse_direction() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

    matches = find_route_stop_matches_across_clients(origin="ikeja", destination="yaba")

    assert matches == []


def test_matches_across_two_entirely_unrelated_clients_at_once() -> None:
    """A search term matching stops under two different operators finds
    both — the marketplace's whole reason for existing."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_a.id)):
        route_a = RouteFactory(client=client_a)
        yaba_a = StopFactory(client=client_a, business=route_a.business, name="Yaba")
        ikeja_a = StopFactory(client=client_a, business=route_a.business, name="Ikeja")
        RouteStopFactory(client=client_a, route=route_a, stop=yaba_a, sequence=1)
        RouteStopFactory(client=client_a, route=route_a, stop=ikeja_a, sequence=2)
    with tenant_context(str(client_b.id)):
        route_b = RouteFactory(client=client_b)
        yaba_b = StopFactory(client=client_b, business=route_b.business, name="Yaba")
        ikeja_b = StopFactory(client=client_b, business=route_b.business, name="Ikeja")
        RouteStopFactory(client=client_b, route=route_b, stop=yaba_b, sequence=1)
        RouteStopFactory(client=client_b, route=route_b, stop=ikeja_b, sequence=2)

    matches = find_route_stop_matches_across_clients(origin="yaba", destination="ikeja")

    assert {m.route.id for m in matches} == {route_a.id, route_b.id}
