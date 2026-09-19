"""Paying a booking directly from an existing wallet balance —
docs/specs/7-passenger-wallet.md. `pay_booking_from_wallet()`'s
success/insufficient-balance paths — the service function only; the
HTTP surface it once had (`POST /bookings/{id}/pay-from-wallet/`) was
removed when the blended-payment feature unified it into
`POST /payments/` (see test_blended_payment.py and
test_payments_views.py's own wallet-covers-it-all case)."""

import datetime
from decimal import Decimal

import pytest
from django.utils import timezone

from apps.booking.models import Booking
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.tests.factories import PassengerUserFactory
from apps.ledger.models import JournalEntry, LedgerAccount
from apps.ledger.services import (
    JournalLineInput,
    get_or_create_psp_suspense_account,
    get_or_create_wallet_account,
    post_journal_entry,
)
from apps.seating.models import SeatReservation

from ..models import PaymentIntent
from ..services import BookingNotPayable, InsufficientWalletBalance, pay_booking_from_wallet
from .booking_helpers import booking_with_a_held_seat

pytestmark = pytest.mark.django_db


def _fund_wallet(*, client, business, passenger, amount: Decimal) -> None:  # type: ignore[no-untyped-def]
    """Credits a passenger's wallet directly via the same 2-line
    top-up shape `_apply_wallet_topup` writes — real ledger rows, not a
    shortcut that bypasses `post_journal_entry`'s own balance
    invariant."""
    with platform_staff_bypass():
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        psp_suspense = get_or_create_psp_suspense_account(
            client=client, business=business, provider="paystack"
        )
        post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.TOPUP,
            lines=[
                JournalLineInput(account=wallet, amount=amount, currency=business.currency),
                JournalLineInput(account=psp_suspense, amount=-amount, currency=business.currency),
            ],
        )


def test_pay_booking_from_wallet_succeeds_with_a_sufficient_balance() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("300.00")
    )

    with tenant_context(str(client.id)):
        intent = pay_booking_from_wallet(booking=booking, passenger=booking.passenger)

    assert intent.status == PaymentIntent.Status.SUCCEEDED
    assert intent.intent_type == PaymentIntent.IntentType.BOOKING_PAYMENT
    assert intent.psp_provider == "wallet"
    assert intent.amount == Decimal("200.00")

    with platform_staff_bypass():
        booking_after = Booking.all_objects.get(pk=booking.pk)
        reservation_after = SeatReservation.all_objects.get(pk=reservation.pk)
        wallet = LedgerAccount.all_objects.get(
            business=business,
            passenger=booking.passenger,
            account_type=LedgerAccount.AccountType.WALLET,
        )
        clearing = LedgerAccount.all_objects.get(
            business=business, account_type=LedgerAccount.AccountType.BUSINESS_CLEARING
        )

    assert booking_after.status == Booking.Status.PAID
    assert reservation_after.status == SeatReservation.Status.CONFIRMED
    assert wallet.cached_balance == Decimal("100.00")
    assert clearing.cached_balance > Decimal("0.00")


def test_pay_booking_from_wallet_rejects_an_insufficient_balance() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("50.00")
    )

    with tenant_context(str(client.id)), pytest.raises(InsufficientWalletBalance):
        pay_booking_from_wallet(booking=booking, passenger=booking.passenger)

    with platform_staff_bypass():
        booking_after = Booking.all_objects.get(pk=booking.pk)
    assert booking_after.status == Booking.Status.PENDING_PAYMENT


def test_pay_booking_from_wallet_rejects_a_zero_balance() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")

    with tenant_context(str(client.id)), pytest.raises(InsufficientWalletBalance):
        pay_booking_from_wallet(booking=booking, passenger=booking.passenger)


def test_pay_booking_from_wallet_rejects_a_hold_that_lapsed_before_the_sweep_ran() -> None:
    """docs/specs/22-marketplace.md slice 2 — same race
    `test_initiate_payment_rejects_a_hold_that_lapsed_before_the_sweep_ran`
    proves for `initiate_payment`, here for this function's own direct
    caller (`apps.booking.staff`'s wallet-settle path), which never goes
    through `initiate_payment_with_wallet` at all.

    Unlike that test, this does **not** assert the booking/reservation
    rows are already `expired` in the database afterwards — they are
    not: `expire_stale_holds_for_locked_booking` runs *inside* this
    function's own `transaction.atomic()` block
    (`apps.seating.services`'s own docstring explains why, as a
    deliberate trade against a real deadlock this once caused), so
    raising `BookingNotPayable` from that same block rolls the expiry
    write back along with everything else. The periodic sweep still
    catches it within a minute, same as before this fix existed — the
    one thing that must hold here, and does, is that payment is
    genuinely refused for a lapsed hold, not that the row is already
    marked so this instant."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("500.00")
    )
    with tenant_context(str(client.id)):
        reservation.held_until = timezone.now() - datetime.timedelta(minutes=1)
        reservation.save(update_fields=["held_until"])

    with tenant_context(str(client.id)), pytest.raises(BookingNotPayable):
        pay_booking_from_wallet(booking=booking, passenger=booking.passenger)


def test_pay_booking_from_wallet_rejects_an_already_paid_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")
    _fund_wallet(
        client=client, business=business, passenger=booking.passenger, amount=Decimal("500.00")
    )

    with tenant_context(str(client.id)):
        pay_booking_from_wallet(booking=booking, passenger=booking.passenger)
        with pytest.raises(BookingNotPayable):
            pay_booking_from_wallet(booking=booking, passenger=booking.passenger)


def test_pay_booking_from_wallet_rejects_another_passengers_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        other = PassengerUserFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business, amount="200.00")

    with tenant_context(str(client.id)), pytest.raises(BookingNotPayable):
        pay_booking_from_wallet(booking=booking, passenger=other)
