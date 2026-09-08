"""Cross-client isolation and permissions —
docs/specs/16-operational-analytics.md.

Run against **every** endpoint rather than one, per that spec's own
test plan. An aggregate is the worst possible place to leak another
Client's numbers: unlike a list, there is no row to notice, just a
total that is quietly too large.
"""

from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework import status

from apps.clients.tests.factories import ClientFactory
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory

from .helpers import as_decimal, auth_client, business_for, pay_a_booking

pytestmark = pytest.mark.django_db


def _endpoints(trip_id):  # type: ignore[no-untyped-def]
    return [
        reverse("analytics-dashboard"),
        reverse("analytics-revenue"),
        reverse("analytics-payment-summary"),
        reverse("analytics-trip-performance", kwargs={"pk": str(trip_id)}),
    ]


def test_no_endpoint_reports_another_clients_money() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_b = business_for(client_b)
    booking_b, _intent = pay_a_booking(
        client_b, business_b, amount="9999.00", idempotency_key="k-b"
    )
    staff_a = ClientStaffUserFactory(client=client_a)
    api = auth_client(staff_a)

    dashboard = api.get(reverse("analytics-dashboard"))
    revenue = api.get(reverse("analytics-revenue"))
    summary = api.get(reverse("analytics-payment-summary"))

    assert dashboard.data["money"] == []
    assert dashboard.data["bookings"]["total"] == 0
    assert dashboard.data["recent_transactions"] == []
    assert revenue.data["money"] == []
    assert revenue.data["by_route"] == []
    assert summary.data["counts"]["total"] == 0
    # And the other Client's trip is not even addressable.
    performance = api.get(
        reverse("analytics-trip-performance", kwargs={"pk": str(booking_b.trip_id)})
    )
    assert performance.status_code == status.HTTP_404_NOT_FOUND


def test_a_clients_own_numbers_are_unaffected_by_a_neighbours_volume() -> None:
    """The other half of the same guarantee: isolation must not be
    achieved by returning nothing to anybody."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_a = business_for(client_a)
    business_b = business_for(client_b)
    pay_a_booking(client_a, business_a, amount="1000.00", idempotency_key="k-a")
    pay_a_booking(client_b, business_b, amount="9999.00", idempotency_key="k-b")
    staff_a = ClientStaffUserFactory(client=client_a)

    money = auth_client(staff_a).get(reverse("analytics-revenue")).data["money"]

    assert len(money) == 1
    assert as_decimal(money[0]["gross"]) == Decimal("1000.00")


def test_the_staff_preset_cannot_read_analytics() -> None:
    """`analytics.view` is withheld from Staff on purpose: revenue
    totals are a different sensitivity from the operational lists Staff
    needs (spec 16's own reasoning, asserted here because a later "tidy"
    of the preset would otherwise pass every other test)."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])
    api = auth_client(staff)

    assert api.get(reverse("analytics-dashboard")).status_code == status.HTTP_403_FORBIDDEN
    assert api.get(reverse("analytics-revenue")).status_code == status.HTTP_403_FORBIDDEN
    assert (
        api.get(
            reverse("analytics-trip-performance", kwargs={"pk": str(booking.trip_id)})
        ).status_code
        == status.HTTP_403_FORBIDDEN
    )


def test_the_staff_preset_can_still_read_the_payments_summary() -> None:
    """It is gated on `payments.view`, not `analytics.view` — it
    describes exactly the rows `GET /payments/` returns, which Staff may
    already read. Gating it harder would leave a metrics strip above a
    table the same user can see."""
    client = ClientFactory()
    business_for(client)
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = auth_client(staff).get(reverse("analytics-payment-summary"))

    assert response.status_code == status.HTTP_200_OK


def test_the_manager_preset_can_read_everything() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    roles = create_default_roles(client)
    manager = ClientStaffUserFactory(client=client, role=roles["Manager"])
    api = auth_client(manager)

    for url in _endpoints(booking.trip_id):
        assert api.get(url).status_code == status.HTTP_200_OK, url


def test_every_endpoint_requires_authentication() -> None:
    from rest_framework.test import APIClient

    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    anonymous = APIClient()

    for url in _endpoints(booking.trip_id):
        assert anonymous.get(url).status_code == status.HTTP_401_UNAUTHORIZED, url
