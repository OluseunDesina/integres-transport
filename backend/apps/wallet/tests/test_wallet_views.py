"""HTTP-level tests for GET /wallet/mine/ and GET /wallet/."""

from decimal import Decimal
from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.ledger.models import LedgerAccount
from apps.payments.services import initiate_payment
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.payments.tests.factories import PaystackAccountFactory
from apps.payments.tests.webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_wallet_mine_for_a_passenger_with_no_activity_is_zero_and_creates_no_row() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("wallet-mine"), {"business": str(business.id)})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["balance"] == "0.00"
    assert response.data["transactions"] == []
    with tenant_context(str(client.id)):
        assert LedgerAccount.objects.filter(business=business, passenger=passenger).count() == 0


def test_wallet_mine_requires_the_business_query_param() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("wallet-mine"))
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_wallet_mine_stays_empty_after_a_plain_card_payment() -> None:
    """Phase 7 (docs/specs/7-passenger-wallet.md): a fresh Paystack card
    charge for a booking debits `psp_suspense`, not the passenger's
    wallet — no real balance was ever spent, so the wallet view must
    stay untouched, not show a spurious negative balance."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="120.00")
    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment(
            booking=booking, passenger=booking.passenger, idempotency_key="init-1"
        )
    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference)
    )
    APIClient().post(
        reverse("paystack-webhook"),
        data=raw_body,
        content_type="application/json",
        HTTP_X_PAYSTACK_SIGNATURE=signature,
    )

    response = _auth_client(booking.passenger).get(
        reverse("wallet-mine"), {"business": str(business.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    assert Decimal(response.data["balance"]) == Decimal("0.00")
    assert len(response.data["transactions"]) == 0


def test_wallet_lookup_requires_the_wallet_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(passenger).get(
        reverse("wallet-lookup"), {"business": str(business.id), "passenger": str(passenger.id)}
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_staff_with_wallet_view_can_look_up_a_passengers_wallet() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)

    response = _auth_client(staff).get(
        reverse("wallet-lookup"), {"business": str(business.id), "passenger": str(passenger.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["balance"] == "0.00"
