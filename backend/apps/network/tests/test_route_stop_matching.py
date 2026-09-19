"""apps.network.services.find_route_stop_matches — the origin/destination
connectivity query behind GET /trips/search/'s new origin/destination
flow. See that function's own docstring and
docs/specs/4-fares-seating-booking-frontend.md §3.3."""

import pytest

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context

from ..models import Route
from ..services import find_route_stop_matches
from .factories import RouteFactory, RouteStopFactory, StopFactory

pytestmark = pytest.mark.django_db


def test_matches_an_origin_and_destination_on_the_same_route_in_order() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

        matches = find_route_stop_matches(origin="yaba", destination="ikeja")

    assert [(m[0].id, m[1].id, m[2].id) for m in matches] == [(route.id, yaba.id, ikeja.id)]
    assert matches[0].stops_between == 0


def test_counts_the_stops_strictly_between_origin_and_destination() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ojota = StopFactory(client=client, business=route.business, name="Ojota")
        maryland = StopFactory(client=client, business=route.business, name="Maryland")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ojota, sequence=2)
        RouteStopFactory(client=client, route=route, stop=maryland, sequence=3)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=4)

        matches = find_route_stop_matches(origin="yaba", destination="ikeja")

    assert [m.stops_between for m in matches] == [2]


def test_excludes_the_reverse_direction() -> None:
    """A route running Yaba -> Ikeja must not answer a search for
    Ikeja -> Yaba — sequence order is the whole point of the join."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

        matches = find_route_stop_matches(origin="ikeja", destination="yaba")

    assert matches == []


def test_does_not_pair_stops_from_two_different_routes() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route_a = RouteFactory(client=client)
        route_b = RouteFactory(client=client, business=route_a.business)
        yaba = StopFactory(client=client, business=route_a.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route_a.business, name="Ikeja")
        RouteStopFactory(client=client, route=route_a, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route_b, stop=ikeja, sequence=1)

        matches = find_route_stop_matches(origin="yaba", destination="ikeja")

    assert matches == []


def test_excludes_an_inactive_stop() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja", is_active=False)
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

        matches = find_route_stop_matches(origin="yaba", destination="ikeja")

    assert matches == []


@pytest.mark.parametrize(
    "excluded_status",
    [Route.Status.DRAFT, Route.Status.INACTIVE, Route.Status.ARCHIVED],
)
def test_excludes_a_route_that_is_not_active(excluded_status: str) -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, status=excluded_status)
        yaba = StopFactory(client=client, business=route.business, name="Yaba")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

        matches = find_route_stop_matches(origin="yaba", destination="ikeja")

    assert matches == []


def test_returns_every_valid_pair_when_a_term_matches_more_than_one_stop() -> None:
    """ "Lagos" matching two physically distinct stops on the same route
    is a real, expected outcome — not resolved here, left for the
    frontend's suggestion dropdown to narrow before search time."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        lagos_a = StopFactory(client=client, business=route.business, name="Lagos Mainland")
        lagos_b = StopFactory(client=client, business=route.business, name="Lagos Island")
        ibadan = StopFactory(client=client, business=route.business, name="Ibadan")
        RouteStopFactory(client=client, route=route, stop=lagos_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=lagos_b, sequence=2)
        RouteStopFactory(client=client, route=route, stop=ibadan, sequence=3)

        matches = find_route_stop_matches(origin="lagos", destination="ibadan")

    assert {(m[1].id, m[2].id) for m in matches} == {
        (lagos_a.id, ibadan.id),
        (lagos_b.id, ibadan.id),
    }


def test_case_insensitive_partial_match() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        yaba = StopFactory(client=client, business=route.business, name="Yaba Bus Park")
        ikeja = StopFactory(client=client, business=route.business, name="Ikeja Along")
        RouteStopFactory(client=client, route=route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=route, stop=ikeja, sequence=2)

        matches = find_route_stop_matches(origin="YABA", destination="along")

    assert [(m[1].id, m[2].id) for m in matches] == [(yaba.id, ikeja.id)]


def test_spans_every_business_under_the_current_client() -> None:
    """A Client can run several Businesses (docs/specs/4-fares-seating-
    booking-frontend.md §3.2's own DECISION) — the same posture
    RouteBrowseView already establishes for browsing."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        lagos_biz = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        abuja_biz = BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED)
        lagos_route = RouteFactory(client=client, business=lagos_biz)
        abuja_route = RouteFactory(client=client, business=abuja_biz)
        yaba = StopFactory(client=client, business=lagos_biz, name="Yaba")
        ikeja = StopFactory(client=client, business=lagos_biz, name="Ikeja")
        wuse = StopFactory(client=client, business=abuja_biz, name="Wuse")
        garki = StopFactory(client=client, business=abuja_biz, name="Garki")
        RouteStopFactory(client=client, route=lagos_route, stop=yaba, sequence=1)
        RouteStopFactory(client=client, route=lagos_route, stop=ikeja, sequence=2)
        RouteStopFactory(client=client, route=abuja_route, stop=wuse, sequence=1)
        RouteStopFactory(client=client, route=abuja_route, stop=garki, sequence=2)

        lagos_matches = find_route_stop_matches(origin="yaba", destination="ikeja")
        abuja_matches = find_route_stop_matches(origin="wuse", destination="garki")

    assert [m[0].id for m in lagos_matches] == [lagos_route.id]
    assert [m[0].id for m in abuja_matches] == [abuja_route.id]


def test_never_matches_another_clients_stops() -> None:
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

        # Scoped to client_b's own tenant context, as a real request would
        # be — must see only its own Yaba/Ikeja pair, never client_a's.
        matches = find_route_stop_matches(origin="yaba", destination="ikeja")

    assert [m[0].id for m in matches] == [route_b.id]
