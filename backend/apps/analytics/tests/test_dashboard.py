"""The dashboard envelope — docs/specs/16-operational-analytics.md."""

import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.incidents.models import Incident
from apps.incidents.tests.factories import IncidentFactory
from apps.scheduling.models import Trip

from .helpers import as_decimal, auth_client, business_for, pay_a_booking

pytestmark = pytest.mark.django_db


def _dashboard(staff, **params):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(reverse("analytics-dashboard"), params)


def test_the_whole_dashboard_arrives_in_one_request() -> None:
    """One envelope rather than a dozen endpoints the client fans out to
    and reduces locally — that pattern is the source of four production
    bugs recorded in CLAUDE.md, and here it would produce silently wrong
    totals."""
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff, business=str(business.id))

    assert response.status_code == status.HTTP_200_OK
    assert set(response.data) == {
        "period",
        "routes",
        "trips",
        "bookings",
        "incidents",
        "money",
        "trends",
        "recent_incidents",
        "recent_transactions",
    }


def test_the_incidents_keys_are_zero_and_empty_with_nothing_reported() -> None:
    """Both keys shipped one spec early as a hardcoded zero, precisely so
    filling them in (docs/specs/17-incidents.md) would be additive rather
    than a breaking envelope change. This is the empty case; the two
    below are the real ones."""
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff)

    assert response.data["incidents"] == {"open": 0}
    assert response.data["recent_incidents"] == []


def test_the_open_incident_count_excludes_resolved_and_closed() -> None:
    """"Open" is `apps.incidents.models.OPEN_STATUSES` — open,
    acknowledged or investigating — not the literal `open` status alone.
    The queue's own `open_only` filter reads the same constant, so the
    stat and the list beneath it cannot disagree."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        for value in Incident.Status.values:
            IncidentFactory(client=client, business=business, status=value)

    response = _dashboard(staff, business=str(business.id))

    assert response.data["incidents"]["open"] == 3


def test_recent_incidents_carry_what_the_dashboard_strip_renders() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        IncidentFactory(
            client=client,
            business=business,
            reference="INC-RECENT",
            title="Reader dark",
            severity=Incident.Severity.HIGH,
        )

    recent = _dashboard(staff, business=str(business.id)).data["recent_incidents"]

    assert len(recent) == 1
    assert recent[0]["reference"] == "INC-RECENT"
    assert recent[0]["severity"] == Incident.Severity.HIGH


def test_another_clients_incidents_are_not_counted() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    business_a = business_for(client_a)
    business_b = business_for(client_b)
    with tenant_context(str(client_b.id)):
        IncidentFactory(client=client_b, business=business_b)
        IncidentFactory(client=client_b, business=business_b)
    with tenant_context(str(client_a.id)):
        IncidentFactory(client=client_a, business=business_a)
    staff_a = ClientStaffUserFactory(client=client_a)

    response = _dashboard(staff_a)

    assert response.data["incidents"]["open"] == 1


def test_counts_break_down_by_status_rather_than_totalling() -> None:
    """The period is named explicitly, and that is not incidental.

    Trip counts narrow on `service_date`, and the shared fixture seeds a
    departure a few hours from now — which lands on **tomorrow** whenever
    this runs late in the day, putting it outside a default window that
    ends today. Left implicit, this test passed every morning and failed
    every evening; found on a `--create-db` run at 20:00 while building
    slice 4.
    """
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(
        staff,
        business=str(business.id),
        date_to=(timezone.now().date() + datetime.timedelta(days=2)).isoformat(),
    )

    assert response.data["bookings"]["paid"] == 1
    assert response.data["bookings"]["total"] == 1
    assert response.data["trips"]["scheduled"] == 1
    assert response.data["routes"]["active"] == 1


def test_completed_today_is_counted_outside_the_selected_period() -> None:
    """"How is today going" is a different question from "how did this
    range go", and a dashboard is asked both at once — so a period that
    excludes today must not zero it."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with tenant_context(str(client.id)):
        Trip.objects.filter(pk=booking.trip_id).update(
            status=Trip.Status.COMPLETED,
            # **The Business's today, not UTC's.** `completed_today`
            # resolves "today" in `Business.timezone` (see
            # `_local_today`), and `timezone.now().date()` is a UTC date
            # — so for any Business east of Greenwich the two disagree
            # for the first hours of local day, and this test failed
            # between 00:00 and 01:00 WAT every night while passing all
            # day. The trap CLAUDE.md already records for trip counts,
            # in a test that asserts one.
            service_date=timezone.now().astimezone(ZoneInfo(business.timezone)).date(),
        )
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(
        staff, business=str(business.id), date_from="2020-01-01", date_to="2020-01-31"
    )

    assert response.data["trips"]["completed"] == 0
    assert response.data["trips"]["completed_today"] == 1


def test_money_is_a_list_keyed_by_currency() -> None:
    client = ClientFactory()
    ngn = business_for(client, currency="NGN")
    bwp = business_for(client, currency="BWP")
    pay_a_booking(client, ngn, amount="1000.00", idempotency_key="k-ngn")
    pay_a_booking(client, bwp, amount="200.00", idempotency_key="k-bwp")
    staff = ClientStaffUserFactory(client=client)

    money = _dashboard(staff).data["money"]

    assert sorted(row["currency"] for row in money) == ["BWP", "NGN"]


def test_recent_transactions_report_wallet_as_a_channel() -> None:
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel="ussd", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    recent = _dashboard(staff, business=str(business.id)).data["recent_transactions"]

    assert len(recent) == 1
    assert recent[0]["channel"] == "ussd"
    assert as_decimal(recent[0]["amount"]) == Decimal("1000.00")


def test_an_empty_dashboard_is_zeros_with_a_period_not_a_blank() -> None:
    client = ClientFactory()
    business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _dashboard(staff)

    assert response.data["money"] == []
    assert response.data["bookings"]["total"] == 0
    assert response.data["period"]["timezone"] == "Africa/Lagos"


def test_every_money_field_is_a_decimal_string_not_a_float() -> None:
    """The contract the generated `schema.ts` already declares.

    These endpoints return plain dicts, so nothing coerces their values
    the way a `ModelSerializer` field does: a bare `Decimal` reaches
    DRF's JSON encoder and leaves as a **float**. That is how slice 2
    originally shipped, and it went unnoticed until slice 3's dashboard
    became the first consumer — `formatMoney` takes a decimal string and
    rendered `NGN 2850` for `2850.0`, dropping cents while the frontend's
    generated type asserted the field was a string.

    Asserted structurally, over every money-shaped key in the whole
    envelope, rather than one field at a time: a new aggregate added
    later gets this for free, which is exactly what the per-field version
    would not have given.
    """
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1234.50", channel="card", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    data = _dashboard(staff, business=str(business.id)).data

    money_keys = {
        "revenue",
        "gross",
        "commission",
        "average_ticket_value",
        "amount",
        "collected",
    }
    checked = 0

    def walk(node: object, path: str) -> None:
        nonlocal checked
        if isinstance(node, dict):
            for key, value in node.items():
                # `trends.revenue` is a list of points, not an amount —
                # the name collides, so the shape decides.
                if key in money_keys and not isinstance(value, (dict, list)):
                    assert isinstance(value, str), f"{path}.{key} is {type(value).__name__}"
                    # And a real decimal, not "1234.5" or "1.2345e3".
                    assert Decimal(value) == Decimal(value).quantize(Decimal("0.01"))
                    checked += 1
                else:
                    walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, f"{path}[{index}]")

    walk(data, "dashboard")
    # The fixture guarantees money, a trend point and a recent
    # transaction, so a walk that silently found nothing would be a bug
    # in this test rather than a pass.
    assert checked >= 6
