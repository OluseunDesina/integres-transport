"""Blended wallet + Paystack booking payment —
docs/specs/7-passenger-wallet.md's Implementation note revisiting its
own original "a blend needs its own partial-refund/reconciliation
design" non-goal. `initiate_payment_with_wallet()`'s two branches
(wallet fully covers it → delegates to `pay_booking_from_wallet()`;
otherwise → Paystack charged for the remainder only, wallet debited at
settlement) and `_apply_booking_payment()`'s `wallet_component_amount`
branch, including the balance-shortfall-at-settlement edge case."""

import datetime
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.idempotency import IdempotencyKeyConflict
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.ledger.models import JournalLine, LedgerAccount
from apps.seating.models import SeatReservation

from ..models import PaymentIntent
from ..services import (
    BookingNotPayable,
    PspNotConfigured,
    initiate_payment,
    initiate_payment_with_wallet,
    pay_booking_from_wallet,
)
from .booking_helpers import booking_with_a_held_seat
from .factories import PaystackAccountFactory
from .test_pay_booking_from_wallet import _fund_wallet
from .webhook_helpers import paystack_payload, signed_body

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


def _settle_via_webhook(intent: PaymentIntent) -> None:
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


# --- Fully covered by wallet: delegates, no Paystack call -------------------


def test_wallet_fully_covers_it_delegates_with_no_paystack_call() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("300.00")
    )

    with (
        patch("apps.payments.services.initialize_transaction") as mock_init,
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-1"
        )
    mock_init.assert_not_called()

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.psp_provider == "wallet"
    assert intent.amount == Decimal("200.00")
    assert intent.wallet_component_amount == Decimal("0.00")

    with platform_staff_bypass():
        booking_after = Booking.all_objects.get(pk=booking.pk)
        reservation_after = SeatReservation.all_objects.get(pk=reservation.pk)
        wallet = LedgerAccount.all_objects.get(
            business=business,
            passenger=booking.passenger,
            account_type=LedgerAccount.AccountType.WALLET,
        )
    assert booking_after.status == Booking.Status.PAID
    assert reservation_after.status == SeatReservation.Status.CONFIRMED
    assert wallet.cached_balance == Decimal("100.00")


def test_wallet_fully_covers_it_replays_on_a_retried_idempotency_key() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("300.00")
    )

    with tenant_context(str(client.id)):
        first = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-retry"
        )
        second = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-retry"
        )
    assert second.id == first.id


def test_initiate_payment_with_wallet_rejects_a_hold_that_lapsed_before_the_sweep_ran() -> None:
    """docs/specs/22-marketplace.md slice 2 — same race
    `test_initiate_payment_rejects_a_hold_that_lapsed_before_the_sweep_ran`
    (test_initiate_payment.py) proves for the plain Paystack path,
    exercised here for the wallet-blended one."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("300.00")
    )
    with tenant_context(str(client.id)):
        reservation.held_until = timezone.now() - datetime.timedelta(minutes=1)
        reservation.save(update_fields=["held_until"])

    with tenant_context(str(client.id)):
        with pytest.raises(BookingNotPayable):
            initiate_payment_with_wallet(
                booking=booking, passenger=booking.passenger, idempotency_key="blend-lapsed"
            )
        booking.refresh_from_db()
        reservation.refresh_from_db()
    assert booking.status == Booking.Status.EXPIRED
    assert reservation.status == SeatReservation.Status.EXPIRED


# --- Blended: Paystack charged for the remainder only ------------------------


def test_blend_charges_only_the_remainder_via_paystack() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="750.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with (
        patch(
            "apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)
        ) as mock_init,
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-2"
        )

    assert mock_init.call_args.kwargs["amount"] == Decimal("700.00")
    assert intent.status == PaymentIntent.Status.PENDING
    assert intent.psp_provider == "paystack"
    assert intent.amount == Decimal("700.00")
    assert intent.wallet_component_amount == Decimal("50.00")
    assert intent.psp_authorization_url == _FAKE_INIT_DATA["authorization_url"]

    # Wallet balance is untouched until settlement.
    with platform_staff_bypass():
        wallet = LedgerAccount.all_objects.get(
            business=business,
            passenger=booking.passenger,
            account_type=LedgerAccount.AccountType.WALLET,
        )
    assert wallet.cached_balance == Decimal("50.00")


def test_blend_requires_a_configured_paystack_account_for_the_remainder() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="750.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with tenant_context(str(client.id)), pytest.raises(PspNotConfigured):
        initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-3"
        )


def test_blend_replays_on_a_retried_idempotency_key_without_a_second_paystack_call() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="750.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with (
        patch(
            "apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)
        ) as mock_init,
        tenant_context(str(client.id)),
    ):
        first = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-4"
        )
        second = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-4"
        )
    assert second.id == first.id
    mock_init.assert_called_once()


def test_reusing_a_plain_payment_key_for_a_blended_attempt_conflicts() -> None:
    """A client that reuses the same Idempotency-Key first for a plain
    Paystack attempt and then for a wallet-blended one on the same
    booking must see a clear conflict, not a silent replay of the
    wrong response — the two shapes hash differently on purpose."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="750.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        initiate_payment(booking=booking, passenger=booking.passenger, idempotency_key="reuse-1")
        with pytest.raises(IdempotencyKeyConflict):
            initiate_payment_with_wallet(
                booking=booking, passenger=booking.passenger, idempotency_key="reuse-1"
            )


# --- Settlement (webhook) ----------------------------------------------------


def test_blend_settlement_posts_a_balanced_four_line_entry_and_pays_the_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, reservation = booking_with_a_held_seat(client, business, amount="750.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment_with_wallet(
            booking=booking, passenger=booking.passenger, idempotency_key="blend-settle-1"
        )

    _settle_via_webhook(intent)

    with platform_staff_bypass():
        intent.refresh_from_db()
        booking_after = Booking.all_objects.get(pk=booking.pk)
        reservation_after = SeatReservation.all_objects.get(pk=reservation.pk)
        wallet = LedgerAccount.all_objects.get(
            business=business,
            passenger=booking.passenger,
            account_type=LedgerAccount.AccountType.WALLET,
        )
        psp_suspense = LedgerAccount.all_objects.get(
            business=business,
            psp_provider="paystack",
            account_type=LedgerAccount.AccountType.PSP_SUSPENSE,
        )
        clearing = LedgerAccount.all_objects.get(
            business=business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        )
        lines = list(JournalLine.all_objects.filter(journal_entry_id=intent.journal_entry_id))

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.journal_entry_id is not None
    assert intent.requires_manual_refund is False
    assert booking_after.status == Booking.Status.PAID
    assert reservation_after.status == SeatReservation.Status.CONFIRMED
    assert wallet.cached_balance == Decimal("0.00")
    # -50.00 from _fund_wallet()'s own top-up entry (simulating that
    # money's original Paystack origin) plus -700.00 from this
    # settlement's own psp_suspense line.
    assert psp_suspense.cached_balance == Decimal("-750.00")
    # Commission is split on the full 750.00 booking total, not just the
    # 700.00 Paystack portion.
    assert clearing.cached_balance > Decimal("0.00")
    assert sum(line.amount for line in lines) == Decimal("0.00")
    assert len(lines) == 4


def test_blend_settlement_flags_manual_refund_when_the_wallet_balance_has_since_dropped() -> None:
    """The narrow edge case this feature's own design accepts as a
    residual risk: Paystack already succeeded for the remainder, but by
    the time the webhook lands the wallet balance meant to cover the
    other leg has been spent elsewhere. No journal entry is posted (an
    unbalanced/partial entry would violate the ledger's invariant); the
    intent is flagged for manual reconciliation instead."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking_a, _res_a = booking_with_a_held_seat(client, business, amount="750.00")
    passenger = booking_a.passenger
    _fund_wallet(client=client, business=business, passenger=passenger, amount=Decimal("50.00"))

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        tenant_context(str(client.id)),
    ):
        intent = initiate_payment_with_wallet(
            booking=booking_a, passenger=passenger, idempotency_key="blend-shortfall-1"
        )
    assert intent.wallet_component_amount == Decimal("50.00")

    # Drain the wallet before the webhook lands — a second booking for
    # the same passenger, paid fully from the same wallet balance.
    booking_b, _res_b = booking_with_a_held_seat(
        client, business, amount="50.00", passenger=passenger
    )
    with tenant_context(str(client.id)):
        pay_booking_from_wallet(booking=booking_b, passenger=passenger)

    with platform_staff_bypass():
        wallet_before = LedgerAccount.all_objects.get(
            business=business, passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
        )
    assert wallet_before.cached_balance == Decimal("0.00")

    _settle_via_webhook(intent)

    with platform_staff_bypass():
        intent.refresh_from_db()
        booking_a_after = Booking.all_objects.get(pk=booking_a.pk)

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.journal_entry_id is None
    assert intent.requires_manual_refund is True
    assert booking_a_after.status == Booking.Status.PENDING_PAYMENT
    assert AuditLog.objects.filter(action="payment.blended_wallet_shortfall").exists()


# --- HTTP surface -------------------------------------------------------------


def test_post_payments_with_use_wallet_balance_fully_covered_returns_succeeded() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("300.00")
    )

    response = _auth_client(booking.passenger).post(
        reverse("payment-list-create"),
        {"booking_id": str(booking.id), "use_wallet_balance": True},
        HTTP_IDEMPOTENCY_KEY="http-blend-1",
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["status"] == "succeeded"
    assert not response.data["authorization_url"]


def test_post_payments_with_use_wallet_balance_blended_returns_remainder_url() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="750.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)):
        response = _auth_client(booking.passenger).post(
            reverse("payment-list-create"),
            {"booking_id": str(booking.id), "use_wallet_balance": True},
            HTTP_IDEMPOTENCY_KEY="http-blend-2",
        )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["status"] == "pending"
    assert response.data["authorization_url"] == _FAKE_INIT_DATA["authorization_url"]


def test_post_payments_rejects_use_wallet_balance_paired_with_wallet_topup() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="1.00")
    passenger = booking.passenger

    response = _auth_client(passenger).post(
        reverse("payment-list-create"),
        {
            "use_wallet_balance": True,
            "wallet_topup": {"business_id": str(business.id), "amount": "10.00"},
        },
        HTTP_IDEMPOTENCY_KEY="http-blend-3",
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST
