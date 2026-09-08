"""Presenting a tap credential on a prepaid trip —
docs/specs/10-booking-modes.md slice 3 (the universal tap).

The same endpoint and the same result shape as
`test_ticket_validation.py`'s QR path, reached with different fare
media. What is genuinely new here is the *resolution*: token ->
passenger -> the Ticket they already hold, with no `FareJourney`
anywhere in it. Several tests assert that absence explicitly rather
than only asserting a status code — "never a silently-opened journey"
is the property this slice exists to guarantee, and a status-only
assertion would pass even if one were opened.
"""

import datetime

import pytest
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.services import create_booking, mark_booking_paid
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
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.network.tests.factories import RouteFactory, RouteStopFactory, StopFactory
from apps.payments.tests.booking_helpers import booking_with_a_held_seat
from apps.scheduling.tests.factories import TripFactory
from apps.tapngo.models import FareJourney, TapCredential, TapEvent
from apps.tapngo.services import issue_credential

from ..models import Ticket

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api_client = APIClient()
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api_client


def _staff_for(client):  # type: ignore[no-untyped-def]
    roles = create_default_roles(client)
    return ClientStaffUserFactory(client=client, role=roles["Owner"])


def _prepaid_reservation_fixture(client):  # type: ignore[no-untyped-def]
    """A paid reservation booking with one Ticket, plus a credential
    belonging to the passenger who owns it."""
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, reservation = booking_with_a_held_seat(client, business)
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        ticket = Ticket.all_objects.get(seat_reservation=reservation)
    with tenant_context(str(client.id)):
        _credential, token = issue_credential(
            passenger=booking.passenger, channel="qr", label="phone"
        )
    return booking, ticket, token, _staff_for(client)


def _open_seating_fixture(client, *, passenger_count):  # type: ignore[no-untyped-def]
    """A paid open-seating booking for N passengers — N seatless
    Tickets, all reachable through one credential."""
    with tenant_context(str(client.id)):
        business = BusinessFactory(
            client=client, booking_mode_default=Business.BookingMode.OPEN_SEATING
        )
        route = RouteFactory(client=client, business=business)
        stop_a = StopFactory(client=client, business=business)
        stop_b = StopFactory(client=client, business=business)
        RouteStopFactory(client=client, route=route, stop=stop_a, sequence=1)
        RouteStopFactory(client=client, route=route, stop=stop_b, sequence=2)
        vehicle_type = VehicleTypeFactory(client=client, business=business, capacity=20)
        vehicle = VehicleFactory(client=client, business=business, vehicle_type=vehicle_type)
        departure = timezone.now() + datetime.timedelta(hours=2)
        trip = TripFactory(
            client=client,
            route=route,
            business=business,
            vehicle=vehicle,
            booking_mode=Business.BookingMode.OPEN_SEATING,
            service_date=departure.date(),
            scheduled_departure_at=departure,
        )
        FareRuleFactory(client=client, route=route, business=business, amount="500.00")
        passenger = PassengerUserFactory(client=client)
        booking = create_booking(
            trip=trip,
            passenger=passenger,
            passenger_count=passenger_count,
            from_stop=stop_a,
            to_stop=stop_b,
            idempotency_key="group-booking",
        )
    mark_booking_paid(booking=booking)
    with tenant_context(str(client.id)):
        _credential, token = issue_credential(passenger=passenger, channel="nfc", label="")
    return booking, token, _staff_for(client)


def _validate_url(trip_id) -> str:  # type: ignore[no-untyped-def]
    return reverse("ticket-validate", kwargs={"trip_id": str(trip_id)})


def _boarded_indexes(booking) -> list[int | None]:  # type: ignore[no-untyped-def]
    with platform_staff_bypass():
        return list(
            Ticket.all_objects.filter(booking=booking, status=Ticket.Status.BOARDED)
            .order_by("issued_at", "passenger_index", "id")
            .values_list("passenger_index", flat=True)
        )


# --- happy path -------------------------------------------------------------


def test_tapping_a_credential_boards_the_passengers_ticket() -> None:
    client = ClientFactory()
    booking, ticket, token, staff = _prepaid_reservation_fixture(client)

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-1",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "boarded"
    assert response.data["passenger_name"] == booking.passenger.email
    assert response.data["seat_number"]
    assert response.data["from_stop"]
    assert response.data["to_stop"]
    with platform_staff_bypass():
        ticket.refresh_from_db()
    assert ticket.status == Ticket.Status.BOARDED
    assert ticket.boarded_at is not None


def test_boarding_by_credential_records_which_credential_was_used() -> None:
    """A dispute has to be able to tell a credential tap from a QR scan;
    the boarding event itself is the only place that distinction
    survives, since a prepaid trip writes no TapEvent."""
    client = ClientFactory()
    booking, ticket, token, staff = _prepaid_reservation_fixture(client)

    _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-audit",
    )

    entry = AuditLog.objects.get(action="ticket.boarded", target_id=str(ticket.id))
    assert entry.metadata["credential_id"]


def test_boarding_the_only_ticket_by_credential_completes_the_booking() -> None:
    client = ClientFactory()
    booking, _ticket, token, staff = _prepaid_reservation_fixture(client)

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-completes",
    )

    assert response.data["booking_status"] == "completed"


def test_an_open_seating_ticket_boards_with_no_seat_number() -> None:
    client = ClientFactory()
    booking, token, staff = _open_seating_fixture(client, passenger_count=1)

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-open-seating",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "boarded"
    assert response.data["seat_number"] is None


def test_a_group_boards_one_passenger_per_tap_in_order() -> None:
    """One credential, four passengers. Refusing this as "ambiguous"
    would make group travel unboardable, so each tap takes the next
    unboarded ticket — and the fifth has nothing left to take."""
    client = ClientFactory()
    booking, token, staff = _open_seating_fixture(client, passenger_count=4)
    api = _auth_client(staff)
    url = _validate_url(booking.trip_id)

    for tap in range(4):
        response = api.post(
            url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY=f"group-tap-{tap}"
        )
        assert response.status_code == status.HTTP_200_OK
        assert _boarded_indexes(booking) == list(range(tap + 1))

    exhausted = api.post(url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY="group-tap-4")
    assert exhausted.status_code == status.HTTP_409_CONFLICT
    assert _boarded_indexes(booking) == [0, 1, 2, 3]


# --- rejections -------------------------------------------------------------


def test_a_credential_with_no_ticket_is_404_and_opens_no_journey() -> None:
    """docs/specs/10-booking-modes.md's own edge case. The absence of a
    FareJourney is the assertion that matters: silently opening one
    would start charging a passenger by distance on a service they
    already paid a fixed fare for."""
    client = ClientFactory()
    booking, _ticket, _token, staff = _prepaid_reservation_fixture(client)
    with tenant_context(str(client.id)):
        _credential, stranger_token = issue_credential(
            passenger=PassengerUserFactory(client=client), channel="qr", label=""
        )

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": stranger_token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-no-ticket",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
    assert "no ticket" in response.data["detail"].lower()
    with platform_staff_bypass():
        assert FareJourney.all_objects.count() == 0
        assert TapEvent.all_objects.count() == 0


def test_a_credential_on_a_pay_as_you_go_trip_is_rejected_and_opens_no_journey() -> None:
    """The mirror of `record_tap`'s own prepaid gate. A PAYG trip sells
    no tickets, so this endpoint has nothing to resolve — and must say
    so rather than quietly doing the other mode's job."""
    client = ClientFactory()
    booking, _ticket, token, staff = _prepaid_reservation_fixture(client)
    with tenant_context(str(client.id)):
        trip = booking.trip
        trip.fare_collection_mode = Business.FareCollectionMode.PAY_AS_YOU_GO
        trip.save(update_fields=["fare_collection_mode"])

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-payg",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "board tap" in response.data["detail"]
    with platform_staff_bypass():
        assert FareJourney.all_objects.count() == 0


def test_a_revoked_credential_is_forbidden() -> None:
    client = ClientFactory()
    booking, _ticket, token, staff = _prepaid_reservation_fixture(client)
    with tenant_context(str(client.id)):
        TapCredential.objects.filter(passenger=booking.passenger).update(is_active=False)

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": token},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-revoked",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_an_unknown_token_is_not_found() -> None:
    client = ClientFactory()
    booking, _ticket, _token, staff = _prepaid_reservation_fixture(client)

    response = _auth_client(staff).post(
        _validate_url(booking.trip_id),
        {"token": "not-a-real-token"},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-unknown",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_a_credential_from_another_client_is_not_found() -> None:
    """Tenancy, not just ownership: another Client's credential is
    invisible to this Client's staff, so it resolves to nothing at all
    rather than to somebody else's ticket."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    booking_a, _ticket_a, _token_a, staff_a = _prepaid_reservation_fixture(client_a)
    with tenant_context(str(client_b.id)):
        _credential, token_b = issue_credential(
            passenger=PassengerUserFactory(client=client_b), channel="qr", label=""
        )

    response = _auth_client(staff_a).post(
        _validate_url(booking_a.trip_id),
        {"token": token_b},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-cross-client",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- idempotency and body shape ---------------------------------------------


def test_replaying_the_same_key_returns_the_identical_result() -> None:
    client = ClientFactory()
    booking, _ticket, token, staff = _prepaid_reservation_fixture(client)
    api = _auth_client(staff)
    url = _validate_url(booking.trip_id)

    first = api.post(url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY="tap-replay")
    second = api.post(url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY="tap-replay")

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK
    assert first.data == second.data


def test_a_new_key_against_an_already_boarded_ticket_is_a_conflict() -> None:
    client = ClientFactory()
    booking, _ticket, token, staff = _prepaid_reservation_fixture(client)
    api = _auth_client(staff)
    url = _validate_url(booking.trip_id)

    api.post(url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY="tap-first")
    second = api.post(url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY="tap-second")

    assert second.status_code == status.HTTP_409_CONFLICT


def test_the_same_key_reused_for_the_other_medium_is_a_conflict() -> None:
    """A credential tap and a QR scan hash differently, so reusing one
    key across both is a genuine key collision — not a replay."""
    client = ClientFactory()
    booking, ticket, token, staff = _prepaid_reservation_fixture(client)
    api = _auth_client(staff)
    url = _validate_url(booking.trip_id)

    api.post(url, {"token": token}, format="json", HTTP_IDEMPOTENCY_KEY="tap-shared-key")
    second = api.post(
        url,
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-shared-key",
    )

    assert second.status_code == status.HTTP_409_CONFLICT


def test_the_body_must_carry_exactly_one_medium() -> None:
    client = ClientFactory()
    booking, ticket, token, staff = _prepaid_reservation_fixture(client)
    api = _auth_client(staff)
    url = _validate_url(booking.trip_id)

    neither = api.post(url, {}, format="json", HTTP_IDEMPOTENCY_KEY="tap-neither")
    both = api.post(
        url,
        {"token": token, "payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="tap-both",
    )

    assert neither.status_code == status.HTTP_400_BAD_REQUEST
    assert both.status_code == status.HTTP_400_BAD_REQUEST
