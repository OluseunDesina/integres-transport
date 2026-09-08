"""Reusable adversarial cross-client testing helper.

Every future app's test suite is expected to import `tenant_context` (and,
for HTTP-level tests, `issue_access_token`) to prove that a request/query
scoped to one Client cannot see another Client's rows — per endpoint, not
just per model, per the brief's testing bar.
"""

from collections.abc import Iterator
from contextlib import contextmanager

from apps.core.context import (
    get_current_client_id,
    get_is_platform_staff,
    reset_current_client_id,
    reset_is_platform_staff,
    set_current_client_id,
    set_is_platform_staff,
)
from apps.core.rls import set_rls_session_vars


@contextmanager
def tenant_context(client_id: str | None, *, is_platform_staff: bool = False) -> Iterator[None]:
    """Simulate `TenancyMiddleware` having resolved `client_id` for the
    duration of the `with` block, without needing a real HTTP request.

    Sets both the Python contextvar (read by `TenantScopedManager`) and the
    Postgres session variables (read by the `tenant_isolation` RLS policy —
    see `apps.core.rls`), so a `Model.all_objects.create(...)` or query made
    inside the block is valid under RLS too, not just under the ORM's own
    filtering. The Postgres side is transaction-scoped
    (`set_config(..., true)`, equivalent to `SET LOCAL`) — every caller
    today is a `pytest.mark.django_db` test, which already wraps each test
    in an open transaction.

    **Safe to nest.** On exit it restores the RLS session variables to
    whatever context is still open rather than blanking them. Blanking
    was a real bug: a helper that opens its own `tenant_context` — like
    `apps.payments.tests.booking_helpers.booking_with_a_held_seat` —
    left `app.current_client_id` NULL when it returned, so the *caller's*
    next insert failed with "new row violates row-level security policy"
    even though the caller's own `with` block was still open. The Python
    contextvars were always restored correctly via their tokens; only
    the Postgres side was reset unconditionally.

    This is the same defect, and the same fix in spirit, that
    `apps.core.rls.platform_staff_bypass` already carries a nesting
    depth counter for. No counter is needed here because the contextvar
    tokens already carry the previous state — reading them back after
    the reset gives the correct value at any nesting depth, and gives
    `(None, False)` at the outermost level, exactly as before.
    """
    client_token = set_current_client_id(client_id)
    staff_token = set_is_platform_staff(is_platform_staff)
    set_rls_session_vars(client_id, is_platform_staff)
    try:
        yield
    finally:
        reset_current_client_id(client_token)
        reset_is_platform_staff(staff_token)
        set_rls_session_vars(get_current_client_id(), get_is_platform_staff())
