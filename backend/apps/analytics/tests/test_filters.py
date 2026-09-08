"""The shared filter set — docs/specs/16-operational-analytics.md.

These are the guards that turn a nonsensical request into a 400 a
caller can act on, rather than into an empty or enormous result.
"""

from datetime import timedelta

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory

from .helpers import auth_client, business_for

pytestmark = pytest.mark.django_db


def _dashboard(staff, **params):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(reverse("analytics-dashboard"), params)


def test_the_default_period_is_a_rolling_thirty_days() -> None:
    """Rolling, not calendar-aligned: a dashboard loaded on the 1st of
    the month must still show a month of trend rather than one point."""
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff)

    assert response.status_code == status.HTTP_200_OK
    period = response.data["period"]
    assert (period["to"] - period["from"]).days == 29


def test_date_from_after_date_to_is_a_400() -> None:
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff, date_from="2026-09-10", date_to="2026-09-01")

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "date_from" in response.data


def test_a_range_too_long_for_daily_buckets_names_the_coarser_granularity() -> None:
    """The spec's own wording — "asking for a coarser granularity" —
    only helps if the message says which one."""
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)
    today = timezone.now().date()

    response = _dashboard(
        staff, date_from=(today - timedelta(days=200)).isoformat(), date_to=today.isoformat()
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "granularity=week" in str(response.data["granularity"])


def test_the_same_range_is_accepted_at_a_coarser_granularity() -> None:
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)
    today = timezone.now().date()

    response = _dashboard(
        staff,
        date_from=(today - timedelta(days=200)).isoformat(),
        date_to=today.isoformat(),
        granularity="week",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["period"]["granularity"] == "week"


def test_the_longest_granularity_asks_for_a_narrower_range_instead() -> None:
    """`month` has no coarser successor, so the message must not promise
    one that does not exist."""
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)
    today = timezone.now().date()

    response = _dashboard(
        staff,
        date_from=(today - timedelta(days=3000)).isoformat(),
        date_to=today.isoformat(),
        granularity="month",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    message = str(response.data["granularity"])
    assert "Narrow the range" in message
    assert "granularity=" not in message


def test_another_clients_business_is_a_400_not_an_empty_result() -> None:
    """A silently empty aggregate is the worse failure: it looks like
    "no revenue" rather than "you cannot see that"."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        other_business = BusinessFactory(client=client_b)
    staff = ClientStaffUserFactory(client=client_a)

    response = _dashboard(staff, business=str(other_business.id))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "business" in response.data


def test_a_route_from_another_business_is_rejected() -> None:
    client = ClientFactory()
    business_a = business_for(client)
    business_b = business_for(client)
    from apps.network.tests.factories import RouteFactory

    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business_b)
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff, business=str(business_a.id), route=str(route.id))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "route" in response.data


def test_one_business_resolves_its_own_timezone() -> None:
    client = ClientFactory()
    business = business_for(client, tz="Africa/Gaborone")
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff, business=str(business.id))

    assert response.data["period"]["timezone"] == "Africa/Gaborone"


def test_a_client_spanning_two_timezones_falls_back_to_utc_and_says_so() -> None:
    """There is no correct local day for a Client operating in Lagos and
    Gaborone at once. Picking one silently would put revenue in the
    wrong day for the other, so the envelope reports what was used."""
    client = ClientFactory()
    business_for(client, tz="Africa/Lagos")
    business_for(client, tz="Africa/Gaborone")
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff)

    assert response.data["period"]["timezone"] == "UTC"


def test_a_single_timezone_client_uses_it_without_naming_a_business() -> None:
    client = ClientFactory()
    business_for(client, tz="Africa/Lagos")
    business_for(client, tz="Africa/Lagos")
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff)

    assert response.data["period"]["timezone"] == "Africa/Lagos"
