"""`PaymentIntent.channel` capture — docs/specs/16-operational-analytics.md
slice 1.

The channel is the payment method Paystack actually used, and it exists
in exactly one place: the body of the `charge.success` webhook that
reports the charge. There is no API to ask for it after the fact and no
way to backfill it, so every one of these tests is about the single
moment it can be captured.
"""

from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context

from ..models import PaymentIntent
from ..services import initiate_payment
from .booking_helpers import booking_with_a_held_seat
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


def _pending_intent():  # type: ignore[no-untyped-def]
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        return initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key="channel-init"
        )


def _deliver(reference: str, *, channel: str | None) -> int:
    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=reference, channel=channel)
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )
    return int(response.status_code)


def test_charge_success_captures_the_channel_from_the_payload() -> None:
    intent = _pending_intent()

    assert _deliver(intent.psp_reference, channel="ussd") == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
    assert intent.channel == "ussd"
    assert intent.status == PaymentIntent.Status.SUCCEEDED


def test_a_payload_without_a_channel_leaves_it_blank_and_still_pays() -> None:
    """The shape every webhook delivered before this spec had, and the
    shape Paystack can still send. Losing a reporting label must never
    cost the payment."""
    intent = _pending_intent()

    assert _deliver(intent.psp_reference, channel=None) == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
    assert intent.channel == ""
    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.journal_entry_id is not None


def test_a_non_string_channel_is_ignored_rather_than_raising() -> None:
    """`data.channel` is a value another company controls. An
    exception here would escape into `process_paystack_webhook`, whose
    whole contract is that it never lets one out — TenancyMiddleware
    wraps the request in one transaction, so an uncaught error would
    roll back the WebhookEvent dedup row and silently defeat replay
    protection on the next identical delivery."""
    intent = _pending_intent()

    raw_body, signature = signed_body(
        {
            "event": "charge.success",
            "data": {"reference": intent.psp_reference, "channel": {"unexpected": "shape"}},
        }
    )
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )

    assert response.status_code == status.HTTP_200_OK
    with platform_staff_bypass():
        intent.refresh_from_db()
    assert intent.channel == ""
    assert intent.status == PaymentIntent.Status.SUCCEEDED


def test_an_overlong_channel_is_truncated_rather_than_failing_the_charge() -> None:
    intent = _pending_intent()

    assert _deliver(intent.psp_reference, channel="x" * 100) == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
    assert intent.channel == "x" * 32
    assert intent.status == PaymentIntent.Status.SUCCEEDED


def test_a_replayed_delivery_does_not_overwrite_the_captured_channel() -> None:
    """A second delivery under a different event row still reaches
    `_handle_charge_success`, which returns at the `status != PENDING`
    guard — before the channel is written. What the first delivery
    captured is what stands."""
    intent = _pending_intent()
    assert _deliver(intent.psp_reference, channel="card") == status.HTTP_200_OK

    # A different event_type keeps WebhookEvent's own dedup constraint
    # from short-circuiting this, so the replay genuinely reaches the
    # handler rather than being turned away one layer earlier.
    raw_body, signature = signed_body(
        {
            "event": "charge.success",
            "data": {"reference": intent.psp_reference, "channel": "bank_transfer"},
        }
    )
    with platform_staff_bypass():
        from ..models import WebhookEvent

        WebhookEvent.objects.filter(reference=intent.psp_reference).delete()
    response = APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )

    assert response.status_code == status.HTTP_200_OK
    with platform_staff_bypass():
        intent.refresh_from_db()
    assert intent.channel == "card"


def test_the_channel_is_readable_through_the_payments_list() -> None:
    """Slice 1 adds no endpoint, but the field is exposed on the
    existing `GET /payments/` payload — otherwise this slice would only
    be verifiable in psql."""
    from apps.identity.serializers import ClientAdminTokenObtainSerializer
    from apps.identity.services import create_default_roles
    from apps.identity.tests.factories import ClientStaffUserFactory

    intent = _pending_intent()
    assert _deliver(intent.psp_reference, channel="mobile_money") == status.HTTP_200_OK

    with platform_staff_bypass():
        intent.refresh_from_db()
    roles = create_default_roles(intent.client)
    staff = ClientStaffUserFactory(client=intent.client, role=roles["Owner"])
    api = APIClient()
    api.credentials(
        HTTP_AUTHORIZATION=(
            f"Bearer {ClientAdminTokenObtainSerializer.get_token(staff).access_token}"
        )
    )

    response = api.get(reverse("payment-list-create"))

    assert response.status_code == status.HTTP_200_OK
    row = next(r for r in response.data["results"] if r["id"] == str(intent.id))
    assert row["channel"] == "mobile_money"
