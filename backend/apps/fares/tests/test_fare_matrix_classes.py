"""The fare matrix, scoped to one class — docs/specs/15-trip-classes.md.

With a class dimension there is one grid *per class*, so
`?trip_class=` is a required parameter rather than a defaulted one. The
tests that matter most here are the isolation ones: a save into one
class's grid must leave every other grid — including the wildcard grid
that every class falls back to — exactly as it was.
"""

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
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory

from ..models import ANY_TRIP_CLASS, FareSegmentRule

pytestmark = pytest.mark.django_db

PREMIUM = Business.TripClass.PREMIUM


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _owner(client) -> User:  # type: ignore[no-untyped-def]
    roles = create_default_roles(client)
    return ClientStaffUserFactory(client=client, role=roles["Owner"])


def _per_segment_route():  # type: ignore[no-untyped-def]
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client,
            kyb_status=Business.KybStatus.APPROVED,
            fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT,
        )
        route = RouteFactory(client=client, business=business)
        stops = []
        for i in range(2):
            stop = StopFactory(client=client, business=business, name=f"Stop {i + 1}")
            RouteStopFactory(client=client, route=route, stop=stop, sequence=i + 1)
            stops.append(stop)
    return client, business, route, stops


def _url(route, trip_class: str) -> str:  # type: ignore[no-untyped-def]
    path = reverse("route-fare-matrix", kwargs={"pk": str(route.id)})
    return f"{path}?trip_class={trip_class}"


def _bare_url(route) -> str:  # type: ignore[no-untyped-def]
    return reverse("route-fare-matrix", kwargs={"pk": str(route.id)})


def _one_cell(stops, amount: str) -> dict:  # type: ignore[no-untyped-def]
    return {
        "cells": [
            {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": amount}
        ]
    }


# --- The parameter is required ------------------------------------------


def test_get_without_a_class_is_a_400() -> None:
    """Not a silent read of the wildcard grid. A caller that does not
    say which class it means is a caller about to render one class's
    prices under another's heading."""
    client, _business, route, _stops = _per_segment_route()

    response = _auth_client(_owner(client)).get(_bare_url(route))

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_put_without_a_class_is_a_400() -> None:
    """The dangerous half. Spec 12's rule is that the grid submits only
    edited cells, because a stale null would *close* a rule another
    operator created; a defaulted class would widen that blast radius to
    the wrong grid entirely."""
    client, _business, route, stops = _per_segment_route()

    response = _auth_client(_owner(client)).put(
        _bare_url(route), _one_cell(stops, "200.00"), format="json"
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    with tenant_context(str(client.id)):
        assert not FareSegmentRule.objects.filter(route=route).exists()


def test_an_unknown_class_is_a_400() -> None:
    client, _business, route, _stops = _per_segment_route()

    response = _auth_client(_owner(client)).get(_url(route, "first_class"))

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_the_empty_string_is_a_legal_explicit_value() -> None:
    """The wildcard grid has to stay reachable — it is where every
    pre-spec-15 price lives."""
    client, _business, route, _stops = _per_segment_route()

    response = _auth_client(_owner(client)).get(_url(route, ANY_TRIP_CLASS))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["trip_class"] == ANY_TRIP_CLASS


# --- Isolation between grids --------------------------------------------


def test_a_save_writes_only_into_the_named_class() -> None:
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    response = api.put(_url(route, PREMIUM), _one_cell(stops, "400.00"), format="json")

    assert response.status_code == status.HTTP_200_OK
    assert response.data["created"] == 1
    with tenant_context(str(client.id)):
        rule = FareSegmentRule.objects.get(route=route)
    assert rule.trip_class == PREMIUM


def test_saving_one_class_leaves_another_classs_grid_untouched() -> None:
    """The isolation that matters. A Premium price change must not
    supersede, close, or otherwise disturb the wildcard rule every other
    class is still pricing from."""
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    api.put(_url(route, ANY_TRIP_CLASS), _one_cell(stops, "200.00"), format="json")
    api.put(_url(route, PREMIUM), _one_cell(stops, "400.00"), format="json")

    with tenant_context(str(client.id)):
        wildcard = FareSegmentRule.objects.get(route=route, trip_class=ANY_TRIP_CLASS)
        premium = FareSegmentRule.objects.get(route=route, trip_class=PREMIUM)

    assert wildcard.effective_to is None, "the wildcard rule was closed by a Premium save"
    assert str(wildcard.amount) == "200.00"
    assert str(premium.amount) == "400.00"


def test_a_class_grid_does_not_inherit_the_wildcards_prices() -> None:
    """`get_fare()` falls back to the wildcard, and the grid deliberately
    does not. Showing an inherited price as if it were set on this grid
    would make a save supersede a rule the operator never looked at."""
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    api.put(_url(route, ANY_TRIP_CLASS), _one_cell(stops, "200.00"), format="json")
    response = api.get(_url(route, PREMIUM))

    assert response.status_code == status.HTTP_200_OK
    assert [cell["amount"] for cell in response.data["cells"]] == [None]


def test_blanking_a_cell_closes_only_that_classs_rule() -> None:
    client, _business, route, stops = _per_segment_route()
    api = _auth_client(_owner(client))

    api.put(_url(route, ANY_TRIP_CLASS), _one_cell(stops, "200.00"), format="json")
    api.put(_url(route, PREMIUM), _one_cell(stops, "400.00"), format="json")
    response = api.put(
        _url(route, PREMIUM),
        {
            "cells": [
                {"from_stop": str(stops[0].id), "to_stop": str(stops[1].id), "amount": None}
            ]
        },
        format="json",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["closed"] == 1
    with tenant_context(str(client.id)):
        wildcard = FareSegmentRule.objects.get(route=route, trip_class=ANY_TRIP_CLASS)
        premium = FareSegmentRule.objects.get(route=route, trip_class=PREMIUM)

    assert wildcard.effective_to is None
    assert premium.effective_to is not None
