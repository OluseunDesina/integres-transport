"""The transactions metrics strip — docs/specs/16-operational-analytics.md.

`test_the_summary_and_the_list_describe_the_same_rows` is the one that
makes every number on that screen trustworthy: it is what "a metric and
its table cannot disagree" means in practice, and it is asserted rather
than argued because the shared filter module is the only thing enforcing
it.
"""

from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework import status

from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import ClientStaffUserFactory
from apps.payments.models import PaymentIntent

from .helpers import (
    as_decimal,
    auth_client,
    business_for,
    fund_wallet,
    pay_a_booking,
    pay_a_booking_partly_from_wallet,
)

pytestmark = pytest.mark.django_db


def _summary(staff, **params):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(reverse("analytics-payment-summary"), params)


def _payments(staff, **params):  # type: ignore[no-untyped-def]
    return auth_client(staff).get(reverse("payment-list-create"), params)


def test_the_summary_and_the_list_describe_the_same_rows() -> None:
    """Includes a **blended** payment on purpose.

    `PaymentIntent.amount` is the Paystack leg only; the wallet half is
    in `wallet_component_amount`. A parity check that summed `amount`
    alone would pass against card-only fixtures and be wrong about every
    blended payment — which is exactly the mistake a hand-written
    reconciliation of this endpoint made against the real dev database,
    where it reported a 50.00 gap that turned out to be the checker's
    error rather than the endpoint's.
    """
    client = ClientFactory()
    business = business_for(client)
    first, _intent = pay_a_booking(
        client, business, amount="1000.00", channel="card", idempotency_key="k1"
    )
    fund_wallet(client, business, first.passenger, "300.00")
    pay_a_booking_partly_from_wallet(
        client, business, first.passenger, amount="500.00", idempotency_key="k2"
    )
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id), "status": "succeeded"}
    summary = _summary(staff, **filters)
    listing = _payments(staff, limit=100, **filters)

    assert summary.status_code == status.HTTP_200_OK
    assert listing.status_code == status.HTTP_200_OK
    assert summary.data["counts"]["total"] == listing.data["count"]
    listed_total = sum(
        Decimal(row["amount"]) + Decimal(row["wallet_component_amount"])
        for row in listing.data["results"]
    )
    collected = sum(as_decimal(row["collected"]) for row in summary.data["money"])
    assert collected == listed_total
    # The blended row is genuinely split, so a summary that ignored the
    # wallet leg would differ here rather than coincidentally agree.
    assert any(
        Decimal(row["wallet_component_amount"]) > 0 for row in listing.data["results"]
    )


def test_channel_amounts_always_sum_to_what_was_collected() -> None:
    """The invariant that makes the breakdown readable beside the total.

    It holds under a channel filter too, which has a consequence worth
    knowing: filtering to `channel=card` still shows a `wallet` slice
    when one of the selected payments was blended. That is not a leak of
    unfiltered rows — the filter selects *payments*, and the breakdown
    decomposes the payments it selected by the methods they actually
    used. Suppressing the wallet slice would break this sum.
    """
    client = ClientFactory()
    business = business_for(client)
    first, _intent = pay_a_booking(
        client, business, amount="1000.00", channel="card", idempotency_key="k1"
    )
    fund_wallet(client, business, first.passenger, "300.00")
    pay_a_booking_partly_from_wallet(
        client, business, first.passenger, amount="500.00", idempotency_key="k2"
    )
    staff = ClientStaffUserFactory(client=client)

    for params in ({}, {"channel": "card"}):
        data = _summary(staff, business=str(business.id), **params).data
        collected = sum(as_decimal(row["collected"]) for row in data["money"])
        channelled = sum(as_decimal(row["amount"]) for row in data["channels"])
        assert channelled == collected, params


def test_a_channel_filter_narrows_both_surfaces_identically() -> None:
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel="card", idempotency_key="k1")
    pay_a_booking(client, business, amount="500.00", channel="ussd", idempotency_key="k2")
    staff = ClientStaffUserFactory(client=client)

    filters = {"business": str(business.id), "channel": "ussd"}
    summary = _summary(staff, **filters)
    listing = _payments(staff, limit=100, **filters)

    assert summary.data["counts"]["total"] == 1
    assert listing.data["count"] == 1
    assert listing.data["results"][0]["channel"] == "ussd"


def test_a_blank_channel_is_reported_as_unknown_never_guessed() -> None:
    """Every payment predating spec 16 slice 1 has one, and inventing
    `card` for them would be inventing data."""
    client = ClientFactory()
    business = business_for(client)
    pay_a_booking(client, business, amount="1000.00", channel=None, idempotency_key="k1")
    staff = ClientStaffUserFactory(client=client)

    channels = _summary(staff, business=str(business.id)).data["channels"]

    assert [row["channel"] for row in channels] == ["unknown"]
    assert as_decimal(channels[0]["amount"]) == Decimal("1000.00")


def test_a_wallet_paid_booking_appears_under_wallet_not_unknown() -> None:
    """A booking paid entirely from a balance never reaches Paystack, so
    it has no PSP channel at all. A bare `GROUP BY channel` would report
    wallet spend as zero — the exact under-reporting the spec calls
    out."""
    from apps.payments.services import pay_booking_from_wallet
    from apps.payments.tests.booking_helpers import booking_with_a_held_seat

    client = ClientFactory()
    business = business_for(client)
    first, _intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    fund_wallet(client, business, first.passenger, "5000.00")
    second, _reservation = booking_with_a_held_seat(
        client, business, amount="750.00", passenger=first.passenger
    )
    with tenant_context(str(client.id)):
        pay_booking_from_wallet(booking=second, passenger=first.passenger)
    staff = ClientStaffUserFactory(client=client)

    channels = {
        row["channel"]: row for row in _summary(staff, business=str(business.id)).data["channels"]
    }

    assert "wallet" in channels
    assert as_decimal(channels["wallet"]["amount"]) == Decimal("750.00")


def test_counts_break_out_manual_refund_as_its_own_facet() -> None:
    """There is no refund service, so nothing is netted off
    automatically — this is a queue of things a human still has to
    reconcile, not a payment status."""
    client = ClientFactory()
    business = business_for(client)
    _booking, intent = pay_a_booking(client, business, amount="1000.00", idempotency_key="k1")
    with tenant_context(str(client.id)):
        PaymentIntent.objects.filter(pk=intent.pk).update(requires_manual_refund=True)
    staff = ClientStaffUserFactory(client=client)

    counts = _summary(staff, business=str(business.id)).data["counts"]

    assert counts["requires_manual_refund"] == 1
    assert counts["succeeded"] == 1


def test_an_empty_period_returns_zeroed_counts_and_the_period() -> None:
    client = ClientFactory()
    business = business_for(client)
    staff = ClientStaffUserFactory(client=client)

    response = _summary(staff, business=str(business.id))

    assert response.data["counts"]["total"] == 0
    assert response.data["money"] == []
    assert response.data["period"]["from"] is not None
