"""Adversarial RLS proof for WhiteLabelConfig — mirrors
apps/clients/tests/test_kyc_rls.py's pattern (see
docs/specs/1-identity-client-business.md §8).
"""

import pytest
from django.db import connection

from apps.clients.models import WhiteLabelConfig
from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_white_label_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()

    with tenant_context(str(client_b.id)):
        config_b = WhiteLabelConfig.objects.create(client=client_b, domain="b.example.com")

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{WhiteLabelConfig._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(config_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_allows_platform_staff_to_see_any_clients_white_label_via_raw_sql() -> None:
    client_b = ClientFactory()

    with tenant_context(str(client_b.id)):
        config_b = WhiteLabelConfig.objects.create(client=client_b, domain="b2.example.com")

    set_rls_session_vars(None, is_platform_staff=True)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{WhiteLabelConfig._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(config_b.id)],
            )
            assert cursor.fetchone() is not None
    finally:
        set_rls_session_vars(None, False)
