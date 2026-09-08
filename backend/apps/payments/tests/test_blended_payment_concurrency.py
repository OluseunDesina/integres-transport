"""The mandatory concurrency spike for the blended wallet + Paystack
payment feature (docs/specs/7-passenger-wallet.md's Implementation
note revisiting its own "a blend needs its own partial-refund/
reconciliation design" non-goal): a blended payment's webhook
settlement (which debits the wallet for its `wallet_component_amount`)
racing a concurrent, independent wallet spend for the *same* passenger
— proving the wallet balance never goes negative and the loser is
handled cleanly (the settlement's own `requires_manual_refund` flag, or
`InsufficientWalletBalance`), never a silent over-draw. Mirrors
test_wallet_payment_concurrency.py's structure exactly."""

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
from apps.ledger.models import LedgerAccount
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.payments.tests.test_pay_booking_from_wallet import _fund_wallet
from apps.scheduling.tests.factories import TripFactory
from apps.seating.services import create_reservation
from apps.seating.tests.factories import SeatFactory

from ..models import PaymentIntent
from ..services import (
    InsufficientWalletBalance,
    initiate_payment_with_wallet,
    pay_booking_from_wallet,
)
from .factories import PaystackAccountFactory
from .webhook_helpers import paystack_payload, signed_body

pytestmark = pytest.mark.django_db(transaction=True)

_FAKE_INIT_DATA = {
    "authorization_url": "https://checkout.paystack.com/abc123",
    "access_code": "abc123",
    "reference": "irrelevant",
}


def test_blend_settlement_and_a_concurrent_wallet_spend_race_safely() -> None:
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
        fare_rule = FareRuleFactory(client=client, route=route, business=business, amount="750.00")

        seat_a = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
        booking_a = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount=Decimal("750.00"),
            currency=business.currency,
        )
        create_reservation(
            trip=trip,
            seat=seat_a,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking_a,
            hold_minutes=business.seat_hold_minutes,
            amount=Decimal("750.00"),
            fare_rule=fare_rule,
        )

        seat_b = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1B")
        booking_b = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount=Decimal("50.00"),
            currency=business.currency,
        )
        create_reservation(
            trip=trip,
            seat=seat_b,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking_b,
            hold_minutes=business.seat_hold_minutes,
            amount=Decimal("50.00"),
            fare_rule=fare_rule,
        )

    with transaction.atomic():
        # Exactly enough to cover booking_a's wallet component (50.00)
        # or booking_b's full total (50.00) — never both.
        _fund_wallet(client=client, business=business, passenger=passenger, amount=Decimal("50.00"))

    with (
        patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)),
        transaction.atomic(),
        tenant_context(str(client.id)),
    ):
        blend_intent = initiate_payment_with_wallet(
            booking=booking_a, passenger=passenger, idempotency_key="race-blend-1"
        )
    assert blend_intent.wallet_component_amount == Decimal("50.00")
    assert blend_intent.amount == Decimal("700.00")

    raw_body, signature = signed_body(
        paystack_payload(event="charge.success", reference=blend_intent.psp_reference)
    )

    barrier = threading.Barrier(2)
    wallet_pay_result: dict[str, object] = {}

    def settle_webhook_worker() -> None:
        connections.close_all()
        barrier.wait()
        from ..services import process_paystack_webhook

        process_paystack_webhook(raw_body=raw_body, signature=signature)
        connections.close_all()

    def wallet_pay_worker() -> None:
        connections.close_all()
        barrier.wait()
        try:
            # See test_wallet_payment_concurrency.py's own worker() for
            # why transaction.atomic() must open before tenant_context().
            with transaction.atomic(), tenant_context(str(client.id)):
                wallet_pay_result["intent"] = pay_booking_from_wallet(
                    booking=booking_b, passenger=passenger
                )
        except BaseException as exc:  # noqa: BLE001 - recorded, not swallowed
            wallet_pay_result["error"] = exc
        finally:
            connections.close_all()

    t1 = threading.Thread(target=settle_webhook_worker)
    t2 = threading.Thread(target=wallet_pay_worker)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    with platform_staff_bypass():
        wallet = LedgerAccount.all_objects.get(
            business=business, passenger=passenger, account_type=LedgerAccount.AccountType.WALLET
        )
        booking_a_after = Booking.all_objects.get(pk=booking_a.pk)
        booking_b_after = Booking.all_objects.get(pk=booking_b.pk)
        blend_intent.refresh_from_db()
        paid_count = Booking.all_objects.filter(
            id__in=[booking_a.id, booking_b.id], status=Booking.Status.PAID
        ).count()

    assert wallet.cached_balance == Decimal("0.00"), "balance must never go negative"
    assert paid_count == 1, "exactly one of the two bookings should have been paid"

    if "intent" in wallet_pay_result:
        # booking_b's direct wallet-pay won the race for the shared
        # balance: booking_a's blended settlement must see the
        # shortfall and flag for manual reconciliation instead of
        # over-drawing, never silently mark booking_a paid anyway.
        assert booking_b_after.status == Booking.Status.PAID
        assert booking_a_after.status == Booking.Status.PENDING_PAYMENT
        assert blend_intent.status == PaymentIntent.Status.SUCCEEDED
        assert blend_intent.requires_manual_refund is True
        assert blend_intent.journal_entry_id is None
    else:
        # The blended settlement won: it took the wallet's 50.00 for
        # its own component, so booking_b's direct wallet-pay attempt
        # must cleanly fail on an now-empty balance, never double-spend.
        assert booking_a_after.status == Booking.Status.PAID
        assert booking_b_after.status == Booking.Status.PENDING_PAYMENT
        assert blend_intent.status == PaymentIntent.Status.SUCCEEDED
        assert blend_intent.requires_manual_refund is False
        assert blend_intent.journal_entry_id is not None
        assert isinstance(wallet_pay_result["error"], InsufficientWalletBalance)
