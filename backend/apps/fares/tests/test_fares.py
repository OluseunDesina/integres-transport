import uuid
from decimal import Decimal

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
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory

from ..services import FareNotConfigured, get_fare
from .factories import FareRuleFactory, FareSegmentRuleFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _approved_business(client: object, **overrides: object) -> Business:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return BusinessFactory(client=client, kyb_status=Business.KybStatus.APPROVED, **overrides)


def _route(client: object, **overrides: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return RouteFactory(client=client, **overrides)


def _fare_rule(client: object, **overrides: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return FareRuleFactory(client=client, **overrides)


def _fare_segment_rule(client: object, **overrides: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return FareSegmentRuleFactory(client=client, **overrides)


def _trip(client: object, **overrides: object):  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return TripFactory(client=client, **overrides)


# --- get_fare service --------------------------------------------------


def test_get_fare_flat_mode_returns_the_active_rules_amount() -> None:
    client = ClientFactory()
    trip = _trip(client)
    with tenant_context(str(client.id)):
        rule = FareRuleFactory(
            client=client, route=trip.route, business=trip.business, amount="750.00"
        )
        stop_a = StopFactory(client=client, business=trip.business)
        stop_b = StopFactory(client=client, business=trip.business)
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)
    assert quote.amount == Decimal("750.00")
    assert quote.currency == trip.business.currency
    assert quote.fare_rule == rule
    assert quote.fare_segment_rule is None


def test_get_fare_flat_mode_raises_when_no_rule_is_configured() -> None:
    client = ClientFactory()
    trip = _trip(client)
    with tenant_context(str(client.id)):
        stop_a = StopFactory(client=client, business=trip.business)
        stop_b = StopFactory(client=client, business=trip.business)
        with pytest.raises(FareNotConfigured):
            get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)


def test_get_fare_per_segment_mode_returns_the_matching_rules_amount() -> None:
    client = ClientFactory()
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            amount="120.00",
        )
        trip = TripFactory(client=client, route=route, business=business)
        quote = get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)
    assert quote.amount == Decimal("120.00")
    assert quote.fare_segment_rule is not None
    assert quote.fare_rule is None


def test_get_fare_per_segment_mode_raises_when_segment_is_not_configured() -> None:
    client = ClientFactory()
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        trip = TripFactory(client=client, route=route, business=business)
        with pytest.raises(FareNotConfigured):
            get_fare(trip=trip, from_stop=stop_a, to_stop=stop_b)


# --- FareRule endpoints --------------------------------------------------


def test_client_staff_can_create_a_flat_fare_rule() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)

    response = _auth_client(staff).post(
        reverse("fare-rule-list-create"),
        {"business": str(route.business_id), "route": str(route.id), "amount": "300.00"},
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["amount"] == "300.00"
    entry = AuditLog.objects.get(action="fare_rule.created")
    assert entry.client_id == client.id


def test_fare_rule_creation_rejected_when_business_is_not_flat_mode() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)

    response = _auth_client(staff).post(
        reverse("fare-rule-list-create"),
        {"business": str(business.id), "route": str(route.id), "amount": "300.00"},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_fare_rule_creation_rejected_for_a_route_belonging_to_another_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    other_business = _approved_business(client)

    response = _auth_client(staff).post(
        reverse("fare-rule-list-create"),
        {"business": str(other_business.id), "route": str(route.id), "amount": "300.00"},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_fare_rule_creation_rejected_for_a_route_belonging_to_another_client() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    route_b = _route(client_b)

    response = _auth_client(staff_a).post(
        reverse("fare-rule-list-create"),
        {"business": str(route_b.business_id), "route": str(route_b.id), "amount": "1.00"},
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_staff_role_user_can_list_but_not_create_fare_rules() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff_role_user = ClientStaffUserFactory(client=client, role=roles["Staff"])
    route = _route(client)

    api = _auth_client(staff_role_user)
    list_response = api.get(reverse("fare-rule-list-create"))
    create_response = api.post(
        reverse("fare-rule-list-create"),
        {"business": str(route.business_id), "route": str(route.id), "amount": "1.00"},
    )

    assert list_response.status_code == status.HTTP_200_OK
    assert create_response.status_code == status.HTTP_403_FORBIDDEN


def test_passenger_cannot_list_fare_rules() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("fare-rule-list-create"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_fare_rule_patch_supersedes_with_a_new_version_and_is_audit_logged() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    fare_rule = _fare_rule(client)

    response = _auth_client(staff).patch(
        reverse("fare-rule-update", kwargs={"pk": str(fare_rule.id)}), {"amount": "999.99"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["amount"] == "999.99"
    assert response.data["id"] != str(fare_rule.id)
    with tenant_context(str(client.id)):
        fare_rule.refresh_from_db()
        assert fare_rule.effective_to is not None
        assert fare_rule.amount == Decimal("500.00")
    superseded = AuditLog.objects.get(action="fare_rule.superseded")
    assert superseded.target_id == str(fare_rule.id)
    created = AuditLog.objects.filter(action="fare_rule.created").latest("created_at")
    assert created.metadata["amount"] == "999.99"


def test_cross_client_fare_rule_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    fare_rule_b = _fare_rule(client_b)

    response = _auth_client(staff_a).patch(
        reverse("fare-rule-update", kwargs={"pk": str(fare_rule_b.id)}), {"amount": "1.00"}
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- FareSegmentRule endpoints -------------------------------------------


def test_client_staff_can_create_a_fare_segment_rule() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)

    response = _auth_client(staff).post(
        reverse("fare-segment-rule-list-create"),
        {
            "business": str(business.id),
            "route": str(route.id),
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            "amount": "120.00",
        },
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["amount"] == "120.00"
    entry = AuditLog.objects.get(action="fare_segment_rule.created")
    assert entry.client_id == client.id


def test_fare_segment_rule_creation_rejected_when_business_is_not_per_segment_mode() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    route = _route(client)
    with tenant_context(str(client.id)):
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)

    response = _auth_client(staff).post(
        reverse("fare-segment-rule-list-create"),
        {
            "business": str(route.business_id),
            "route": str(route.id),
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            "amount": "1.00",
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_fare_segment_rule_creation_rejected_when_stops_are_not_on_the_route() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        # Deliberately not added to the route via RouteStop.

    response = _auth_client(staff).post(
        reverse("fare-segment-rule-list-create"),
        {
            "business": str(business.id),
            "route": str(route.id),
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
            "amount": "1.00",
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_fare_segment_rule_creation_rejected_when_stops_are_out_of_order() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)

    response = _auth_client(staff).post(
        reverse("fare-segment-rule-list-create"),
        {
            "business": str(business.id),
            "route": str(route.id),
            "from_stop": str(stop_b.id),
            "to_stop": str(stop_a.id),
            "amount": "1.00",
        },
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_fare_segment_rule_patch_supersedes_with_a_new_version() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    fare_segment_rule = _fare_segment_rule(client)

    response = _auth_client(staff).patch(
        reverse("fare-segment-rule-update", kwargs={"pk": str(fare_segment_rule.id)}),
        {"amount": "55.50"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["amount"] == "55.50"
    assert response.data["id"] != str(fare_segment_rule.id)
    with tenant_context(str(client.id)):
        fare_segment_rule.refresh_from_db()
        assert fare_segment_rule.effective_to is not None


def test_cross_client_fare_segment_rule_patch_is_a_404_not_a_403() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    fare_segment_rule_b = _fare_segment_rule(client_b)

    response = _auth_client(staff_a).patch(
        reverse("fare-segment-rule-update", kwargs={"pk": str(fare_segment_rule_b.id)}),
        {"amount": "1.00"},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- GET /trips/{id}/fare/ ------------------------------------------------


def test_trip_fare_endpoint_returns_the_flat_amount_for_a_passenger() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    trip = _trip(client)
    with tenant_context(str(client.id)):
        FareRuleFactory(client=client, route=trip.route, business=trip.business, amount="640.00")
        stop_a = StopFactory(client=client, business=trip.business)
        stop_b = StopFactory(client=client, business=trip.business)

    response = _auth_client(passenger).get(
        reverse("trip-fare", kwargs={"pk": str(trip.id)}),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["amount"] == "640.00"
    assert response.data["currency"] == trip.business.currency


def test_trip_fare_endpoint_returns_the_per_segment_amount() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    business = _approved_business(client, fare_pricing_mode=Business.FarePricingMode.PER_SEGMENT)
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        FareSegmentRuleFactory(
            client=client,
            route=route,
            business=business,
            from_stop=stop_a,
            to_stop=stop_b,
            amount="88.00",
        )
        trip = TripFactory(client=client, route=route, business=business)

    response = _auth_client(passenger).get(
        reverse("trip-fare", kwargs={"pk": str(trip.id)}),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["amount"] == "88.00"


def test_trip_fare_endpoint_returns_404_when_no_fare_is_configured() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    trip = _trip(client)
    with tenant_context(str(client.id)):
        stop_a = StopFactory(client=client, business=trip.business)
        stop_b = StopFactory(client=client, business=trip.business)

    response = _auth_client(passenger).get(
        reverse("trip-fare", kwargs={"pk": str(trip.id)}),
        {"from_stop": str(stop_a.id), "to_stop": str(stop_b.id)},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_trip_fare_endpoint_404s_for_another_clients_trip() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    passenger_a = PassengerUserFactory(client=client_a)
    trip_b = _trip(client_b)

    response = _auth_client(passenger_a).get(
        reverse("trip-fare", kwargs={"pk": str(trip_b.id)}),
        {"from_stop": str(uuid.uuid4()), "to_stop": str(uuid.uuid4())},
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_trip_fare_endpoint_rejects_an_unauthenticated_request() -> None:
    client = ClientFactory()
    trip = _trip(client)

    response = APIClient().get(
        reverse("trip-fare", kwargs={"pk": str(trip.id)}),
        {"from_stop": str(uuid.uuid4()), "to_stop": str(uuid.uuid4())},
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED
