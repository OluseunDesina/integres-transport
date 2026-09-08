"""Day bucketing — docs/specs/16-operational-analytics.md.

A trend chart is a claim about *which day* money arrived. Bucketing in
UTC when the operator reads the chart in Lagos silently moves every
late-night and early-morning payment into the wrong bar, and the chart
still looks entirely plausible.
"""

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from django.urls import reverse
from django.utils import timezone as django_timezone
from rest_framework import status

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.ledger.models import JournalEntry

from .helpers import as_decimal, auth_client, business_for, pay_a_booking

pytestmark = pytest.mark.django_db

LAGOS = ZoneInfo("Africa/Lagos")
UTC = ZoneInfo("UTC")


def _move_entries_to(instant: datetime) -> None:
    """`created_at` is `auto_now_add`, so the only way to place an entry
    at a chosen instant is to rewrite it afterwards."""
    with platform_staff_bypass():
        JournalEntry.all_objects.all().update(created_at=instant)


def test_a_payment_just_after_local_midnight_lands_in_the_local_day() -> None:
    """00:30 in Lagos is 23:30 UTC on the *previous* date. A UTC bucket
    puts that payment a day early — one bar too far left on every chart,
    for every payment made in the first hour of every day."""
    client = ClientFactory()
    business = business_for(client, tz="Africa/Lagos")
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    local_day = (django_timezone.now().astimezone(LAGOS) - timedelta(days=2)).date()
    just_after_midnight = datetime(
        local_day.year, local_day.month, local_day.day, 0, 30, tzinfo=LAGOS
    )
    assert just_after_midnight.astimezone(UTC).date() == local_day - timedelta(days=1)
    _move_entries_to(just_after_midnight)

    response = auth_client(staff).get(
        reverse("analytics-revenue"), {"business": str(business.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    assert [point["date"] for point in response.data["trend"]] == [local_day]


def test_a_mixed_timezone_client_buckets_in_utc_and_says_so() -> None:
    """With Businesses in two zones there is no correct local day, so
    the fallback is UTC — and the envelope reports it, because a chart
    bucketed in a timezone the reader cannot see is worse than one
    bucketed in a timezone they can."""
    client = ClientFactory()
    lagos_business = business_for(client, tz="Africa/Lagos")
    business_for(client, tz="Africa/Gaborone")
    pay_a_booking(client, lagos_business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    local_day = (django_timezone.now().astimezone(LAGOS) - timedelta(days=2)).date()
    _move_entries_to(datetime(local_day.year, local_day.month, local_day.day, 0, 30, tzinfo=LAGOS))

    response = auth_client(staff).get(reverse("analytics-revenue"))

    assert response.data["period"]["timezone"] == "UTC"
    assert [point["date"] for point in response.data["trend"]] == [
        local_day - timedelta(days=1)
    ]


def test_weekly_buckets_collapse_several_days_into_one_point() -> None:
    client = ClientFactory()
    business = business_for(client, tz="Africa/Lagos")
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    pay_a_booking(client, business, amount="500.00", idempotency_key="k2")
    staff = ClientStaffUserFactory(client=client)

    # Both entries in the same ISO week, two days apart.
    with platform_staff_bypass():
        entries = list(JournalEntry.all_objects.order_by("created_at"))
        base = django_timezone.now().astimezone(LAGOS) - timedelta(days=10)
        for offset, entry in enumerate(entries):
            JournalEntry.all_objects.filter(pk=entry.pk).update(
                created_at=base + timedelta(days=offset)
            )

    response = auth_client(staff).get(
        reverse("analytics-revenue"), {"business": str(business.id), "granularity": "week"}
    )

    assert len(response.data["trend"]) == 1
    assert as_decimal(response.data["trend"][0]["amount"]) > Decimal("0.00")
