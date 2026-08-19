from decimal import Decimal

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.tests.tenancy import tenant_context
from apps.identity.models import User
from apps.identity.serializers import ClientAdminTokenObtainSerializer
from apps.identity.services import create_default_roles
from apps.identity.tests.factories import ClientStaffUserFactory, PassengerUserFactory

from ..models import JournalEntry
from ..services import (
    JournalLineInput,
    get_or_create_business_clearing_account,
    get_or_create_commission_account,
    get_or_create_wallet_account,
    post_journal_entry,
)
from .factories import LedgerAccountFactory

pytestmark = pytest.mark.django_db


def _auth_client(user: User) -> APIClient:
    token = ClientAdminTokenObtainSerializer.get_token(user)
    client = APIClient()
    client.credentials(HTTP_AUTHORIZATION=f"Bearer {token.access_token}")
    return client


def _post_a_payment_entry(*, client: object, business: object) -> JournalEntry:  # type: ignore[no-untyped-def]
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        passenger = PassengerUserFactory(client=client)
        wallet = get_or_create_wallet_account(client=client, business=business, passenger=passenger)
        clearing = get_or_create_business_clearing_account(client=client, business=business)
    commission = get_or_create_commission_account()
    with tenant_context(str(client.id)):  # type: ignore[attr-defined]
        return post_journal_entry(
            business=business,
            entry_type=JournalEntry.EntryType.PAYMENT,
            lines=[
                JournalLineInput(account=wallet, amount=Decimal("-100.00"), currency="NGN"),
                JournalLineInput(account=clearing, amount=Decimal("95.00"), currency="NGN"),
                JournalLineInput(account=commission, amount=Decimal("5.00"), currency="NGN"),
            ],
        )


# --- GET /ledger/accounts/ ------------------------------------------------


def test_ledger_account_list_requires_the_ledger_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(passenger).get(
        reverse("ledger-account-list"), {"business": str(business.id)}
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_ledger_account_list_requires_a_business_query_param() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])

    response = _auth_client(staff).get(reverse("ledger-account-list"))
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_staff_with_ledger_view_can_list_their_business_accounts() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
        account = LedgerAccountFactory(client=client, business=business)

    response = _auth_client(staff).get(
        reverse("ledger-account-list"), {"business": str(business.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(account.id)]


def test_ledger_account_list_never_returns_another_clients_accounts() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    roles_a = create_default_roles(client_a)
    staff_a = ClientStaffUserFactory(client=client_a, role=roles_a["Owner"])
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
        LedgerAccountFactory(client=client_b, business=business_b)

    response = _auth_client(staff_a).get(
        reverse("ledger-account-list"), {"business": str(business_b.id)}
    )

    # `_resolve_business` looks the id up via `Business.objects`
    # (`TenantScopedManager`), already scoped to client_a's session — a
    # real cross-client business id doesn't resolve at all, the same
    # `DoesNotExist -> 400` shape `apps.tapngo.serializers._resolve_trip`
    # already establishes for the same kind of query-param FK lookup.
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_ledger_account_list_never_exposes_the_platform_commission_account() -> None:
    get_or_create_commission_account()
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(staff).get(
        reverse("ledger-account-list"), {"business": str(business.id)}
    )

    assert response.status_code == status.HTTP_200_OK
    assert response.data["results"] == []


# --- GET /ledger/entries/ -------------------------------------------------


def test_journal_entry_list_requires_the_ledger_view_permission() -> None:
    client = ClientFactory()
    passenger = PassengerUserFactory(client=client)
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)

    response = _auth_client(passenger).get(
        reverse("ledger-entry-list"), {"business": str(business.id)}
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


def test_staff_with_ledger_view_can_list_entries_with_nested_lines() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    entry = _post_a_payment_entry(client=client, business=business)

    response = _auth_client(staff).get(reverse("ledger-entry-list"), {"business": str(business.id)})

    assert response.status_code == status.HTTP_200_OK
    assert [row["id"] for row in response.data["results"]] == [str(entry.id)]
    lines = response.data["results"][0]["lines"]
    assert len(lines) == 3
    assert sum(Decimal(line["amount"]) for line in lines) == Decimal("0.00")


def test_journal_entry_list_can_filter_by_account() -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    entry = _post_a_payment_entry(client=client, business=business)
    with tenant_context(str(client.id)):
        clearing = get_or_create_business_clearing_account(client=client, business=business)
        unrelated_account = LedgerAccountFactory(client=client, business=business)

    matching = _auth_client(staff).get(
        reverse("ledger-entry-list"), {"business": str(business.id), "account": str(clearing.id)}
    )
    non_matching = _auth_client(staff).get(
        reverse("ledger-entry-list"),
        {"business": str(business.id), "account": str(unrelated_account.id)},
    )

    assert matching.status_code == status.HTTP_200_OK
    assert [row["id"] for row in matching.data["results"]] == [str(entry.id)]
    assert non_matching.status_code == status.HTTP_200_OK
    assert non_matching.data["results"] == []


def test_journal_entry_list_never_returns_another_clients_entries() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    roles_a = create_default_roles(client_a)
    staff_a = ClientStaffUserFactory(client=client_a, role=roles_a["Owner"])
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
    _post_a_payment_entry(client=client_b, business=business_b)

    response = _auth_client(staff_a).get(
        reverse("ledger-entry-list"), {"business": str(business_b.id)}
    )

    # Same cross-client-id-doesn't-resolve shape as the accounts list
    # above — `_resolve_business` is scoped to client_a's session.
    assert response.status_code == status.HTTP_400_BAD_REQUEST


def test_journal_entry_list_query_count_does_not_scale_with_entry_count(
    django_assert_max_num_queries,
) -> None:
    client = ClientFactory()
    roles = create_default_roles(client)
    staff = ClientStaffUserFactory(client=client, role=roles["Owner"])
    with tenant_context(str(client.id)):
        business = BusinessFactory(client=client)
    for _ in range(5):
        _post_a_payment_entry(client=client, business=business)

    with django_assert_max_num_queries(12):
        response = _auth_client(staff).get(
            reverse("ledger-entry-list"), {"business": str(business.id)}
        )

    assert response.status_code == status.HTTP_200_OK
    assert len(response.data["results"]) == 5
    for row in response.data["results"]:
        assert len(row["lines"]) == 3
