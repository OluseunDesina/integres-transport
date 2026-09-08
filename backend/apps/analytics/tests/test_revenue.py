"""Revenue aggregation — docs/specs/16-operational-analytics.md.

The tests that matter most in this spec are here: revenue must
reconcile against the ledger computed independently, must never sum
across currencies, and must return the same total whether or not the
reader can see the platform commission account.
"""

from decimal import Decimal

import pytest
from django.db.models import Sum
from django.urls import reverse
from rest_framework import status

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.ledger.models import JournalEntry, JournalLine, LedgerAccount

from .helpers import as_decimal, auth_client, business_for, fund_wallet, pay_a_booking

pytestmark = pytest.mark.django_db


def _revenue(staff, **params):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(reverse("analytics-revenue"), params)


def test_reported_revenue_equals_the_clearing_account_lines_for_the_period() -> None:
    """Computed independently in the test, from the ledger the payment
    handler actually wrote — not from the same code path the endpoint
    uses, which would only prove it agrees with itself."""
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    pay_a_booking(client, business, amount="500.00", idempotency_key="k2")
    staff = ClientStaffUserFactory(client=client)

    response = _revenue(staff, business=str(business.id))

    assert response.status_code == status.HTTP_200_OK
    with platform_staff_bypass():
        clearing = LedgerAccount.all_objects.get(
            business=business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        )
        expected = JournalLine.all_objects.filter(
            account=clearing, journal_entry__entry_type=JournalEntry.EntryType.PAYMENT
        ).aggregate(total=Sum("amount"))["total"]

    entry = next(row for row in response.data["money"] if row["currency"] == "NGN")
    assert as_decimal(entry["revenue"]) == expected


def test_gross_is_what_passengers_paid_and_commission_is_the_difference() -> None:
    """Both are reported rather than one: "revenue" alone is ambiguous
    on a transport dashboard, and an operator reading a gross figure as
    money they will receive is a real way to be misled."""
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    entry = next(
        row
        for row in _revenue(staff, business=str(business.id)).data["money"]
        if row["currency"] == "NGN"
    )

    assert as_decimal(entry["gross"]) == Decimal("1000.00")
    assert as_decimal(entry["revenue"]) < as_decimal(entry["gross"])
    assert as_decimal(entry["commission"]) == as_decimal(entry["gross"]) - as_decimal(
        entry["revenue"]
    )


def test_two_currencies_produce_two_entries_and_no_summed_total() -> None:
    """The single easiest way to get this feature quietly, seriously
    wrong. A Naira total added to a Pula one is not money."""
    client = ClientFactory()
    ngn = business_for(client, currency="NGN")
    bwp = business_for(client, currency="BWP")
    pay_a_booking(client, ngn, amount="1000.00", idempotency_key="k-ngn")
    pay_a_booking(client, bwp, amount="200.00", idempotency_key="k-bwp")
    staff = ClientStaffUserFactory(client=client)

    money = _revenue(staff).data["money"]

    assert sorted(row["currency"] for row in money) == ["BWP", "NGN"]
    assert as_decimal(next(r for r in money if r["currency"] == "NGN")["gross"]) == Decimal(
        "1000.00"
    )
    assert as_decimal(next(r for r in money if r["currency"] == "BWP")["gross"]) == Decimal(
        "200.00"
    )


def test_ordinary_staff_and_a_bypassed_read_report_the_same_total() -> None:
    """Spec 5 Slice 1's bug, re-asserted where it would recur: a
    `select_related` against the RLS-protected `LedgerAccount` silently
    drops journal lines referencing the platform commission account when
    an ordinary Business's staff read them. Every payment entry has such
    a line, so an aggregate that joined would under-report every one.
    """
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    as_staff = next(
        row
        for row in _revenue(staff, business=str(business.id)).data["money"]
        if row["currency"] == "NGN"
    )

    # Computed independently under a bypass, where the commission
    # account *is* visible — so a staff-side read that had dropped its
    # lines would disagree here rather than quietly under-report.
    with platform_staff_bypass():
        payment_lines = JournalLine.all_objects.filter(
            journal_entry__entry_type=JournalEntry.EntryType.PAYMENT,
            journal_entry__business=business,
        )
        expected_gross = -payment_lines.filter(amount__lt=0).aggregate(t=Sum("amount"))["t"]
        commission_account = LedgerAccount.all_objects.get(
            account_type=LedgerAccount.AccountType.INTEGRA_COMMISSION
        )
        expected_commission = payment_lines.filter(account=commission_account).aggregate(
            t=Sum("amount")
        )["t"]

    assert as_decimal(as_staff["gross"]) == expected_gross
    assert as_decimal(as_staff["commission"]) == expected_commission
    assert as_decimal(as_staff["revenue"]) == expected_gross - expected_commission
    # And the commission is genuinely non-zero, so this test would fail
    # against an aggregate that silently dropped those lines rather than
    # passing on two zeros.
    assert expected_commission > Decimal("0.00")


def test_a_wallet_top_up_is_not_counted_as_revenue() -> None:
    """Funding a balance is money moving into a wallet, recognised when
    it is *spent*. Counting both would double-count every wallet-paid
    trip."""
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    before = next(
        row
        for row in _revenue(staff, business=str(business.id)).data["money"]
        if row["currency"] == "NGN"
    )
    fund_wallet(client, business, booking.passenger, "5000.00")
    after = next(
        row
        for row in _revenue(staff, business=str(business.id)).data["money"]
        if row["currency"] == "NGN"
    )

    assert after["gross"] == before["gross"]
    assert after["revenue"] == before["revenue"]


def test_the_trend_emits_only_buckets_that_have_data() -> None:
    """A zero-revenue day and a day before the Business existed must not
    render identically — the client draws gaps, so the series carries
    no invented zeros."""
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    trend = _revenue(staff, business=str(business.id)).data["trend"]

    assert len(trend) == 1
    assert trend[0]["currency"] == "NGN"


def test_an_empty_period_returns_zeros_and_still_echoes_the_period() -> None:
    """The distinction the envelope exists for: "no revenue in this
    range" is a different answer from "no data at all", and a screen
    cannot draw an empty state honestly without it."""
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _revenue(staff, business=str(business.id))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["money"] == []
    assert response.data["trend"] == []
    assert response.data["period"]["timezone"] == "Africa/Lagos"


def test_revenue_breaks_down_by_route_and_trip_class() -> None:
    client = ClientFactory()
    business = business_for(client)
    booking, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    response = _revenue(staff, business=str(business.id))

    by_route = response.data["by_route"]
    assert len(by_route) == 1
    assert by_route[0]["route"] == booking.trip.route.name
    assert as_decimal(by_route[0]["amount"]) == Decimal("1000.00")

    by_class = response.data["by_trip_class"]
    assert by_class[0]["trip_class"] == booking.trip.trip_class
