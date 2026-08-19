"""Row-level security completeness + adversarial proof.

See docs/specs/1-identity-client-business.md §3 and docs/adr/0002. Two
tests:

1. A registry-driven completeness check — every concrete `BaseModel`
   subclass, enumerated via Django's own model registry (no allowlist),
   must have RLS enabled with a `tenant_isolation` policy. A future model
   that forgets `EnableRowLevelSecurity` in its migration fails this
   immediately.
2. An adversarial raw-SQL test proving RLS itself (not the ORM manager
   `test_tenancy.py` already covers) blocks cross-client PK-guessing.
"""

import pytest
from django.apps import apps as django_apps
from django.db import connection

from apps.clients.tests.factories import ClientFactory
from apps.core.models import BaseModel
from apps.core.rls import set_rls_session_vars
from apps.core.tests.tenancy import tenant_context
from apps.core.tests.testapp.models import TenancyProbe

pytestmark = pytest.mark.django_db


def _concrete_base_model_subclasses() -> list[type[BaseModel]]:
    return [
        model
        for model in django_apps.get_models()
        if issubclass(model, BaseModel) and not model._meta.abstract
    ]


def test_every_concrete_base_model_subclass_has_rls_enabled() -> None:
    models = _concrete_base_model_subclasses()
    assert models, "expected at least TenancyProbe to be registered"

    with connection.cursor() as cursor:
        for model in models:
            table = model._meta.db_table

            cursor.execute(
                "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = %s",
                [table],
            )
            row = cursor.fetchone()
            assert row is not None, f"{model.__name__}: table {table!r} not found"
            assert row[0] is True, (
                f"{model.__name__} ({table}) does not have row-level security "
                "enabled — add EnableRowLevelSecurity to its migration."
            )
            assert row[1] is True, (
                f"{model.__name__} ({table}) has RLS enabled but not FORCEd — "
                "the table's owner role (the app's own DB connection) would "
                "silently bypass the policy. Check EnableRowLevelSecurity "
                "includes the FORCE ROW LEVEL SECURITY statement."
            )

            cursor.execute(
                "SELECT 1 FROM pg_policies WHERE tablename = %s AND policyname = %s",
                [table, "tenant_isolation"],
            )
            assert cursor.fetchone() is not None, (
                f"{model.__name__} ({table}) has RLS enabled but no "
                "tenant_isolation policy — add EnableRowLevelSecurity to its migration."
            )


def test_rls_blocks_cross_client_pk_lookup_via_raw_sql() -> None:
    """The sharper case `test_tenancy.py` can't cover: this bypasses the
    ORM manager entirely, so only the database's own policy can save it."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(None, is_platform_staff=True):
        probe_b = TenancyProbe.all_objects.create(client=client_b, label="b")

    set_rls_session_vars(str(client_a.id), is_platform_staff=False)
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f'SELECT id FROM "{TenancyProbe._meta.db_table}" WHERE id = %s',  # noqa: S608
                [str(probe_b.id)],
            )
            assert cursor.fetchone() is None
    finally:
        set_rls_session_vars(None, False)
