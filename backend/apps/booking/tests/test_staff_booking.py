"""`POST /bookings/staff/` and `GET /passengers/lookup/` —
docs/specs/18-manifest-and-staff-booking.md slice 2."""

from datetime import timedelta
from decimal import Decimal

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.ledger.models import JournalEntry
from apps.ledger.services import (
    JournalLineInput,
    get_or_create_psp_suspense_account,
    get_or_create_wallet_account,
    post_journal_entry,
)
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.scheduling.tests.factories import TripFactory
from apps.seating.models import SeatReservation
from apps.seating.tests.factories import SeatFactory
from apps.ticketing.models import Ticket

from ..models import Booking

pytestmark = pytest.mark.django_db

STAFF_BOOKING_URL = reverse("booking-staff-create")
LOOKUP_URL = reverse("passenger-lookup")


def _auth(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def _post(user: User, body: dict[str, object], key: str = "sb-1") -> object:
    return _auth(user).post(STAFF_BOOKING_URL, body, format="json", HTTP_IDEMPOTENCY_KEY=key)


def _reservation_trip(client, *, capacity: int = 4, fare: str = "500.00"):  # type: ignore[no-untyped-def]
    """A prepaid, seat-assigned, bookable trip — the same builder shape
    `test_manifest` uses, including its near-future departure (a Ticket
    may not expire before it is issued)."""
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client)
        stop_a = StopFactory(client=client, business=route.business)
        stop_b = StopFactory(client=client, business=route.business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=route.business, capacity=capacity)
        vehicle = VehicleFactory(client=client, business=route.business, vehicle_type=vehicle_type)
        departure = timezone.now() + timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=route.business,
            vehicle=vehicle,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        FareRuleFactory(client=client, route=route, business=route.business, amount=fare)
        seat = SeatFactory(client=client, vehicle_type=vehicle_type, seat_number="1A")
    return trip, stop_a, stop_b, seat


def _counter(client):  # type: ignore[no-untyped-def]
    """An Owner (holds `booking.manage`) and a passenger of the same
    Client."""
    roles = create_default_roles(client)
    agent = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        passenger = PassengerUserFactory(client=client, email="ada.obi@example.com")
    return agent, passenger, roles


def _seat_body(trip, passenger, seat, stop_a, stop_b, **extra):  # type: ignore[no-untyped-def]
    return {
        "trip": str(trip.id),
        "passenger": str(passenger.id),
        "seats": [{"seat": str(seat.id), "from_stop": str(stop_a.id), "to_stop": str(stop_b.id)}],
        **extra,
    }


def _fund_wallet(client, business, passenger, amount: str) -> None:  # type: ignore[no-untyped-def]
    """Real money in, through the ledger — the same two-line top-up
    shape `apps.payments.tests.test_pay_booking_from_wallet._fund_wallet`
    uses, and for the same reason: `pay_booking_from_wallet` reads a
    balance that only a posted entry maintains, so a shortcut would test
    nothing."""
    with platform_staff_bypass():
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        psp_suspense = get_or_create_psp_suspense_account(
            client=client, business=business, provider="paystack"
        )
        post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.TOPUP,
            lines=[
                JournalLineInput(
                    account=wallet, amount=Decimal(amount), currency=business.currency
                ),
                JournalLineInput(
                    account=psp_suspense, amount=-Decimal(amount), currency=business.currency
                ),
            ],
        )


# --- booking for someone else ---------------------------------------------


def test_an_agent_books_a_seat_for_a_passenger() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    response = _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b))

    assert response.status_code == status.HTTP_201_CREATED
    body = response.data
    assert body["booking"]["passenger"] == passenger.id
    assert body["booking"]["status"] == Booking.Status.PENDING_PAYMENT
    # The reference slice 1 added, on the response the agent reads out
    # loud to the person standing there.
    assert body["booking"]["reference"].startswith("BKG-")
    # Nothing was charged and nothing failed — two facts a two-state
    # payment field could not tell apart.
    assert body["payment"]["status"] == "not_attempted"


def test_the_booking_is_the_passengers_not_the_agents() -> None:
    """The whole point. A booking recorded against the agent would put
    the seats in the wrong person's app and the fare on the wrong
    ledger."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b))

    with tenant_context(str(client.id)):
        booking = Booking.objects.get()
    assert booking.passenger_id == passenger.id
    assert booking.passenger_id != agent.id


def test_seats_are_really_held_by_the_shared_service() -> None:
    """Routed through `create_booking`, so the seat is genuinely
    reserved — not a second write path that forgot the capacity lock."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b))
    second = _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b), key="sb-2")

    assert second.status_code == status.HTTP_409_CONFLICT


def test_a_replay_under_one_key_returns_the_original_booking() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)
    body = _seat_body(trip, passenger, seat, stop_a, stop_b)

    first = _post(agent, body, key="sb-same")
    second = _post(agent, body, key="sb-same")

    assert second.status_code == status.HTTP_201_CREATED
    assert second.data["booking"]["id"] == first.data["booking"]["id"]
    with tenant_context(str(client.id)):
        assert Booking.objects.count() == 1


def test_a_replay_naming_a_different_passenger_is_a_conflict() -> None:
    """`_booking_request_hash` already covers the passenger, so this
    needed no new code — but it is the failure that would matter most
    (one agent's key returning another passenger's booking), so it is
    asserted rather than assumed."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)
    with tenant_context(str(client.id)):
        other = PassengerUserFactory(client=client)

    _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b), key="sb-x")
    second = _post(agent, _seat_body(trip, other, seat, stop_a, stop_b), key="sb-x")

    assert second.status_code == status.HTTP_409_CONFLICT


def test_the_idempotency_key_header_is_required() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    response = _auth(agent).post(
        STAFF_BOOKING_URL, _seat_body(trip, passenger, seat, stop_a, stop_b), format="json"
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_an_open_seating_trip_takes_a_passenger_count() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, _seat = _reservation_trip(client)
    with tenant_context(str(client.id)):
        trip.booking_mode = Business.BookingMode.OPEN_SEATING
        trip.save(update_fields=["booking_mode"])

    response = _post(
        agent,
        {
            "trip": str(trip.id),
            "passenger": str(passenger.id),
            "passenger_count": 2,
            "from_stop": str(stop_a.id),
            "to_stop": str(stop_b.id),
        },
    )

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        assert Ticket.objects.filter(booking_id=response.data["booking"]["id"]).count() == 0


def test_a_pay_as_you_go_trip_cannot_be_booked_at_the_counter() -> None:
    """The mirror of the rule the passenger endpoint already enforces:
    such a trip sells nothing in advance, so there is nothing to book."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)
    with tenant_context(str(client.id)):
        trip.fare_collection_mode = Business.FareCollectionMode.PAY_AS_YOU_GO
        trip.save(update_fields=["fare_collection_mode"])

    response = _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "trip" in response.data


# --- paying for it ---------------------------------------------------------


def test_a_funded_wallet_settles_the_booking_immediately() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client, fare="500.00")
    _fund_wallet(client, trip.business, passenger, "5000.00")

    response = _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b, pay_from_wallet=True))

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["payment"]["status"] == "succeeded"
    assert response.data["booking"]["status"] == Booking.Status.PAID
    with tenant_context(str(client.id)):
        # Paid means ticketed: the passenger can be scanned aboard
        # without ever opening their own app.
        assert Ticket.objects.filter(booking_id=response.data["booking"]["id"]).exists()


def test_an_empty_wallet_reports_failure_and_keeps_the_seats() -> None:
    """The spec's instruction, and the one behaviour worth stating
    twice: destroying a valid hold because payment came up short would
    be worse than reporting it."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client, fare="500.00")

    response = _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b, pay_from_wallet=True))

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["payment"]["status"] == "failed"
    assert "top up" in response.data["payment"]["reason"]
    assert response.data["booking"]["status"] == Booking.Status.PENDING_PAYMENT
    with tenant_context(str(client.id)):
        booking = Booking.objects.get()
        # The hold itself survives — asserted on the reservation, not on
        # the booking row, since it is the seat that would have been
        # released by a rollback.
        assert SeatReservation.objects.filter(booking=booking).count() == 1


def test_replaying_a_paid_staff_booking_does_not_report_a_failure() -> None:
    """A retry finds the booking already `paid`; calling the wallet
    service again would raise `BookingNotPayable` and report a failure
    for a booking that is in fact settled."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client, fare="500.00")
    _fund_wallet(client, trip.business, passenger, "5000.00")
    body = _seat_body(trip, passenger, seat, stop_a, stop_b, pay_from_wallet=True)

    first = _post(agent, body, key="sb-paid")
    second = _post(agent, body, key="sb-paid")

    assert first.data["payment"]["status"] == "succeeded"
    assert second.data["payment"]["status"] == "succeeded"
    assert second.data["booking"]["id"] == first.data["booking"]["id"]


# --- the trail -------------------------------------------------------------


def test_every_staff_booking_names_both_people() -> None:
    """A dispute about a booking someone says they did not make is
    otherwise unanswerable."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    response = _post(agent, _seat_body(trip, passenger, seat, stop_a, stop_b))

    entry = AuditLog.objects.get(action="booking.staff_created")
    assert entry.actor_id == agent.id
    assert entry.metadata["passenger"] == str(passenger.id)
    assert entry.target_id == str(response.data["booking"]["id"])
    assert entry.metadata["payment_status"] == "not_attempted"


# --- who may do it ---------------------------------------------------------


def test_booking_view_alone_cannot_book_for_someone_else() -> None:
    """The Staff preset holds `booking.view` — it reads the manifest at
    the door — and deliberately not `booking.manage`."""
    client = ClientFactory()
    _agent, passenger, roles = _counter(client)
    staff_member = ClientStaffUserFactory(client=client, role=roles["Staff"])
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    response = _post(staff_member, _seat_body(trip, passenger, seat, stop_a, stop_b))

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_booking_manage_is_granted_to_owner_and_manager_only() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)

    held = {
        name: role.permissions.filter(codename="booking.manage").exists()
        for name, role in roles.items()
    }

    assert held == {"Owner": True, "Manager": True, "Staff": False}


def test_a_passenger_of_another_client_cannot_be_booked_for() -> None:
    """Neither a 403 nor a leak: `identity.User` is not tenant-scoped
    (ADR-0003), so this is the one place a missing `client=` filter would
    silently sell another Client's passenger a seat."""
    client = ClientFactory()
    other_client = ClientFactory()
    agent, _passenger, _ = _counter(client)
    trip, stop_a, stop_b, seat = _reservation_trip(client)
    with tenant_context(str(other_client.id)):
        outsider = PassengerUserFactory(client=other_client)

    response = _post(agent, _seat_body(trip, outsider, seat, stop_a, stop_b))

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "Unknown passenger." in str(response.data["passenger"])


def test_a_colleague_cannot_be_booked_as_a_passenger() -> None:
    client = ClientFactory()
    agent, _passenger, roles = _counter(client)
    colleague = ClientStaffUserFactory(client=client, role=roles["Staff"])
    trip, stop_a, stop_b, seat = _reservation_trip(client)

    response = _post(agent, _seat_body(trip, colleague, seat, stop_a, stop_b))

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_another_clients_trip_cannot_be_booked_at_this_counter() -> None:
    client = ClientFactory()
    other_client = ClientFactory()
    agent, passenger, _ = _counter(client)
    other_trip, stop_a, stop_b, seat = _reservation_trip(other_client)

    response = _post(agent, _seat_body(other_trip, passenger, seat, stop_a, stop_b))

    assert response.status_code == status.HTTP_400_BAD_REQUEST


# --- the lookup ------------------------------------------------------------


def test_an_exact_email_resolves_one_passenger_with_a_masked_address() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)

    response = _auth(agent).get(LOOKUP_URL, {"email": passenger.email})

    assert response.status_code == status.HTTP_200_OK
    assert str(response.data["id"]) == str(passenger.id)
    # Masked: enough to confirm the address typed, not enough for the
    # queue behind them to read.
    assert response.data["email"] != passenger.email
    assert response.data["email"].startswith("a")
    assert response.data["email"].endswith("@example.com")


def test_the_lookup_is_not_a_search() -> None:
    """A partial address matches nothing. A fuzzy passenger search in
    the hands of counter staff is a data-protection problem; this
    answers one question about one person."""
    client = ClientFactory()
    agent, _passenger, _ = _counter(client)

    partial = _auth(agent).get(LOOKUP_URL, {"email": "ada"})
    prefix = _auth(agent).get(LOOKUP_URL, {"email": "ada.obi@example.co"})

    assert partial.status_code == status.HTTP_400_BAD_REQUEST  # not even a valid address
    assert prefix.status_code == status.HTTP_404_NOT_FOUND


def test_case_does_not_decide_whether_a_passenger_is_found() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)

    response = _auth(agent).get(LOOKUP_URL, {"email": passenger.email.upper()})

    assert response.status_code == status.HTTP_200_OK


def test_absent_and_another_clients_passenger_are_indistinguishable() -> None:
    """The distinction is exactly what an address-guessing caller
    wants — so both are one 404 with one message."""
    client = ClientFactory()
    other_client = ClientFactory()
    agent, _passenger, _ = _counter(client)
    with tenant_context(str(other_client.id)):
        outsider = PassengerUserFactory(client=other_client, email="elsewhere@example.com")

    absent = _auth(agent).get(LOOKUP_URL, {"email": "nobody@example.com"})
    foreign = _auth(agent).get(LOOKUP_URL, {"email": outsider.email})

    assert absent.status_code == foreign.status_code == status.HTTP_404_NOT_FOUND
    assert absent.data["detail"] == foreign.data["detail"]


def test_the_lookup_is_not_a_staff_directory() -> None:
    client = ClientFactory()
    agent, _passenger, roles = _counter(client)
    colleague = ClientStaffUserFactory(client=client, role=roles["Staff"])

    response = _auth(agent).get(LOOKUP_URL, {"email": colleague.email})

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_a_deactivated_account_is_not_bookable() -> None:
    client = ClientFactory()
    agent, passenger, _ = _counter(client)
    with tenant_context(str(client.id)):
        passenger.is_active = False
        passenger.save(update_fields=["is_active"])

    response = _auth(agent).get(LOOKUP_URL, {"email": passenger.email})

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_wallet_view_reaches_the_lookup_without_booking_manage() -> None:
    """`client-admin-app`'s wallet-lookup screen has shipped since spec
    5 needing a passenger UUID it had no way to obtain. Staff hold
    `wallet.view` and not `booking.manage`, so gating this on
    `booking.manage` alone would have left that screen broken for
    exactly the people who use it."""
    client = ClientFactory()
    _agent, passenger, roles = _counter(client)
    staff_member = ClientStaffUserFactory(client=client, role=roles["Staff"])
    assert not staff_member.role.permissions.filter(codename="booking.manage").exists()

    response = _auth(staff_member).get(LOOKUP_URL, {"email": passenger.email})

    assert response.status_code == status.HTTP_200_OK


def test_a_role_holding_neither_codename_is_refused() -> None:
    client = ClientFactory()
    agent, passenger, roles = _counter(client)
    with tenant_context(str(client.id)):
        bare = roles["Staff"]
        bare.permissions.remove(
            *bare.permissions.filter(codename__in=["wallet.view", "booking.manage"])
        )
    nobody = ClientStaffUserFactory(client=client, role=bare)

    response = _auth(nobody).get(LOOKUP_URL, {"email": passenger.email})

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_a_successful_lookup_is_audited_and_a_miss_is_not() -> None:
    """Auditing the misses would build the very list of tried addresses
    this endpoint exists not to produce."""
    client = ClientFactory()
    agent, passenger, _ = _counter(client)

    _auth(agent).get(LOOKUP_URL, {"email": passenger.email})
    _auth(agent).get(LOOKUP_URL, {"email": "nobody@example.com"})

    entries = AuditLog.objects.filter(action="passenger.looked_up")
    assert entries.count() == 1
    assert entries.get().target_id == str(passenger.id)
