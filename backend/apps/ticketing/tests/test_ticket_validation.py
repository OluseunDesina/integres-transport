"""POST /trips/{trip_id}/tickets/validate/ — see docs/specs/6-ticketing.md
(Slice 2). Mirrors apps/tapngo/tests/test_tapngo.py's
POST /trips/{trip_id}/taps/ test structure.
"""

from datetime import timedelta

import pytest
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.services import mark_booking_paid
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.rls import platform_staff_bypass
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory
from apps.payments.tests.booking_helpers import booking_with_a_held_seat

from .. import signing
from ..models import Ticket

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api_client = APIClient()
    api_client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api_client


def _issue_ticket(client, business):  # type: ignore[no-untyped-def]
    """A paid Booking with one boardable Ticket, plus the staff user and
    Client both needed to call the validate endpoint against it."""
    booking, reservation = booking_with_a_held_seat(client, business)
    mark_booking_paid(booking=booking)
    with platform_staff_bypass():
        ticket = Ticket.all_objects.get(seat_reservation=reservation)
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    return booking, ticket, staff


# --- happy path -----------------------------------------------------------


def test_staff_can_validate_a_ticket_and_board_it() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-1",
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "boarded"
    assert response.data["seat_number"]
    assert response.data["from_stop"]
    assert response.data["to_stop"]
    with platform_staff_bypass():
        ticket.refresh_from_db()
    assert ticket.status == Ticket.Status.BOARDED
    assert ticket.boarded_at is not None
    assert AuditLog.objects.filter(action="ticket.boarded", target_id=str(ticket.id)).exists()


def test_validated_passenger_name_falls_back_to_email_when_no_name_set() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-name",
    )

    assert response.data["passenger_name"] == booking.passenger.email


# --- edge cases -------------------------------------------------------------


def test_validate_rejects_a_tampered_payload() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)
    tampered = ticket.signed_payload[:-1] + ("A" if ticket.signed_payload[-1] != "A" else "B")

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": tampered},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-tamper",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_validate_rejects_a_scan_before_the_valid_from_window() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)

    # The default 24h-before window comfortably covers "now" in the
    # fixture (trip departs ~2h from now) — shrink it to make "now"
    # fall before the valid-from bound without needing a fake clock.
    with override_settings(TICKET_VALID_BEFORE_MINUTES=1):
        response = _auth_client(staff).post(
            reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
            {"payload": ticket.signed_payload},
            format="json",
            HTTP_IDEMPOTENCY_KEY="validate-early",
        )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_validate_rejects_an_expired_ticket() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)
    with platform_staff_bypass():
        # expires_at must stay after issued_at (a real DB CheckConstraint
        # — see the model) even while both are moved into the past
        # relative to "now," to simulate a ticket that expired normally.
        ticket.issued_at = timezone.now() - timedelta(hours=1)
        ticket.expires_at = timezone.now() - timedelta(minutes=1)
        ticket.save(update_fields=["issued_at", "expires_at"])

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-expired",
    )

    assert response.status_code == status.HTTP_409_CONFLICT


def test_validate_rejects_a_revoked_ticket() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)
    with platform_staff_bypass():
        ticket.status = Ticket.Status.REVOKED
        ticket.save(update_fields=["status"])

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-revoked",
    )

    assert response.status_code == status.HTTP_409_CONFLICT


def test_validate_rejects_the_wrong_trip() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    _booking, ticket, staff = _issue_ticket(client, business)
    other_booking, _other_ticket, _other_staff = _issue_ticket(client, business)

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(other_booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-wrong-trip",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_replaying_the_same_key_after_boarding_returns_the_identical_result() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)
    api = _auth_client(staff)
    url = reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)})
    body = {"payload": ticket.signed_payload}

    first = api.post(url, body, format="json", HTTP_IDEMPOTENCY_KEY="replay-1")
    second = api.post(url, body, format="json", HTTP_IDEMPOTENCY_KEY="replay-1")

    assert first.status_code == status.HTTP_200_OK
    assert second.status_code == status.HTTP_200_OK
    assert first.data == second.data


def test_a_different_key_against_an_already_boarded_ticket_is_a_conflict() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)
    api = _auth_client(staff)
    url = reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)})
    body = {"payload": ticket.signed_payload}

    api.post(url, body, format="json", HTTP_IDEMPOTENCY_KEY="first-scan")
    second = api.post(url, body, format="json", HTTP_IDEMPOTENCY_KEY="second-scan")

    assert second.status_code == status.HTTP_409_CONFLICT


def test_validate_returns_404_for_a_payload_with_no_matching_ticket() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, _ticket, staff = _issue_ticket(client, business)
    bogus_payload = signing.sign_ticket(
        booking_id=str(booking.id),
        seat_reservation_id="00000000-0000-0000-0000-000000000000",
        trip_id=str(booking.trip_id),
        seat_id="00000000-0000-0000-0000-000000000000",
        from_stop_id="00000000-0000-0000-0000-000000000000",
        to_stop_id="00000000-0000-0000-0000-000000000000",
        issued_at=timezone.now(),
        expires_at=timezone.now() + timedelta(hours=1),
    )

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": bogus_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-unknown",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND


# --- endpoint preconditions -------------------------------------------------


def test_validate_endpoint_requires_the_ticketing_validate_permission() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
    booking, ticket, _staff = _issue_ticket(client, business)

    response = _auth_client(passenger).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-forbidden",
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_validate_endpoint_requires_the_idempotency_key_header() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    booking, ticket, staff = _issue_ticket(client, business)

    response = _auth_client(staff).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking.trip_id)}),
        {"payload": ticket.signed_payload},
        format="json",
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_validate_endpoint_404s_for_a_trip_in_another_client() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_a.id)):
        business_a = BusinessFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
    booking_a, ticket_a, _staff_a = _issue_ticket(client_a, business_a)
    _booking_b, _ticket_b, staff_b = _issue_ticket(client_b, business_b)

    response = _auth_client(staff_b).post(
        reverse("ticket-validate", kwargs={"trip_id": str(booking_a.trip_id)}),
        {"payload": ticket_a.signed_payload},
        format="json",
        HTTP_IDEMPOTENCY_KEY="validate-cross-client",
    )

    assert response.status_code == status.HTTP_404_NOT_FOUND
