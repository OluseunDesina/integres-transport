"""CORS preflight coverage.

The rest of the suite drives endpoints through the Django test client,
which never issues a preflight — so a missing entry in
`CORS_ALLOW_HEADERS` is invisible to every other test and only shows up
as a blocked request in a real browser. `Idempotency-Key` reached the
customer app that way: reads worked, `POST /bookings/` did not.
"""

import pytest
from django.test import Client

ORIGIN = "http://localhost:4200"


@pytest.fixture
def client() -> Client:
    return Client(SERVER_NAME="localhost")


def preflight(client: Client, path: str, requested_headers: str):
    return client.options(
        path,
        HTTP_ORIGIN=ORIGIN,
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS=requested_headers,
    )


def test_preflight_allows_idempotency_key(client: Client) -> None:
    response = preflight(client, "/api/v1/bookings/", "authorization,content-type,idempotency-key")

    assert response.status_code == 200
    allowed = {h.strip() for h in response["access-control-allow-headers"].lower().split(",")}
    assert "idempotency-key" in allowed


def test_preflight_still_allows_authorization(client: Client) -> None:
    """Extending the header list must not replace django-cors-headers'
    defaults — every authenticated call in all three apps depends on
    Authorization surviving."""
    response = preflight(client, "/api/v1/bookings/", "authorization")

    allowed = {h.strip() for h in response["access-control-allow-headers"].lower().split(",")}
    assert {"authorization", "content-type"} <= allowed


def test_preflight_rejects_unknown_origin(client: Client) -> None:
    response = client.options(
        "/api/v1/bookings/",
        HTTP_ORIGIN="http://evil.example.com",
        HTTP_ACCESS_CONTROL_REQUEST_METHOD="POST",
        HTTP_ACCESS_CONTROL_REQUEST_HEADERS="authorization",
    )

    assert "access-control-allow-origin" not in response
