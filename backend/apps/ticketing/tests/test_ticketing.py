"""apps.ticketing — see docs/specs/6-ticketing.md."""

import base64
import json
from datetime import timedelta
from uuid import uuid4

import pytest
from django.conf import settings
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from nacl.signing import SigningKey
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.models import Booking
from apps.booking.services import mark_booking_paid
from apps.booking.tests.factories import BookingFactory
from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.fares.tests.factories import FareRuleFactory
from apps.fleet.tests.factories import VehicleFactory, VehicleTypeFactory
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.scheduling.tests.factories import TripFactory
from apps.seating.services import create_reservation
from apps.seating.tests.factories import SeatFactory

from .. import signing
from ..models import Ticket
from ..services import issue_ticket

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api_client = APIClient()
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api_client


def _two_seat_booking(client, business):  # type: ignore[no-untyped-def]
    """A single Booking with two HELD SeatReservations — the group-
    booking shape `apps.booking.services.create_booking` already
    supports (`seats: list[SeatRequest]`), which is exactly why
    `Ticket.seat_reservation` (not `Ticket.booking`) is the unique
    field — see docs/specs/6-ticketing.md's implementation-note
    correction."""
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=4)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        # A real near-future departure, not TripFactory's own fixed
        # calendar-date default — issue_ticket anchors Ticket.expires_at
        # to trip.scheduled_departure_at, which must be after "now."
        departure = timezone.now() + timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        fare_rule = FareRuleFactory(client=client, route=route, business=business, amount="100.00")
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(
            client=client,
            business=business,
            trip=trip,
            passenger=passenger,
            total_amount="200.00",
            currency=business.currency,
        )
        seat_1 = SeatFactory(client=client, vehicle_type=vehicle_type)
        seat_2 = SeatFactory(client=client, vehicle_type=vehicle_type)
        reservation_1 = create_reservation(
            trip=trip,
            seat=seat_1,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=business.seat_hold_minutes,
            amount=fare_rule.amount,
            fare_rule=fare_rule,
        )
        reservation_2 = create_reservation(
            trip=trip,
            seat=seat_2,
            from_stop=stop_a,
            to_stop=stop_b,
            booking=booking,
            hold_minutes=business.seat_hold_minutes,
            amount=fare_rule.amount,
            fare_rule=fare_rule,
        )
    return booking, reservation_1, reservation_2


# --- signing.py -------------------------------------------------------


def test_sign_and_verify_round_trips() -> None:
    now = timezone.now()
    ticket_id = str(uuid4())
    booking_id, seat_reservation_id = str(uuid4()), str(uuid4())
    trip_id, seat_id = str(uuid4()), str(uuid4())
    from_stop_id, to_stop_id = str(uuid4()), str(uuid4())

    payload = signing.sign_ticket(
        ticket_id=ticket_id,
        booking_id=booking_id,
        seat_reservation_id=seat_reservation_id,
        trip_id=trip_id,
        seat_id=seat_id,
        from_stop_id=from_stop_id,
        to_stop_id=to_stop_id,
        issued_at=now,
        expires_at=now + timedelta(hours=1),
    )
    claims = signing.verify_and_decode(payload=payload)

    assert claims["ticket_id"] == ticket_id
    assert claims["booking_id"] == booking_id
    assert claims["seat_reservation_id"] == seat_reservation_id
    assert claims["trip_id"] == trip_id
    assert claims["seat_id"] == seat_id
    assert claims["from_stop_id"] == from_stop_id
    assert claims["to_stop_id"] == to_stop_id
    assert claims["kid"] == settings.TICKET_SIGNING_ACTIVE_KID
    assert claims["issued_at"] == int(now.timestamp())


def test_tampered_payload_is_rejected() -> None:
    now = timezone.now()
    payload = signing.sign_ticket(
        ticket_id=str(uuid4()),
        booking_id=str(uuid4()),
        seat_reservation_id=str(uuid4()),
        trip_id=str(uuid4()),
        seat_id=str(uuid4()),
        from_stop_id=str(uuid4()),
        to_stop_id=str(uuid4()),
        issued_at=now,
        expires_at=now + timedelta(hours=1),
    )
    flipped_char = "A" if payload[-1] != "A" else "B"
    tampered = payload[:-1] + flipped_char

    with pytest.raises(signing.TicketSigningError):
        signing.verify_and_decode(payload=tampered)


def test_malformed_payload_is_rejected() -> None:
    with pytest.raises(signing.TicketSigningError):
        signing.verify_and_decode(payload="not-a-valid-payload")


def test_unknown_kid_is_rejected() -> None:
    """A payload signed under a kid that is no longer present in
    TICKET_SIGNING_KEYS is rejected the same way a bad signature is —
    this is the entire grace-window mechanism (see
    docs/specs/6-ticketing.md's implementation-note correction)."""
    temp_private_key = base64.b64encode(bytes(SigningKey.generate())).decode()
    keys = json.loads(settings.TICKET_SIGNING_KEYS)
    keys["temp-kid"] = temp_private_key

    with override_settings(
        TICKET_SIGNING_KEYS=json.dumps(keys), TICKET_SIGNING_ACTIVE_KID="temp-kid"
    ):
        now = timezone.now()
        payload = signing.sign_ticket(
            ticket_id=str(uuid4()),
            booking_id=str(uuid4()),
            seat_reservation_id=str(uuid4()),
            trip_id=str(uuid4()),
            seat_id=str(uuid4()),
            from_stop_id=str(uuid4()),
            to_stop_id=str(uuid4()),
            issued_at=now,
            expires_at=now + timedelta(hours=1),
        )

    # Back to the original settings — "temp-kid" no longer present.
    with pytest.raises(signing.TicketSigningError):
        signing.verify_and_decode(payload=payload)


def test_public_keys_derives_from_stored_private_keys() -> None:
    keys = signing.public_keys()
    assert settings.TICKET_SIGNING_ACTIVE_KID in keys
    # Never the private key itself.
    stored_private = json.loads(settings.TICKET_SIGNING_KEYS)[settings.TICKET_SIGNING_ACTIVE_KID]
    assert keys[settings.TICKET_SIGNING_ACTIVE_KID] != stored_private


# --- issue_ticket() / mark_booking_paid() -------------------------------


def test_issue_ticket_creates_a_ticket_with_a_verifiable_payload() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business)

    with platform_staff_bypass():
        ticket = issue_ticket(booking=booking, seat_reservation=reservation)

    assert ticket.status == Ticket.Status.ISSUED
    assert ticket.seat_reservation_id == reservation.id
    assert ticket.booking_id == booking.id
    assert ticket.expires_at > ticket.issued_at
    claims = signing.verify_and_decode(payload=ticket.signed_payload)
    assert claims["seat_reservation_id"] == str(reservation.id)
    assert claims["booking_id"] == str(booking.id)
    assert AuditLog.objects.filter(action="ticket.issued", target_id=str(ticket.id)).exists()


def test_mark_booking_paid_issues_one_ticket_per_seat_reservation() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation_1, reservation_2 = _two_seat_booking(client, business)

    mark_booking_paid(booking=booking)

    with platform_staff_bypass():
        tickets = list(Ticket.all_objects.filter(booking=booking))
    assert len(tickets) == 2
    seat_reservation_ids = {ticket.seat_reservation_id for ticket in tickets}
    assert seat_reservation_ids == {reservation_1.id, reservation_2.id}
    payloads = {ticket.signed_payload for ticket in tickets}
    assert len(payloads) == 2  # each ticket's payload is genuinely distinct


def test_mark_booking_paid_is_a_noop_second_time_and_does_not_double_issue() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)

    mark_booking_paid(booking=booking)
    mark_booking_paid(booking=booking)

    with platform_staff_bypass():
        assert Ticket.all_objects.filter(booking=booking).count() == 1


# --- GET /bookings/{id}/tickets/ ----------------------------------------


def test_owner_can_list_their_own_tickets() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)
    mark_booking_paid(booking=booking)

    response = _auth_client(booking.passenger).get(
        reverse("booking-tickets", kwargs={"booking_id": str(booking.id)})
    )

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 1
    assert response.data["results"][0]["signed_payload"]


def test_listed_tickets_carry_the_trips_service_class() -> None:
    """docs/specs/15-trip-classes.md slice 3 — the ticket screen names
    the service, and has no other source for it: there is no
    single-Booking GET, and the screen is deep-linkable, so router state
    cannot carry it.

    A non-default class on purpose — every Trip defaults to `standard`.
    """
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)
    with tenant_context(str(client.id)):
        booking.trip.trip_class = Business.TripClass.EXCLUSIVE
        booking.trip.save(update_fields=["trip_class"])
    mark_booking_paid(booking=booking)

    response = _auth_client(booking.passenger).get(
        reverse("booking-tickets", kwargs={"booking_id": str(booking.id)})
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"][0]["trip_class"] == "exclusive"


def test_listing_another_passengers_tickets_is_forbidden() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        other = PassengerUserFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)
    mark_booking_paid(booking=booking)

    response = _auth_client(other).get(
        reverse("booking-tickets", kwargs={"booking_id": str(booking.id)})
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_listing_tickets_for_an_unpaid_booking_is_not_found() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)
    assert booking.status == Booking.Status.PENDING_PAYMENT

    response = _auth_client(booking.passenger).get(
        reverse("booking-tickets", kwargs={"booking_id": str(booking.id)})
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_listing_tickets_requires_authentication() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _reservation = booking_with_a_held_seat(client, business)

    response = APIClient().get(
        reverse("booking-tickets", kwargs={"booking_id": str(booking.id)})
    )

    assert response.status_code == status.HTTP_401_UNAUTHORIZED


# --- GET /ticketing/signing-keys/ ----------------------------------------


def test_signing_keys_endpoint_lists_the_active_kid() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
    _ = business

    response = _auth_client(passenger).get(reverse("ticketing-signing-keys"))

    assert response.status_code == status.HTTP_200_OK
    kids = [entry["kid"] for entry in response.data["keys"]]
    assert settings.TICKET_SIGNING_ACTIVE_KID in kids


# --- GET /ticketing/revoked/ ----------------------------------------------


def test_revoked_endpoint_is_empty_when_nothing_is_revoked() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("ticketing-revoked"))

    assert response.status_code == status.HTTP_200_OK
    assert response.data["revoked_ticket_ids"] == []
