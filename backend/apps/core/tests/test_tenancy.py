"""Cross-client isolation harness — the mandatory test named in the
brief's testing bar, proving `BaseModel`/`TenantScopedManager` block
cross-client access before any real business model exists (see
docs/adr/0002-tenancy-enforcement.md and the Phase 0 plan).
"""

import pytest
from rest_framework_simplejwt.tokens import AccessToken

from apps.clients.tests.factories import ClientFactory
from apps.core.middleware import TenancyMiddleware
from apps.core.tests.tenancy import tenant_context
from apps.core.tests.testapp.models import TenancyProbe

pytestmark = pytest.mark.django_db


def test_tenant_scoped_manager_only_returns_active_client_rows() -> None:
    client_a = ClientFactory()
    client_b = ClientFactory()
    # RLS now enforces client_id at the DB level for every command,
    # including INSERT (see apps.core.rls) — fixture rows spanning two
    # clients must be created under a platform-staff session, the only
    # one the tenant_isolation policy lets write cross-client rows.
    with tenant_context(None, is_platform_staff=True):
        probe_a = TenancyProbe.all_objects.create(client=client_a, label="a")
        probe_b = TenancyProbe.all_objects.create(client=client_b, label="b")

    with tenant_context(str(client_a.id)):
        visible_ids = set(TenancyProbe.objects.values_list("id", flat=True))

    assert visible_ids == {probe_a.id}
    assert probe_b.id not in visible_ids


def test_client_a_cannot_fetch_client_b_row_by_primary_key() -> None:
    """The sharper adversarial case: knowing another client's row's PK
    must not be enough to read it through the scoped manager."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(None, is_platform_staff=True):
        TenancyProbe.all_objects.create(client=client_a, label="a")
        probe_b = TenancyProbe.all_objects.create(client=client_b, label="b")

    with tenant_context(str(client_a.id)), pytest.raises(TenancyProbe.DoesNotExist):
        TenancyProbe.objects.get(pk=probe_b.id)


def test_no_active_client_context_returns_no_rows() -> None:
    """An anonymous / client-less request must never fall back to 'all
    rows' — the scoped manager fails closed, not open."""
    client_a = ClientFactory()
    with tenant_context(str(client_a.id)):
        TenancyProbe.all_objects.create(client=client_a, label="a")

    assert list(TenancyProbe.objects.all()) == []


def test_soft_deleted_rows_are_excluded_by_default_manager() -> None:
    client_a = ClientFactory()
    with tenant_context(str(client_a.id)):
        probe = TenancyProbe.all_objects.create(client=client_a, label="a")
        probe.soft_delete()

        assert list(TenancyProbe.objects.all()) == []
        assert TenancyProbe.all_objects.filter(pk=probe.pk).exists()


def test_all_objects_still_requires_platform_staff_for_cross_client_rows() -> None:
    """`all_objects` only bypasses the ORM's own client_id filter — it was
    never meant to bypass the database's RLS policy, and post-RLS it
    can't. A merely client-scoped session (even reading through
    `all_objects`) still only sees its own client's rows; only a
    platform-staff session sees across clients. This is the point of
    adding RLS as a *second*, independent layer, not a restatement of the
    ORM-level test above."""
    client_a = ClientFactory()
    client_b = ClientFactory()
    with tenant_context(None, is_platform_staff=True):
        TenancyProbe.all_objects.create(client=client_a, label="a")
        TenancyProbe.all_objects.create(client=client_b, label="b")

    with tenant_context(str(client_a.id)):
        assert TenancyProbe.all_objects.count() == 1

    with tenant_context(None, is_platform_staff=True):
        assert TenancyProbe.all_objects.count() == 2


def test_middleware_resolves_client_id_from_jwt_claim(rf) -> None:  # type: ignore[no-untyped-def]
    """Proves the middleware wiring itself, not just the manager: a
    request carrying a JWT with a `client_id` claim results in that
    client being the active tenancy context for the downstream view."""
    client_a = ClientFactory()
    token = AccessToken()
    token["client_id"] = str(client_a.id)
    token["is_platform_staff"] = False

    seen: dict[str, object] = {}

    def downstream_view(request: object) -> str:
        from apps.core.context import get_current_client_id, get_is_platform_staff

        seen["client_id"] = get_current_client_id()
        seen["is_platform_staff"] = get_is_platform_staff()
        return "ok"

    middleware = TenancyMiddleware(downstream_view)
    # Deliberately not /api/v1/health/ — that path is exempted from the
    # transaction/RLS wrapping entirely (see TenancyMiddleware), which
    # would make this test pass for the wrong reason.
    request = rf.get("/api/v1/me/", HTTP_AUTHORIZATION=f"Bearer {token}")
    middleware(request)

    assert seen["client_id"] == str(client_a.id)
    assert seen["is_platform_staff"] is False


def test_middleware_leaves_no_active_client_for_invalid_token(rf) -> None:  # type: ignore[no-untyped-def]
    seen: dict[str, object] = {}

    def downstream_view(request: object) -> str:
        from apps.core.context import get_current_client_id

        seen["client_id"] = get_current_client_id()
        return "ok"

    middleware = TenancyMiddleware(downstream_view)
    request = rf.get("/api/v1/health/", HTTP_AUTHORIZATION="Bearer not-a-real-token")
    middleware(request)

    assert seen["client_id"] is None
