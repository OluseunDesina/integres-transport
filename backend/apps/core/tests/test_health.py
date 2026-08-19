import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient


def test_health_endpoint_requires_no_auth() -> None:
    response = APIClient().get(reverse("health"))
    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "ok"


@pytest.mark.django_db
def test_readiness_endpoint_reports_database_reachable() -> None:
    response = APIClient().get(reverse("readiness"))
    assert response.status_code == status.HTTP_200_OK
    assert response.data["status"] == "ready"
