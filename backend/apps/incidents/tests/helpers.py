"""Fixture builders for the incidents tests.

Every `BaseModel` row is created inside a `tenant_context` — RLS is
`FORCE`d, so an `INSERT` with no `app.current_client_id` set fails with
"new row violates row-level security policy". API calls are deliberately
*not* wrapped: the JWT establishes tenancy for those itself, and
wrapping them would hide a middleware regression.
"""

from __future__ import annotations

from typing import Any

from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    CustomerTokenObtainSerializer,
)
from apps.network.tests.factories import RouteFactory, StopFactory
from apps.scheduling.models import Trip
from apps.scheduling.tests.factories import TripFactory


def auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def passenger_client(user: User) -> APIClient:
    """The customer audience, not the client-admin one. Both mint a
    usable token, but a passenger endpoint reached with a client-admin
    token would not prove the customer app can reach it."""
    token = CustomerTokenObtainSerializer.get_token(user)
    api = APIClient()
    api.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return api


def business_for(client: Any, **overrides: Any) -> Business:
    with tenant_context(str(client.id)):
        return BusinessFactory(client=client, **overrides)


def trip_for(client: Any, business: Business) -> Trip:
    with tenant_context(str(client.id)):
        route = RouteFactory(client=client, business=business)
        return TripFactory(client=client, route=route)


def stop_for(client: Any, business: Business) -> Any:
    with tenant_context(str(client.id)):
        return StopFactory(client=client, business=business)
