"""HTTP-level tests for POST/GET /payments/, /payments/mine/,
/payments/{id}/."""

from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.booking.tests.factories import BookingFactory
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

from .factories import PaystackAccountFactory

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


def test_post_payments_requires_the_idempotency_key_header() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    response = _auth_client(passenger).post(
        reverse("payment-list-create"), {"booking_id": str(booking.id)}
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_post_payments_rejects_paying_for_another_passengers_booking() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        owner = PassengerUserFactory(client=client)
        other = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=owner)

    response = _auth_client(other).post(
        reverse("payment-list-create"),
        {"booking_id": str(booking.id)},
        HTTP_IDEMPOTENCY_KEY="k1",
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_post_payments_success_returns_the_authorization_url() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    with patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)):
        response = _auth_client(passenger).post(
            reverse("payment-list-create"),
            {"booking_id": str(booking.id)},
            HTTP_IDEMPOTENCY_KEY="k1",
        )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["authorization_url"] == _FAKE_INIT_DATA["authorization_url"]
    assert response.data["status"] == "pending"


def test_post_payments_returns_404_when_no_paystack_account_configured() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    response = _auth_client(passenger).post(
        reverse("payment-list-create"),
        {"booking_id": str(booking.id)},
        HTTP_IDEMPOTENCY_KEY="k1",
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND


def test_get_payments_requires_the_payments_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).get(reverse("payment-list-create"))
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_staff_with_payments_view_can_list_payment_intents() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=passenger)

    with patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)):
        _auth_client(passenger).post(
            reverse("payment-list-create"),
            {"booking_id": str(booking.id)},
            HTTP_IDEMPOTENCY_KEY="k1",
        )

    response = _auth_client(staff).get(
        reverse("payment-list-create"), {"business": str(business.id)}
    )
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 1


def test_payments_mine_lists_only_the_callers_own_intents() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        passenger_a = PassengerUserFactory(client=client)
        passenger_b = PassengerUserFactory(client=client)
        booking_a = BookingFactory(client=client, business=business, passenger=passenger_a)
        booking_b = BookingFactory(client=client, business=business, passenger=passenger_b)

    with patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)):
        _auth_client(passenger_a).post(
            reverse("payment-list-create"),
            {"booking_id": str(booking_a.id)},
            HTTP_IDEMPOTENCY_KEY="a1",
        )
        _auth_client(passenger_b).post(
            reverse("payment-list-create"),
            {"booking_id": str(booking_b.id)},
            HTTP_IDEMPOTENCY_KEY="b1",
        )

    response = _auth_client(passenger_a).get(reverse("payment-mine"))
    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 1


def test_payment_detail_view_rejects_another_passengers_intent() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        PaystackAccountFactory(client=client, business=business)
        owner = PassengerUserFactory(client=client)
        other = PassengerUserFactory(client=client)
        booking = BookingFactory(client=client, business=business, passenger=owner)

    with patch("apps.payments.services.initialize_transaction", return_value=dict(_FAKE_INIT_DATA)):
        created = _auth_client(owner).post(
            reverse("payment-list-create"),
            {"booking_id": str(booking.id)},
            HTTP_IDEMPOTENCY_KEY="k1",
        )

    response = _auth_client(other).get(reverse("payment-detail", kwargs={"pk": created.data["id"]}))
    assert response.status_code == status.HTTP_404_NOT_FOUND
