import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.models import Business
from apps.businesses.tests.factories import BusinessFactory
from apps.clients.models import Client
from apps.clients.tests.factories import ClientFactory
from apps.core.models import AuditLog
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _create_payload(**overrides: str) -> dict[str, str]:
    return {
        "vertical": "shuttle",
        "name": "Acme Lagos Shuttle",
        "currency": "NGN",
        "timezone": "Africa/Lagos",
        "booking_mode_default": "reservation",
        **overrides,
    }


def test_client_staff_can_create_a_business() -> None:
    client = ClientFactory(kyc_status=Client.KycStatus.PENDING)
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(reverse("business-list-create"), _create_payload())

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["kyb_status"] == Business.KybStatus.PENDING
    with tenant_context(str(client.id)):
        business = Business.objects.get(pk=response.data["id"])
    assert business.client_id == client.id


def test_business_creation_allowed_while_client_kyc_still_pending() -> None:
    """§6: KYB review is independent of the owning Client's own KYC."""
    client = ClientFactory(kyc_status=Client.KycStatus.PENDING)
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(reverse("business-list-create"), _create_payload())

    assert response.status_code == status.HTTP_201_CREATED
    client.refresh_from_db()
    assert client.kyc_status == Client.KycStatus.PENDING


def test_two_businesses_with_the_same_vertical_are_both_allowed() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    api = _auth_client(staff)

    first = api.post(reverse("business-list-create"), _create_payload(name="Lagos Route"))
    second = api.post(reverse("business-list-create"), _create_payload(name="Abuja Route"))

    assert first.status_code == status.HTTP_201_CREATED
    assert second.status_code == status.HTTP_201_CREATED


def test_business_creation_writes_an_audit_log_entry() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    _auth_client(staff).post(reverse("business-list-create"), _create_payload())

    entry = AuditLog.objects.get(action="business.created")
    assert entry.client_id == client.id


def test_passenger_cannot_create_a_business() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)

    response = _auth_client(passenger).post(reverse("business-list-create"), _create_payload())
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_list_only_returns_the_callers_own_businesses() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(None, is_platform_staff=True):
        BusinessFactory(client=client_a, name="A's business")
        BusinessFactory(client=client_b, name="B's business")

    response = _auth_client(staff_a).get(reverse("business-list-create"))

    assert response.status_code == status.HTTP_200_OK
    names = [row["name"] for row in response.data["results"]]
    assert names == ["A's business"]


def test_patch_updates_mutable_fields_and_is_audit_logged() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("business-update", kwargs={"pk": str(business.id)}), {"name": "Renamed Co"}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["name"] == "Renamed Co"
    entry = AuditLog.objects.get(action="business.updated")
    assert entry.metadata["name"] == "Renamed Co"


def test_patch_updates_fare_pricing_mode() -> None:
    """Phase 4 (docs/specs/4-fares-seating-booking.md §2): client-admin
    editable via this same endpoint, unlike seat_hold_minutes (Slice 2,
    super-admin-only)."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    assert business.fare_pricing_mode == Business.FarePricingMode.FLAT

    response = _auth_client(staff).patch(
        reverse("business-update", kwargs={"pk": str(business.id)}),
        {"fare_pricing_mode": "per_segment"},
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["fare_pricing_mode"] == "per_segment"
    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.fare_pricing_mode == Business.FarePricingMode.PER_SEGMENT


def test_patch_cannot_change_kyb_status() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).patch(
        reverse("business-update", kwargs={"pk": str(business.id)}),
        {"kyb_status": "approved"},
    )

    assert response.status_code == status.HTTP_200_OK
    with tenant_context(str(client.id)):
        business.refresh_from_db()
    assert business.kyb_status == Business.KybStatus.PENDING


def test_cross_client_patch_is_a_404_not_a_403() -> None:
    """RLS + the ORM manager make another client's row invisible, not
    merely forbidden — same distinction Slice 1 established."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)

    response = _auth_client(staff_a).patch(
        reverse("business-update", kwargs={"pk": str(business_b.id)}), {"name": "Hijacked"}
    )
    assert response.status_code == status.HTTP_404_NOT_FOUND
