"""HTTP-level tests for GET /activity/mine/ — docs/specs/20-live-operations.md
slice 4."""

import datetime
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking
from apps.booking.tests.factories import BookingFactory
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import CustomerTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.ledger.models import JournalEntry
from apps.ledger.services import (
    JournalLineInput,
    get_or_create_psp_suspense_account,
    get_or_create_wallet_account,
    post_journal_entry,
)
from apps.network.models import Route, Stop
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.payments.models import PaymentIntent
from apps.payments.tests.factories import PaymentIntentFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory
from apps.tapngo.models import FareJourney
from apps.tapngo.tests.factories import TapCredentialFactory
from apps.ticketing.models import Ticket
from apps.ticketing.services import issue_open_seating_tickets

pytestmark = pytest.mark.django_db


def _passenger_client(user: User) -> APIClient:
    token = CustomerTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _route_with_stops(client: object, business: object) -> tuple[Route, list[Stop]]:
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
    return route, [stop_a, stop_b]


def _open_seating_trip(client: object, business: object, route: Route) -> Trip:
    # A recent departure, not TripFactory's own fixed calendar-date
    # default — Ticket.expires_at is anchored to
    # trip.scheduled_departure_at, and the `ticket_expires_after_issued`
    # check constraint rejects one that expired before it was issued
    # (recorded in docs/traps.md and hit live building this test).
    now = timezone.now()
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return TripFactory(
            client=client,
            route=route,
            business=business,
            booking_mode="open_seating",
            status=Trip.Status.COMPLETED,
            service_date=now.date(),
            scheduled_departure_at=now - datetime.timedelta(minutes=30),
        )


def _topup(*, client, business, passenger, amount: str) -> PaymentIntent:
    with tenant_context(str(client.id)):
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        psp = get_or_create_psp_suspense_account(
            client=client, business=business, provider="paystack"
        )
        entry = post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.TOPUP,
            lines=[
                JournalLineInput(account=wallet, amount=Decimal(amount), currency="NGN"),
                JournalLineInput(account=psp, amount=-Decimal(amount), currency="NGN"),
            ],
        )
        return PaymentIntentFactory(
            client=client,
            booking=None,
            wallet_business=business,
            business=business,
            passenger=passenger,
            intent_type=PaymentIntent.IntentType.WALLET_TOPUP,
            amount=Decimal(amount),
            currency="NGN",
            status=PaymentIntent.Status.SUCCEEDED,
            succeeded_at=timezone.now(),
            journal_entry=entry,
        )


def _wallet_paid_booking(
    *, client, business, passenger, trip: Trip, amount: str
) -> PaymentIntent:
    """A booking paid entirely from an already-funded wallet — the one
    shape whose journal entry actually debits it (`pay_booking_from_wallet`'s
    own 3-line shape, reproduced directly rather than through the full
    service, since this test only needs the resulting row)."""
    with tenant_context(str(client.id)):
        booking = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount=amount,
            currency="NGN",
            status=Booking.Status.PAID,
        )
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        clearing = get_or_create_psp_suspense_account(
            client=client, business=business, provider="wallet-clearing"
        )
        entry = post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=[
                JournalLineInput(account=wallet, amount=-Decimal(amount), currency="NGN"),
                JournalLineInput(account=clearing, amount=Decimal(amount), currency="NGN"),
            ],
        )
        return PaymentIntentFactory(
            client=client,
            booking=booking,
            business=business,
            passenger=passenger,
            intent_type=PaymentIntent.IntentType.BOOKING_PAYMENT,
            amount=Decimal(amount),
            currency="NGN",
            status=PaymentIntent.Status.SUCCEEDED,
            succeeded_at=timezone.now(),
            journal_entry=entry,
        )


def _card_paid_booking(*, client, business, passenger, trip: Trip, amount: str) -> PaymentIntent:
    """A booking paid by card — its journal entry never touches the
    passenger's wallet at all (`_apply_booking_payment`'s own shape:
    `psp_suspense` debit, clearing + commission credit)."""
    with tenant_context(str(client.id)):
        booking = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount=amount,
            currency="NGN",
            status=Booking.Status.PAID,
        )
        psp = get_or_create_psp_suspense_account(
            client=client, business=business, provider="paystack"
        )
        clearing = get_or_create_psp_suspense_account(
            client=client, business=business, provider="card-clearing"
        )
        entry = post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=[
                JournalLineInput(account=psp, amount=-Decimal(amount), currency="NGN"),
                JournalLineInput(account=clearing, amount=Decimal(amount), currency="NGN"),
            ],
        )
        return PaymentIntentFactory(
            client=client,
            booking=booking,
            business=business,
            passenger=passenger,
            intent_type=PaymentIntent.IntentType.BOOKING_PAYMENT,
            amount=Decimal(amount),
            currency="NGN",
            status=PaymentIntent.Status.SUCCEEDED,
            succeeded_at=timezone.now(),
            journal_entry=entry,
        )


def _boarded_ticket(
    *, client, business, trip: Trip, stops: list[Stop], passenger, boarded_at=None
) -> Ticket:
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client, business=business, trip=trip, passenger=passenger)
        ticket = issue_open_seating_tickets(
            booking=booking, from_stop=stops[0], to_stop=stops[-1], passenger_count=1
        )[0]
        ticket.status = Ticket.Status.BOARDED
        ticket.boarded_at = boarded_at or timezone.now()
        ticket.save(update_fields=["status", "boarded_at"])
        return ticket


def _issued_only_ticket(*, client, business, trip: Trip, stops: list[Stop], passenger) -> Ticket:
    with tenant_context(str(client.id)):
        booking = BookingFactory(client=client, business=business, trip=trip, passenger=passenger)
        return issue_open_seating_tickets(
            booking=booking, from_stop=stops[0], to_stop=stops[-1], passenger_count=1
        )[0]


def _closed_fare_journey(
    *, client, business, trip: Trip, stops: list[Stop], passenger, amount: str, alighted_at=None
) -> FareJourney:
    with tenant_context(str(client.id)):
        credential = TapCredentialFactory(client=client, passenger=passenger)
        return FareJourney.objects.create(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            credential=credential,
            board_stop=stops[0],
            alight_stop=stops[-1],
            status=FareJourney.Status.CLOSED,
            boarded_at=timezone.now() - datetime.timedelta(minutes=20),
            alighted_at=alighted_at or timezone.now(),
            amount=Decimal(amount),
            currency="NGN",
        )


def _open_fare_journey(
    *, client, business, trip: Trip, stops: list[Stop], passenger
) -> FareJourney:
    with tenant_context(str(client.id)):
        credential = TapCredentialFactory(client=client, passenger=passenger)
        return FareJourney.objects.create(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            credential=credential,
            board_stop=stops[0],
            status=FareJourney.Status.OPEN,
            boarded_at=timezone.now(),
        )


def test_activity_mine_requires_authentication() -> None:
    response = APIClient().get(reverse("activity-mine"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_activity_mine_is_empty_for_a_passenger_with_no_activity() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []
    assert "poll_interval_seconds" in response.data


def test_activity_mine_lists_a_wallet_topup_with_its_resulting_balance() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    _topup(client=client, business=business, passenger=passenger, amount="500.00")

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    assert response.status_code == status.HTTP_200_OK
    [entry] = response.data["results"]
    assert entry["type"] == "wallet_topup"
    assert Decimal(entry["amount"]) == Decimal("500.00")
    assert Decimal(entry["wallet_balance"]) == Decimal("500.00")


def test_activity_mine_reflects_a_wallet_paid_booking_debiting_the_balance() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    route, stops = _route_with_stops(client, business)
    trip = _open_seating_trip(client, business, route)
    _topup(client=client, business=business, passenger=passenger, amount="1000.00")
    _wallet_paid_booking(
        client=client, business=business, passenger=passenger, trip=trip, amount="300.00"
    )

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    types = [row["type"] for row in response.data["results"]]
    assert types == ["booking_paid", "wallet_topup"]
    booking_row = response.data["results"][0]
    assert Decimal(booking_row["amount"]) == Decimal("300.00")
    assert Decimal(booking_row["wallet_balance"]) == Decimal("700.00")
    assert booking_row["route"] == route.name


def test_activity_mine_shows_no_wallet_balance_for_a_card_paid_booking() -> None:
    """A card payment never touches the wallet — showing a balance
    beside it would misattribute a change that never happened."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    route, _stops = _route_with_stops(client, business)
    trip = _open_seating_trip(client, business, route)
    _card_paid_booking(
        client=client, business=business, passenger=passenger, trip=trip, amount="450.00"
    )

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    [entry] = response.data["results"]
    assert entry["type"] == "booking_paid"
    assert Decimal(entry["amount"]) == Decimal("450.00")
    assert entry["wallet_balance"] is None


def test_activity_mine_lists_a_boarded_ticket_but_not_a_merely_issued_one() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    route, stops = _route_with_stops(client, business)
    trip = _open_seating_trip(client, business, route)
    _boarded_ticket(client=client, business=business, trip=trip, stops=stops, passenger=passenger)
    # A second, merely-issued ticket for the same passenger — folded
    # into `booking_paid` rather than shown again here (see
    # apps.activity.services' own docstring).
    _issued_only_ticket(
        client=client, business=business, trip=trip, stops=stops, passenger=passenger
    )

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    types = [row["type"] for row in response.data["results"]]
    assert types == ["ticket_boarded"]
    assert response.data["results"][0]["amount"] is None


def test_activity_mine_lists_a_closed_fare_journey_as_a_deduction_with_no_wallet_balance() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    route, stops = _route_with_stops(client, business)
    trip = _open_seating_trip(client, business, route)
    _closed_fare_journey(
        client=client,
        business=business,
        trip=trip,
        stops=stops,
        passenger=passenger,
        amount="180.00",
    )

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    [entry] = response.data["results"]
    assert entry["type"] == "fare_deducted"
    assert Decimal(entry["amount"]) == Decimal("-180.00")
    # No ledger line exists for a PAYG fare today (apps.tapngo.services
    # never posts one) — this must not invent a balance.
    assert entry["wallet_balance"] is None


def test_activity_mine_excludes_an_open_fare_journey() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    route, stops = _route_with_stops(client, business)
    trip = _open_seating_trip(client, business, route)
    _open_fare_journey(
        client=client, business=business, trip=trip, stops=stops, passenger=passenger
    )

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    assert response.data["results"] == []


def test_activity_mine_orders_everything_newest_first_across_types() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    route, stops = _route_with_stops(client, business)
    trip = _open_seating_trip(client, business, route)
    now = timezone.now()
    _closed_fare_journey(
        client=client,
        business=business,
        trip=trip,
        stops=stops,
        passenger=passenger,
        amount="50.00",
        alighted_at=now - datetime.timedelta(hours=2),
    )
    _boarded_ticket(
        client=client,
        business=business,
        trip=trip,
        stops=stops,
        passenger=passenger,
        boarded_at=now - datetime.timedelta(hours=1),
    )
    _topup(client=client, business=business, passenger=passenger, amount="200.00")

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    types = [row["type"] for row in response.data["results"]]
    assert types == ["wallet_topup", "ticket_boarded", "fare_deducted"]


def test_activity_mine_never_shows_another_passengers_activity() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    passenger = PassengerUserFactory(client=client)
    other_passenger = PassengerUserFactory(client=client)
    _topup(client=client, business=business, passenger=other_passenger, amount="900.00")

    response = _passenger_client(passenger).get(reverse("activity-mine"))

    assert response.data["results"] == []
