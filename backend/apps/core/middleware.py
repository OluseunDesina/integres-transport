"""Tenancy middleware: resolves the active Client for the request from
the JWT access token's custom `client_id` / `is_platform_staff` claims
(see apps.identity.serializers), and makes it available for the duration
of the request via `apps.core.context` (Python-level, read by
`TenantScopedManager`) *and* via Postgres session variables (DB-level,
read by the `tenant_isolation` RLS policy — see
`apps.core.migration_operations.EnableRowLevelSecurity` and
docs/specs/1-identity-client-business.md §3). This runs as plain Django
middleware — *before* DRF's own authentication classes run at view
dispatch — specifically so both layers are already correct by the time
any view code executes.

This is the last entry in `MIDDLEWARE` (nothing runs after it), so it
wraps `self.get_response(request)` — URL resolution through the view's
response — in its own `transaction.atomic()` block and sets the RLS
session variables immediately inside it, before calling onward. This is
deliberate, not `DATABASES["default"]["ATOMIC_REQUESTS"] = True`: Django's
`ATOMIC_REQUESTS` only wraps the view *callable* itself, which begins
executing after every middleware's pre-`get_response()` code (including
`process_view` hooks) has already run — a `SET LOCAL`/`set_config(...,
true)` issued before that point lands in its own auto-committed
mini-transaction and is gone before the view's queries ever run. Owning
the transaction here avoids that ordering trap; any exception raised
anywhere downstream (including inside the view) rolls this transaction
back, the same guarantee `ATOMIC_REQUESTS` promises.

Subdomain-based resolution for the white-labeled customer app is a
Phase 1 item once `WhiteLabelConfig` exists — see
docs/specs/1-identity-client-business.md §5. This middleware still
resolves tenancy from the JWT claim only.

An invalid/expired token is not an error here: it simply leaves no
active-client context, and DRF's authentication/permission classes are
what actually reject the request later. This middleware's only job is
tenancy *resolution*, not authentication.

`GET /api/v1/health/` is a documented exception: it's the liveness probe
and must return 200 even if Postgres is unreachable (a DB blip shouldn't
make an orchestrator kill an otherwise-healthy process — that's what
`/readiness/` is for). Wrapping every request in `transaction.atomic()`
would make even that endpoint require a DB connection, so it's excluded
by path before opening the transaction — the one hardcoded exception,
kept intentionally small and `reverse()`-derived rather than a literal
string, so it breaks loudly (not silently) if the URL ever moves.
"""

from collections.abc import Callable

from django.db import transaction
from django.http import HttpRequest, HttpResponse
from django.urls import reverse
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import AccessToken

from apps.core.context import (
    reset_current_client_id,
    reset_is_platform_staff,
    set_current_client_id,
    set_is_platform_staff,
)
from apps.core.rls import set_rls_session_vars


class TenancyMiddleware:
    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response
        self._db_independent_paths: set[str] | None = None

    def __call__(self, request: HttpRequest) -> HttpResponse:
        client_id, is_platform_staff = self._resolve_from_token(request)

        request.tenant_client_id = client_id  # type: ignore[attr-defined]
        request.is_platform_staff = is_platform_staff  # type: ignore[attr-defined]

        if request.path in self._get_db_independent_paths():
            return self.get_response(request)

        client_token = set_current_client_id(client_id)
        staff_token = set_is_platform_staff(is_platform_staff)
        try:
            with transaction.atomic():
                set_rls_session_vars(client_id, is_platform_staff)
                return self.get_response(request)
        finally:
            reset_current_client_id(client_token)
            reset_is_platform_staff(staff_token)

    def _get_db_independent_paths(self) -> set[str]:
        # Resolved lazily (not at import time) since the URLconf may not
        # be fully loaded yet when middleware classes are instantiated.
        if self._db_independent_paths is None:
            self._db_independent_paths = {reverse("health")}
        return self._db_independent_paths

    @staticmethod
    def _resolve_from_token(request: HttpRequest) -> tuple[str | None, bool]:
        header = request.META.get("HTTP_AUTHORIZATION", "")
        if not header.startswith("Bearer "):
            return None, False
        raw_token = header.removeprefix("Bearer ").strip()
        try:
            access = AccessToken(raw_token)
        except TokenError:
            return None, False
        client_id = access.get("client_id")
        is_platform_staff = bool(access.get("is_platform_staff", False))
        return client_id, is_platform_staff


class NoStoreApiMiddleware:
    """Every `/api/` response gets `Cache-Control: no-store` — this API
    has no cacheable endpoints (everything is dynamic, authenticated,
    tenant-scoped data) and, until this middleware, sent no
    Cache-Control header at all, leaving the browser free to apply its
    own heuristic freshness lifetime per RFC 7234 §4.2.2.

    This was a real, latent bug, not a defensive-only addition: it
    surfaced when Route/Stop's list endpoints gained `?business=<id>`
    filtering (Phase 3 profile-menu/business-switcher work) — before
    that, every list request's query string was different enough
    (varying pagination offsets, freshly created resource ids in
    surrounding test flows) that a heuristic cache hit was unlikely in
    practice. Once `?business=<id>&limit=25&offset=0` became a stable,
    frequently-repeated URL (switch Business, revisit the same list),
    a real browser served a stale cached response for it — caught live
    via Playwright, not by unit tests (Karma's HTTP mocking never
    exercises real browser cache behavior).
    """

    def __init__(self, get_response: Callable[[HttpRequest], HttpResponse]) -> None:
        self.get_response = get_response

    def __call__(self, request: HttpRequest) -> HttpResponse:
        response = self.get_response(request)
        if request.path.startswith("/api/"):
            response["Cache-Control"] = "no-store"
        return response
