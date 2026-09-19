"""apps.scheduling.services.resolve_bookable_trip_across_clients — the
one place apps.marketplace resolves a single Trip across Clients. See
docs/adr/0009 and docs/specs/22-marketplace.md."""

import pytest

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.network.models import Route
from apps.network.tests.factories import RouteFactory

from ..models import Trip
from ..services import TripNotBookable, resolve_bookable_trip_across_clients
from .factories import TripFactory

pytestmark = pytest.mark.django_db


def test_resolves_a_trip_belonging_to_a_different_client_entirely() -> None:
    other_client = ClientFactory()
    with tenant_context(str(other_client.id)):
        trip = TripFactory(client=other_client)

    # Deliberately outside any tenant_context.
    resolved = resolve_bookable_trip_across_clients(trip_id=str(trip.id))

    assert resolved.id == trip.id


def test_raises_for_a_non_scheduled_trip() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        trip = TripFactory(client=client, status=Trip.Status.IN_PROGRESS)

    with pytest.raises(TripNotBookable):
        resolve_bookable_trip_across_clients(trip_id=str(trip.id))


def test_raises_for_a_pay_as_you_go_trip() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        trip = TripFactory(
            client=client, fare_collection_mode=Business.FareCollectionMode.PAY_AS_YOU_GO
        )

    with pytest.raises(TripNotBookable):
        resolve_bookable_trip_across_clients(trip_id=str(trip.id))


def test_raises_for_a_trip_on_a_non_active_route() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, status=Route.Status.DRAFT)
        trip = TripFactory(client=client, route=route, business=route.business)

    with pytest.raises(TripNotBookable):
        resolve_bookable_trip_across_clients(trip_id=str(trip.id))


def test_raises_for_a_trip_whose_business_kyb_is_not_approved() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, kyb_status=Business.KybStatus.SUBMITTED)
        route = RouteFactory(client=client, business=business)
        trip = TripFactory(client=client, route=route, business=business)

    with pytest.raises(TripNotBookable):
        resolve_bookable_trip_across_clients(trip_id=str(trip.id))


def test_raises_for_an_unknown_trip_id() -> None:
    with pytest.raises(TripNotBookable):
        resolve_bookable_trip_across_clients(trip_id="00000000-0000-0000-0000-000000000000")
