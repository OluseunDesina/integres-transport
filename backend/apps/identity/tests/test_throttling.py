"""Proves the "auth_login_customer" throttle scope actually triggers — the
brief's cross-cutting requirement is rate limiting on auth endpoints,
demonstrated firing, not just configured. Cache isolation between tests
is handled by the autouse fixture in the repo-root conftest.py.
"""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.identity.tests.factories import PassengerUserFactory

pytestmark = pytest.mark.django_db

_TEST_PASSWORD = "correct-horse"  # noqa: S105  # nosec B105


def test_repeated_login_attempts_are_throttled() -> None:
    user = PassengerUserFactory(password=_TEST_PASSWORD)

    responses = [
        APIClient().post(
            reverse("customer-token-obtain"), {"email": user.email, "password": _TEST_PASSWORD}  # noqa: S106
        )
        for _ in range(11)
    ]

    statuses = [r.status_code for r in responses]
    assert statuses.count(status.HTTP_200_OK) == 10
    assert statuses[-1] == status.HTTP_429_TOO_MANY_REQUESTS
