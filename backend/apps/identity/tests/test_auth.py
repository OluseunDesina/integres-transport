from datetime import timedelta

import pytest
from django.conf import settings
from django.urls import reverse
from django.utils import timezone
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


# --- Session resilience (docs/specs/13-session-resilience.md) ---


def test_access_token_lifetime_is_sixty_minutes() -> None:
    """Asserted against the setting itself, not inferred from a token, so
    the value cannot drift silently. The frontend's refresh-on-401
    middleware is what makes a lifetime this short workable at all; if
    someone shortens it again, they should have to change this line and
    notice why it exists."""
    assert settings.SIMPLE_JWT["ACCESS_TOKEN_LIFETIME"] == timedelta(minutes=60)


def test_issued_access_tokens_carry_the_sixty_minute_window() -> None:
    """The setting assertion above proves configuration; this proves it
    reaches a token a real login actually hands out."""
    user = PassengerUserFactory(password="correct-horse")
    login = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )

    token = AccessToken(login.data["access"])

    assert token["exp"] - token["iat"] == int(timedelta(minutes=60).total_seconds())


def test_an_expired_access_token_is_rejected() -> None:
    """No time-travel dependency: the token is built already-expired
    rather than the clock being moved. Proves expiry is enforced at all,
    which is the half of the 401 story the middleware reacts to."""
    user = PassengerUserFactory()
    token = AccessToken.for_user(user)
    token.set_exp(from_time=timezone.now() - timedelta(minutes=120), lifetime=timedelta(minutes=60))

    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token}")

    assert client.get(reverse("me")).status_code == status.HTTP_401_UNAUTHORIZED


def test_token_refresh_rotates_the_refresh_token() -> None:
    """ROTATE_REFRESH_TOKENS is on, so the response carries a *new*
    refresh token. The frontend must persist it — storing only `access`
    is what silently kills a session once the original refresh expires."""
    user = PassengerUserFactory(password="correct-horse")
    login = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )

    refreshed = APIClient().post(reverse("token-refresh"), {"refresh": login.data["refresh"]})

    assert refreshed.status_code == status.HTTP_200_OK
    assert "refresh" in refreshed.data
    assert refreshed.data["refresh"] != login.data["refresh"]


def test_a_rotated_away_refresh_token_still_works() -> None:
    """**Pins the current security posture deliberately, including its
    weakness.** `BLACKLIST_AFTER_ROTATION` is False because the blacklist
    app is not installed and the setting was a silent no-op either way
    (see config/settings/base.py). Revocation is therefore bounded by
    REFRESH_TOKEN_LIFETIME alone.

    This is a change-detector, not an endorsement: installing
    `rest_framework_simplejwt.token_blacklist` flips this to 401 and
    fails here loudly — which is the moment to also solve the multi-tab
    refresh race in @auth's middleware, since blacklisting makes two
    tabs able to invalidate each other's session."""
    user = PassengerUserFactory(password="correct-horse")
    login = APIClient().post(
        reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
    )
    original_refresh = login.data["refresh"]
    APIClient().post(reverse("token-refresh"), {"refresh": original_refresh})

    reused = APIClient().post(reverse("token-refresh"), {"refresh": original_refresh})

    assert reused.status_code == status.HTTP_200_OK
