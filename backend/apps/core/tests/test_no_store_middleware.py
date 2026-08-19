"""NoStoreApiMiddleware — see apps.core.middleware's own docstring for
the real bug this closes (a stale browser-cached GET response, caught
live via Playwright once Route/Stop's list endpoints gained stable,
repeatable `?business=<id>` query strings)."""

import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def test_api_responses_are_never_cacheable() -> None:
    response = APIClient().get("/api/v1/health/")
    assert response.headers["Cache-Control"] == "no-store"


def test_non_api_paths_are_unaffected() -> None:
    response = APIClient().get("/admin/login/")
    cache_control = response.headers.get("Cache-Control")
    assert cache_control != "no-store"
