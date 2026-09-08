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


def test_currency_must_be_a_3_letter_iso_4217_code() -> None:
    """A currency *name* like "Naira" instead of the code "NGN" used to
    pass every check up to this app's own boundary and only fail once
    apps.payments sent it on to Paystack's API — see docs/specs/
    7-passenger-wallet.md's Implementation note for the incident this
    closes."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"), _create_payload(currency="Naira")
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "currency" in response.data


def test_a_well_formed_but_unsupported_currency_is_rejected() -> None:
    """The old RegexValidator only checked the *shape*, so `GBP` — a real
    ISO 4217 code the platform cannot actually collect in — saved
    cleanly and only failed later at Paystack. `currency` is a choice
    list now, not a pattern."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"), _create_payload(currency="GBP")
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "currency" in response.data


def test_botswana_pula_is_accepted_despite_having_no_psp() -> None:
    """docs/adr/0007 treats Botswana as a named open gap, not a market
    to quietly make unonboardable — so BWP stays selectable even though
    Paystack doesn't operate there."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"),
        _create_payload(currency="BWP", timezone="Africa/Gaborone"),
    )

    assert response.status_code == status.HTTP_201_CREATED


def test_timezone_must_be_a_real_iana_zone() -> None:
    """`timezone` was previously an unvalidated free-text field — a typo
    saved fine and only surfaced much later as a ZoneInfoNotFoundError
    inside trip generation or settlement-period arithmetic."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"), _create_payload(timezone="Africa/Lagoss")
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "timezone" in response.data


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


def test_the_three_booking_mode_axes_default_when_omitted() -> None:
    """All three have model defaults, so DRF marks them `required=False`
    and leaves them out of `validated_data` entirely when a request
    omits them. `BusinessSerializer.create()` indexes explicitly rather
    than splatting, so each needs its own `.get()` fallback — the exact
    gap that bit `fare_pricing_mode` when Phase 4 added it
    (docs/specs/10-booking-modes.md)."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(reverse("business-list-create"), _create_payload())

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["fare_collection_mode"] == Business.FareCollectionMode.PREPAID
    assert response.data["seat_selection_enabled"] is True
    assert response.data["capacity_enforced"] is True


def test_client_staff_can_create_an_open_seating_pay_as_you_go_business() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"),
        _create_payload(
            booking_mode_default="open_seating",
            fare_collection_mode="pay_as_you_go",
            capacity_enforced="false",
        ),
    )

    assert response.status_code == status.HTTP_201_CREATED
    with tenant_context(str(client.id)):
        business = Business.objects.get(pk=response.data["id"])
    assert business.booking_mode_default == Business.BookingMode.OPEN_SEATING
    assert business.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO
    assert business.capacity_enforced is False


def test_tap_and_go_is_no_longer_a_bookable_mode() -> None:
    """It was never a booking mode — it conflated what you buy with when
    you pay. Rejecting it here is what stops a caller re-creating the
    conflation the backfill just undid."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"), _create_payload(booking_mode_default="tap_and_go")
    )

    assert response.status_code == status.HTTP_400_BAD_REQUEST
    assert "booking_mode_default" in response.data


def test_the_two_mode_specific_booleans_are_not_validated_against_the_mode() -> None:
    """Storing an inert value is harmless and keeps a Business's settings
    stable across a mode switch and back. The UI hides the irrelevant
    one; the model deliberately does not reject it."""
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)

    response = _auth_client(staff).post(
        reverse("business-list-create"),
        _create_payload(
            booking_mode_default="reservation",
            # Meaningful only for open seating, set on a reservation
            # business.
            capacity_enforced="false",
        ),
    )

    assert response.status_code == status.HTTP_201_CREATED
    assert response.data["capacity_enforced"] is False


# --- ?search= on the Client-scoped GET /businesses/ --------------------
# docs/specs/14-design-system-and-ui-rebuild.md slice 3b. This endpoint's
# first query param; the cross-client super-admin list has had its own
# since Phase 5.


def test_business_list_search_matches_name_case_insensitively() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        match = BusinessFactory(client=client, name="Lagos Shuttle Co")
        BusinessFactory(client=client, name="Abuja Intercity")

    response = _auth_client(staff).get(reverse("business-list-create"), {"search": "lagos"})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(match.id)]


def test_business_list_search_with_no_match_returns_empty_not_everything() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        BusinessFactory(client=client, name="Lagos Shuttle Co")

    response = _auth_client(staff).get(reverse("business-list-create"), {"search": "nothing"})

    assert response.data["count"] == 0


def test_business_list_blank_search_is_accepted_and_ignored() -> None:
    client = ClientFactory()
    staff = ClientStaffUserFactory(client=client)
    with tenant_context(str(client.id)):
        BusinessFactory(client=client, name="Lagos Shuttle Co")

    response = _auth_client(staff).get(reverse("business-list-create"), {"search": ""})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 1


def test_business_list_search_never_reaches_another_clients_rows() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    staff_a = ClientStaffUserFactory(client=client_a)
    with tenant_context(str(client_b.id)):
        BusinessFactory(client=client_b, name="Lagos Shuttle Co")

    response = _auth_client(staff_a).get(reverse("business-list-create"), {"search": "lagos"})

    assert response.status_code == status.HTTP_200_OK
    assert response.data["count"] == 0
