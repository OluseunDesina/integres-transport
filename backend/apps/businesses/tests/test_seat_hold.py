"""Super-admin-only seat-hold-duration endpoint — see docs/adr/0004 and
docs/specs/4-fares-seating-booking.md §3."""

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import (
    ClientAdminTokenObtainSerializer,
    SuperAdminTokenObtainSerializer,
)
from apps.identity.tests.factories import ClientStaffUserFactory, PlatformStaffUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User, *, platform_staff: bool = False) -> APIClient:
    serializer_cls = (
        SuperAdminTokenObtainSerializer if platform_staff else ClientAdminTokenObtainSerializer
    )
    token = serializer_cls.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def test_platform_staff_can_read_current_seat_hold_minutes() -> None:
    """GET is what closes the UI gap — a way to see the current value
    before editing it, mirroring PaystackAccountConfigView's own
    GET-before-PATCH precedent."""
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).get(
        reverse("business-seat-hold", kwargs={"pk": str(business.id)})
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data == {"id": str(business.id), "seat_hold_minutes": 15}


def test_client_admin_staff_cannot_read_seat_hold_minutes() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).get(
        reverse("business-seat-hold", kwargs={"pk": str(business.id)})
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_platform_staff_can_update_seat_hold_minutes() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    assert business.seat_hold_minutes == 15
    platform_staff = PlatformStaffUserFactory()

    response = _auth_client(platform_staff, platform_staff=True).patch(
        reverse("business-seat-hold", kwargs={"pk": str(business.id)}),
        {"seat_hold_minutes": 20},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["seat_hold_minutes"] == 20
    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.seat_hold_minutes == 20
    entry = AuditLog.objects.get(action="business.seat_hold_updated")
    assert entry.metadata["seat_hold_minutes"] == 20


def test_client_admin_staff_cannot_update_seat_hold_minutes() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("business-seat-hold", kwargs={"pk": str(business.id)}),
        {"seat_hold_minutes": 20},
    )

    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_ordinary_business_patch_cannot_change_seat_hold_minutes() -> None:
    """docs/adr/0004: seat_hold_minutes is deliberately not part of
    BusinessSerializer's writable fields — a client-admin PATCH that
    includes it must simply have no effect, not error, matching
    Business's existing `test_patch_cannot_change_kyb_status` precedent
    for a read-only-from-this-endpoint field."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("business-update", kwargs={"pk": str(business.id)}),
        {"seat_hold_minutes": 999},
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.seat_hold_minutes == 15


def test_unauthenticated_request_is_rejected() -> None:
    client = ClientFactory()
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = APIClient().patch(
        reverse("business-seat-hold", kwargs={"pk": str(business.id)}),
        {"seat_hold_minutes": 20},
    )
    assert response.status_code == status.HTTP_401_UNAUTHORIZED
