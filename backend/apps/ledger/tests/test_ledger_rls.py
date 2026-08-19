"""Adversarial RLS proof for apps.ledger — mirrors
apps/tapngo/tests/test_tapngo_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
LedgerAccount/SettlementRun/JournalEntry/JournalLine automatically; this
file proves RLS itself, not just that it's enabled — including the one
genuinely new case this app introduces: a LedgerAccount row with a NULL
client_id (the platform commission account) must stay invisible to an
ordinary tenant, not just to a different tenant.
"""

import pytest
from django.db import connection

from apps.businesses.tests.factories import BusinessFactory
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from ..models import LedgerAccount
from ..services import get_or_create_commission_account
from .factories import LedgerAccountFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_ledger_account_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        business_b = BusinessFactory(client=client_b)
        account_b = LedgerAccountFactory(client=client_b, business=business_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "ledger_ledgeraccount" WHERE id = %s',  # noqa: S608
                [str(account_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_the_platform_commission_account_is_invisible_to_an_ordinary_tenant() -> None:
    commission = get_or_create_commission_account()
    client = ClientFactory()

    set_rls_session_vars(str(client.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "ledger_ledgeraccount" WHERE id = %s',  # noqa: S608
                [str(commission.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)

    assert list(LedgerAccount.objects.filter(pk=commission.id)) == []


def test_the_platform_commission_account_is_visible_under_platform_staff_bypass() -> None:
    commission = get_or_create_commission_account()

    set_rls_session_vars(None, is_platform_staff=True)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "ledger_ledgeraccount" WHERE id = %s',  # noqa: S608
                [str(commission.id)],
            )
            assert cursor.fetchone() is not None
    finally:
        set_rls_session_vars(None, False)
