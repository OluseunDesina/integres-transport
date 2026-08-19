"""Adversarial RLS proof for FareRule/FareSegmentRule — mirrors
apps/network/tests/test_network_rls.py's pattern. The registry-driven
completeness test (apps/core/tests/test_row_level_security.py) picks up
both models automatically; this file proves RLS itself, not just that
it's enabled.
"""

import pytest
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context

from .factories import FareRuleFactory, FareSegmentRuleFactory

pytestmark = pytest.mark.django_db


def test_rls_blocks_cross_client_fare_rule_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        fare_rule_b = FareRuleFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "fares_farerule" WHERE id = %s',  # noqa: S608
                [str(fare_rule_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)


def test_rls_blocks_cross_client_fare_segment_rule_lookup_via_raw_sql() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(str(client_b.id)):
        fare_segment_rule_b = FareSegmentRuleFactory(client=client_b)

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                'SELECT id FROM "fares_faresegmentrule" WHERE id = %s',  # noqa: S608
                [str(fare_segment_rule_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
