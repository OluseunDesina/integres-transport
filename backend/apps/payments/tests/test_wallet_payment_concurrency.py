"""The two mandatory concurrency spikes for Phase 7
(docs/specs/7-passenger-wallet.md): real, separate connections
genuinely racing, mirroring
apps/payments/tests/test_settlement_run_concurrency.py's and
test_webhook_concurrency.py's structure exactly.

1. N concurrent `pay_booking_from_wallet()` calls against a wallet
   balance that covers exactly one of them.
2. A wallet-pay and a Paystack webhook `charge.success` racing for the
   same booking.
"""

import datetime
import threading
from decimal import Decimal
from unittest.mock import patch

import pytest
from django.db import connections, transaction
from django.utils import timezone

from apps.booking.models import Booking
from apps.booking.tests.factories import BookingFactory
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.tests.factories import PassengerUserFactory
from apps.ledger.models import JournalEntry, LedgerAccount
from apps.ledger.services import (
    JournalLineInput,
    get_or_create_psp_suspense_account,
    get_or_create_wallet_account,
    post_journal_entry,
)
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.seating.services import create_reservation
from apps.seating.tests.factories import SeatFactory

from ..models import PaymentIntent
from ..services import BookingNotPayable, initiate_payment, pay_booking_from_wallet
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db(transaction=True)

WORKER_COUNT = 8

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


def _fund_wallet(*, client, business, passenger, amount: Decimal) -> None:  # type: ignore[no-untyped-def]
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


def test_exactly_one_pay_booking_from_wallet_succeeds_against_a_shared_balance() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=WORKER_COUNT)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        departure = timezone.now() + datetime.timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        fare_rule = FareRuleFactory(client=client, route=route, business=business, amount="100.00")

        bookings = []
        for i in range(WORKER_COUNT):
            seat = SeatFactory(
                client=client, vehicle_type=vehicle_type, seat_number=f"1{chr(65 + i)}"
            )
            booking = BookingFactory(
                client=client,
                business=business,
                trip=trip,
                passenger=passenger,
                total_amount=Decimal("100.00"),
                currency=business.currency,
            )
            create_reservation(
                trip=trip,
                seat=seat,
                from_stop=stop_a,
                to_stop=stop_b,
                booking=booking,
                hold_minutes=business.seat_hold_minutes,
                amount=fare_rule.amount,
                fare_rule=fare_rule,
            )
            bookings.append(booking)

    with transaction.atomic():
        # Enough for exactly one of the WORKER_COUNT 100.00 bookings.
        _fund_wallet(
            client=client, business=business, passenger=passenger, amount=Decimal("100.00")
        )

    results: list[PaymentIntent] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(WORKER_COUNT)

    def worker(booking: Booking) -> None:
        connections.close_all()
        barrier.wait()
        try:
            # transaction.atomic() first, tenant_context() second: under
            # transaction=True there is no ambient transaction, and
            # tenant_context()'s RLS session vars are set SET-LOCAL-style
            # (set_config(..., true)) — with nothing open to attach to,
            # they'd vanish before pay_booking_from_wallet's own nested
            # transaction.atomic() (a savepoint within this one) ever
            # runs its Booking.all_objects/LedgerAccount.all_objects
            # queries. Real requests never hit this: TenancyMiddleware
            # already opens the transaction these GUCs need before a
            # view ever runs.
            with transaction.atomic(), tenant_context(str(client.id)):
                intent = pay_booking_from_wallet(booking=booking, passenger=passenger)
            results.append(intent)
        except BaseException as exc:  # noqa: BLE001 - recorded, not swallowed
            errors.append(exc)
        finally:
            connections.close_all()

    threads = [threading.Thread(target=worker, args=(booking,)) for booking in bookings]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(results) == 1, "exactly one concurrent wallet payment should have succeeded"
    assert len(errors) == WORKER_COUNT - 1
    for exc in errors:
        # Every loser must fail on the wallet-balance check, not some
        # other unrelated error — InsufficientWalletBalance specifically.
        assert type(exc).__name__ == "InsufficientWalletBalance"

    with platform_staff_bypass():
        wallet = LedgerAccount.all_objects.get(
            business=business, passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
        )
        # .count() forced here, inside the block — a lazy QuerySet
        # evaluated after platform_staff_bypass() has already restored
        # RLS to non-bypass mode would silently see zero rows.
        paid_count = Booking.all_objects.filter(
            id__in=[b.id for b in bookings], status=Booking.Status.PAID
        ).count()

    assert wallet.cached_balance == Decimal("0.00"), "balance must never go negative"
    assert paid_count == 1, "exactly one booking should have transitioned to paid"


def test_wallet_pay_and_webhook_charge_success_racing_for_the_same_booking() -> None:
    client = ClientFactory()
    with transaction.atomic(), tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=2)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        departure = timezone.now() + datetime.timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        fare_rule = FareRuleFactory(client=client, route=route, business=business, amount="200.00")
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        booking = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount=Decimal("200.00"),
            currency=business.currency,
        )
        create_reservation(
            trip=trip,
            seat=seat,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=business.seat_hold_minutes,
            amount=fare_rule.amount,
            fare_rule=fare_rule,
        )

    with transaction.atomic():
        _fund_wallet(
            client=client, business=business, passenger=passenger, amount=Decimal("500.00")
        )

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        transaction.atomic(),
        tenant_context(str(client.id)),
    ):
        card_intent = initiate_payment(
            booking=booking, passenger=passenger, idempotency_key="card-1"
        )

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=card_intent.psp_reference)
    )

    barrier = threading.Barrier(2)
    wallet_result: dict[str, object] = {}

    def wallet_worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            # See the sibling spike's own worker() for why
            # transaction.atomic() must open before tenant_context().
            with transaction.atomic(), tenant_context(str(client.id)):
                wallet_result["intent"] = pay_booking_from_wallet(
                    booking=booking, passenger=passenger
                )
        except BaseException as exc:  # noqa: BLE001 - recorded, not swallowed
            wallet_result["error"] = exc
        finally:
            connections.close_all()

    def webhook_worker() -> None:
        connections.close_all()
        barrier.wait()
        from ..services import process_paystack_webhook

        process_paystack_webhook(raw_body=raw_body, signature=signature)
        connections.close_all()

    t1 = threading.Thread(target=wallet_worker)
    t2 = threading.Thread(target=webhook_worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    with platform_staff_bypass():
        booking_after = Booking.all_objects.get(pk=booking.pk)
        card_intent.refresh_from_db()

    assert booking_after.status == Booking.Status.PAID, "booking must be paid exactly once"

    if "intent" in wallet_result:
        # Wallet-pay won the race: the card intent's own money still
        # moved (real Paystack charge), so it's flagged for manual
        # attention rather than silently dropped — edge case 6's
        # residual case, exercised here from a second direction.
        assert card_intent.status == PaymentIntent.Status.SUCCEEDED
        assert card_intent.requires_manual_refund is True
    else:
        # The webhook won the race: wallet-pay must see the booking
        # already paid and fail cleanly, never double-charge the wallet.
        assert isinstance(wallet_result["error"], BookingNotPayable)
        assert card_intent.requires_manual_refund is False
