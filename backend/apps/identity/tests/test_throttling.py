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


def test_repeated_login_attempts_are_throttled() -> None:
    user = PassengerUserFactory(password="correct-horse")

    responses = [
        APIClient().post(
            reverse("customer-token-obtain"), {"email": user.email, "password": "correct-horse"}
        )
        for _ in range(11)
    ]

    statuses = [r.status_code for r in responses]
    assert statuses.count(status.HTTP_200_OK) == 10
    assert statuses[-1] == status.HTTP_429_TOO_MANY_REQUESTS
