import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from apps.clients.tests.factories import ClientFactory
from apps.identity.tests.factories import (
    ClientStaffUserFactory,
    PassengerUserFactory,
    PlatformStaffUserFactory,
)

pytestmark = pytest.mark.django_db


def test_passenger_can_obtain_customer_token() -> None:
    user = PassengerUserFactory(password="correct-horse")
    response = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    assert response.status_code == status.HTTP_200_OK
    access = AccessToken(response.data["access"])
    assert access["aud"] == "integra-customer-app"
    assert access["client_id"] == str(user.client_id)
    assert access["is_platform_staff"] is False


def test_client_staff_cannot_obtain_customer_token() -> None:
    user = ClientStaffUserFactory(password="correct-horse")
    response = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_client_staff_can_obtain_client_admin_token() -> None:
    user = ClientStaffUserFactory(password="correct-horse")
    response = APIClient().post(
        reverse("client-admin-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    assert response.status_code == status.HTTP_200_OK
    access = AccessToken(response.data["access"])
    assert access["aud"] == "integra-client-admin-app"


def test_passenger_cannot_obtain_client_admin_token() -> None:
    user = PassengerUserFactory(password="correct-horse")
    response = APIClient().post(
        reverse("client-admin-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_platform_staff_can_obtain_super_admin_token_with_no_client_claim() -> None:
    user = PlatformStaffUserFactory(password="correct-horse")
    response = APIClient().post(
        reverse("super-admin-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    assert response.status_code == status.HTTP_200_OK
    access = AccessToken(response.data["access"])
    assert access["aud"] == "integra-super-admin-app"
    assert access["client_id"] is None
    assert access["is_platform_staff"] is True


def test_tenant_staff_cannot_obtain_super_admin_token() -> None:
    user = ClientStaffUserFactory(password="correct-horse")
    response = APIClient().post(
        reverse("super-admin-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_same_email_may_exist_independently_under_two_different_clients() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    PassengerUserFactory(email="shared@example.com", client=client_a)
    # Must not raise IntegrityError: uniqueness is scoped per-client.
    PassengerUserFactory(email="shared@example.com", client=client_b)


def test_login_with_duplicate_email_across_clients_requires_client_disambiguation() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    PassengerUserFactory(email="shared@example.com", client=client_a, password="pw-a")
    PassengerUserFactory(email="shared@example.com", client=client_b, password="pw-b")

    ambiguous = APIClient().post(
        reverse("customer-token-obtain"), {"email": "shared@example.com", "password": "pw-a"}
    )
    assert ambiguous.status_code == status.HTTP_400_BAD_REQUEST

    disambiguated = APIClient().post(
        reverse("customer-token-obtain"),
        {"email": "shared@example.com", "password": "pw-a", "client": str(client_a.id)},
    )
    assert disambiguated.status_code == status.HTTP_200_OK
    access = AccessToken(disambiguated.data["access"])
    assert access["client_id"] == str(client_a.id)


def test_duplicate_email_within_same_client_is_rejected() -> None:
    from django.db import IntegrityError

    client_a = ClientFactory()
    PassengerUserFactory(email="dup@example.com", client=client_a)
    with pytest.raises(IntegrityError):
        PassengerUserFactory(email="dup@example.com", client=client_a)


def test_me_endpoint_requires_authentication() -> None:
    response = APIClient().get(reverse("me"))
    assert response.status_code == status.HTTP_401_UNAUTHORIZED


def test_me_endpoint_returns_authenticated_user() -> None:
    user = PassengerUserFactory(password="correct-horse")
    login = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {login.data['access']}")
    response = client.get(reverse("me"))
    assert response.status_code == status.HTTP_200_OK
    assert response.data["email"] == user.email


def test_token_refresh_issues_a_new_access_token_carrying_the_same_custom_claims() -> None:
    user = PassengerUserFactory(password="correct-horse")
    login = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )

    refresh_response = APIClient().post(
        reverse("token-refresh"), {"refresh": login.data["refresh"]}
    )

    assert refresh_response.status_code == status.HTTP_200_OK
    new_access = AccessToken(refresh_response.data["access"])
    assert new_access["aud"] == "integra-customer-app"
    assert new_access["client_id"] == str(user.client_id)
    assert new_access["is_platform_staff"] is False


def test_token_refresh_rejects_an_invalid_refresh_token() -> None:
    response = APIClient().post(reverse("token-refresh"), {"refresh": "not-a-real-token"})
    assert response.status_code == status.HTTP_401_UNAUTHORIZED
