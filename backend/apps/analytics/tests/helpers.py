"""Fixture builders for the analytics tests.

Every helper here produces **real rows through the real code paths** —
a booking is paid by delivering a signed webhook to the real handler,
not by writing `status="paid"` and a `JournalEntry` by hand. That
matters more here than in most suites: these tests exist to prove
reported numbers reconcile against the ledger, and a hand-built ledger
entry would let a wrong aggregation agree with an equally wrong
fixture.
"""

from __future__ import annotations

import csv
import datetime
import io
from decimal import Decimal
from typing import Any
from unittest.mock import patch

from django.urls import reverse
from django.utils import timezone
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.payments.services import initiate_payment
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.payments.tests.factories import PaystackAccountFactory
from apps.payments.tests.webhook_helpers import paystack_payload, signed_body

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


def auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def business_for(client: Any, *, currency: str = "NGN", tz: str = "Africa/Lagos") -> Any:
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client, currency=currency, timezone=tz)
        PaystackAccountFactory(client=client, business=business)
    return business


def pay_a_booking(
    client: Any,
    business: Any,
    *,
    amount: str = "1000.00",
    channel: str | None = "card",
    idempotency_key: str = "analytics-init",
) -> tuple[Any, Any]:
    """A fully paid booking and its `PaymentIntent`, produced by
    actually delivering a `charge.success` webhook.

    Returns `(booking, intent)`. The intent's `journal_entry` is set by
    the real handler, so the ledger it writes is the ledger these tests
    reconcile against.
    """
    booking, _reservation = booking_with_a_held_seat(client, business, amount=amount)
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key=idempotency_key
        )

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference, channel=channel)
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == 200
    return booking, intent


def pay_a_booking_partly_from_wallet(
    client: Any,
    business: Any,
    passenger: Any,
    *,
    amount: str,
    channel: str | None = "card",
    idempotency_key: str = "analytics-blend",
) -> tuple[Any, Any]:
    """A booking paid partly from an existing balance and partly by
    card.

    The shape that breaks any aggregate reading `amount` alone:
    `PaymentIntent.amount` is the Paystack leg *only*, and the wallet
    half lives in `wallet_component_amount`. Summing one without the
    other under-reports every blended payment.
    """
    from apps.payments.services import initiate_payment_with_wallet

    booking, _reservation = booking_with_a_held_seat(
        client, business, amount=amount, passenger=passenger
    )
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment_with_wallet(
            booking=booking, passenger=passenger, idempotency_key=idempotency_key
        )
    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference, channel=channel)
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == 200
    return booking, intent


def fund_wallet(client: Any, business: Any, passenger: Any, amount: str) -> None:
    """Credits a passenger's wallet through the real top-up webhook, so
    the ledger sees a genuine `topup` entry — which the revenue
    aggregates must then *exclude*, since funding a balance is not
    revenue."""
    from apps.payments.services import initiate_wallet_topup

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_wallet_topup(
            business=business,
            passenger=passenger,
            amount=Decimal(amount),
            idempotency_key=f"topup-{passenger.id}",
        )
    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference, channel="card")
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    assert response.status_code == 200


def today_iso() -> str:
    return timezone.now().date().isoformat()


def days_ago_iso(days: int) -> str:
    return (timezone.now().date() - datetime.timedelta(days=days)).isoformat()


def as_decimal(value: object) -> Decimal:
    """Read a money field off an analytics response.

    **Asserts the string, then converts.** These endpoints return plain
    dicts, so nothing coerces a `Decimal` on the way out and DRF's JSON
    encoder would render one as a float — which is how they originally
    shipped, contradicting the `string` the generated `schema.ts`
    declares and silently dropping cents in the frontend's `formatMoney`.
    Every money assertion in this suite goes through here so that
    regression is caught by whichever test touches the field first,
    rather than by a screen months later.
    """
    assert isinstance(value, str), f"money must be a decimal string, got {value!r}"
    return Decimal(value)


def csv_rows(response: Any) -> list[dict[str, str]]:
    """Read an export response into rows.

    **Asserts before it parses.** The content type, the attachment
    disposition and the BOM are three things every caller depends on and
    that no ordinary row assertion would notice going missing — so they
    are checked once, here, rather than in each test that happens to
    remember.

    Decodes `utf-8-sig` so the BOM (which Excel needs, and without which
    every non-ASCII route name is mojibake) is invisible to every other
    test in the suite.
    """
    assert response.status_code == 200, response.content[:400]
    assert response["Content-Type"] == "text/csv; charset=utf-8"
    assert response["Content-Disposition"].startswith('attachment; filename="')
    body = response.content.decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(body)))


def csv_text(response: Any) -> str:
    """The raw body, BOM stripped — for tests asserting on formatting
    rather than on values."""
    return response.content.decode("utf-8-sig")


def export_url(resource: str) -> str:
    return reverse("analytics-export", kwargs={"resource": resource})


def required_export_params(resource: str, *, trip_id: str | None = None) -> dict[str, str]:
    """Whatever an `ExportSpec` declares it cannot run without.

    Read off the registry rather than hard-coded per resource, so the
    parametrised tests below stay genuinely registry-driven: a resource
    added later that declares a required filter is supplied one here
    automatically instead of needing an allowlist entry — or, worse,
    being quietly excluded and never covered.
    """
    from apps.analytics.exports import EXPORTS

    values = {"trip": trip_id}
    params: dict[str, str] = {}
    for name in EXPORTS[resource].required_filters:
        value = values.get(name)
        assert value is not None, (
            f"The {resource!r} export requires ?{name}=, and this test has no "
            f"fixture for it. Add one to `required_export_params`."
        )
        params[name] = value
    return params
