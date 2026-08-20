"""Standalone wallet top-up — docs/specs/7-passenger-wallet.md.
`initiate_wallet_topup()`'s idempotency/PSP-call shape and the
`charge.success` webhook's topup write path (wallet credit,
psp_suspense debit)."""

from decimal import Decimal
from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.ledger.models import JournalEntry, LedgerAccount

from ..models import PaymentIntent
from ..services import PspNotConfigured, initiate_wallet_topup
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/topup123",
    "access_code": "topup123",
    "reference": "irrelevant",
}


def _auth_client(user):  # type: ignore[no-untyped-def]
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_initiate_wallet_topup_calls_paystack_and_creates_a_pending_intent() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)

    with (
        patch(
            "apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)
        ) as mock_init,
        tenant_context(str(client.id)),
    ):
        intent = initiate_wallet_topup(
            business=business, passenger=passenger, amount=Decimal("500.00"), idempotency_key="k1"
        )

    assert intent.intent_type == PaymentIntent.IntentType.WALLET_TOPUP
    assert intent.booking_id is None
    assert intent.wallet_business_id == business.id
    assert intent.status == PaymentIntent.Status.PENDING
    assert intent.psp_authorization_url == _FAKE_INIT_DATA["authorization_url"]
    assert mock_init.call_args.kwargs["amount"] == Decimal("500.00")
    assert mock_init.call_args.kwargs["callback_url"].endswith("/wallet")


def test_initiate_wallet_topup_returns_404_when_no_paystack_account_configured() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)

    with tenant_context(str(client.id)), pytest.raises(PspNotConfigured):
        initiate_wallet_topup(
            business=business, passenger=passenger, amount=Decimal("500.00"), idempotency_key="k1"
        )


def test_initiate_wallet_topup_is_idempotent_on_replay() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        first = initiate_wallet_topup(
            business=business, passenger=passenger, amount=Decimal("500.00"), idempotency_key="k1"
        )
        second = initiate_wallet_topup(
            business=business, passenger=passenger, amount=Decimal("500.00"), idempotency_key="k1"
        )

    assert first.id == second.id


def test_initiate_wallet_topup_rejects_a_replay_with_a_different_amount() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        initiate_wallet_topup(
            business=business, passenger=passenger, amount=Decimal("500.00"), idempotency_key="k1"
        )
        with pytest.raises(IdempotencyKeyConflict):
            initiate_wallet_topup(
                business=business,
                passenger=passenger,
                amount=Decimal("999.00"),
                idempotency_key="k1",
            )


def test_charge_success_for_a_topup_credits_the_wallet_and_debits_psp_suspense() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_wallet_topup(
            business=business, passenger=passenger, amount=Decimal("500.00"), idempotency_key="k1"
        )

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=intent.psp_reference)
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
        wallet = LedgerAccount.all_objects.get(
            business=business, passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
        )
        psp_suspense = LedgerAccount.all_objects.get(
            business=business,
            psp_provider="paystack",
            account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
        )
        # Read via the FK id, not a lazy `intent.journal_entry`
        # traversal — the same RLS+JOIN trap
        # `JournalLineNestedSerializer.account`'s own comment documents:
        # a lazy fetch outside this bypass block hits RLS again with no
        # tenancy context at all in a plain service-level test.
        journal_entry = JournalEntry.all_objects.get(pk=intent.journal_entry_id)

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.journal_entry_id is not None
    assert journal_entry.entry_type == JournalEntry.EntryType.TOPUP
    assert wallet.cached_balance == Decimal("500.00")
    assert psp_suspense.cached_balance == Decimal("-500.00")


def test_post_payments_with_wallet_topup_body_returns_the_authorization_url() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)

    with patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)):
        response = _auth_client(passenger).post(
            reverse("payment-list-create"),
            {"wallet_topup": {"business_id": str(business.id), "amount": "500.00"}},
            format="json",
            HTTP_IDEMPOTENCY_KEY="k1",
        )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["authorization_url"] == _FAKE_INIT_DATA["authorization_url"]


def test_post_payments_rejects_a_body_with_both_booking_id_and_wallet_topup() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(
        reverse("payment-list-create"),
        {
            "booking_id": "00000000-0000-0000-0000-000000000000",
            "wallet_topup": {"business_id": str(business.id), "amount": "500.00"},
        },
        format="json",
        HTTP_IDEMPOTENCY_KEY="k1",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_post_payments_rejects_a_body_with_neither_booking_id_nor_wallet_topup() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(
        reverse("payment-list-create"), {}, format="json", HTTP_IDEMPOTENCY_KEY="k1"
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
