"""Postgres Row-Level Security session variables.

`EnableRowLevelSecurity` (see `apps.core.migration_operations`) installs a
`tenant_isolation` policy on a table that reads two session-scoped GUCs:
`app.current_client_id` and `app.is_platform_staff`. This module is the one
place that writes them, via `set_config(..., true)` (transaction-scoped,
equivalent to `SET LOCAL`) so both real requests (`TenancyMiddleware`) and
tests (`apps.core.tests.tenancy.tenant_context`) stay in sync with the
policy's exact semantics — in particular, passing `client_id=None` resets
the setting (Postgres's documented behaviour for `set_config(name, NULL,
...)`), which is what makes an anonymous request fail closed rather than
crash on the policy's `::uuid` cast of an empty string.

Anything that creates or reads RLS-protected rows outside an HTTP request
(a management command, a Celery task) must call `set_rls_session_vars`
itself inside an open transaction — see the "Known Phase 0 limitations"
note in CLAUDE.md. `seed_e2e_users` doesn't need this yet: it only touches
`Client`/`User`, neither of which is RLS-protected.
"""

from collections.abc import Iterator
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar

from django.db import connection, transaction

from apps.core.context import get_current_client_id, get_is_platform_staff

# Tracks `platform_staff_bypass()` nesting depth — see that function's
# own docstring for why this is necessary, not just defensive.
_bypass_depth: ContextVar[int] = ContextVar("platform_staff_bypass_depth", default=0)


def set_rls_session_vars(client_id: str | None, is_platform_staff: bool) -> None:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT set_config('app.current_client_id', %s, true)",
            [client_id],
        )
        cursor.execute(
            "SELECT set_config('app.is_platform_staff', %s, true)",
            ["true" if is_platform_staff else "false"],
        )


@contextmanager
def platform_staff_bypass() -> Iterator[None]:
    """Temporarily grants the platform-staff RLS bypass for system-level
    code that legitimately needs to read/write across tenancy boundaries
    without an authenticated platform-staff request — e.g. resolving a
    `StaffInvitation` by its (secret, unguessable) token, where the token
    itself is the authorization, not a JWT; or `create_default_roles`
    seeding a fresh Client's Role rows before any staff session exists.

    Restores whatever RLS state was active before the block, so it's safe
    to use inside an already-authenticated request without clobbering
    that request's real tenancy context. Queries inside the block must
    use `Model.all_objects`, not `.objects` — this only changes the
    Postgres-level GUCs, not the Python contextvar `TenantScopedManager`
    reads (deliberately: nothing here needs `.objects` to see rows, and
    touching the Python contextvar too would be one more thing to get
    wrong for no benefit).

    Narrow, deliberate escape hatch — same spirit as `all_objects` itself.
    Don't reach for this unless the caller has already established
    authorization some other way.

    `set_config(..., true)` is `SET LOCAL` semantics — it only survives
    for the current transaction. Callers already inside one (a request,
    wrapped by `TenancyMiddleware`; `register_client`'s explicit
    `atomic()`) are fine. A Celery task has no ambient transaction at
    all — in Postgres autocommit mode, each statement is its own
    transaction, so the GUC set here would already be gone by the next
    statement (a real bug this caught: `send_staff_invitation_email`
    couldn't find its own invitation). Opening a transaction here when
    one isn't already active makes this safe regardless of caller
    context, instead of relying on every caller to remember.

    **Re-entrant, deliberately** — a real bug caught live in Phase 5
    Slice 2 (docs/specs/5-payments-wallet-ledger.md): a Paystack webhook
    handler already inside its own `platform_staff_bypass()` block calls
    `apps.ledger.services.post_journal_entry()`, which opens a *second*,
    nested `platform_staff_bypass()`. Without the depth-tracking below,
    that inner call's own `finally` restores RLS state to whatever the
    *Python contextvar* said was active before *it* was entered — which
    is never "bypass mode", because bypass never touches that
    contextvar (see this function's own note on why, above). The inner
    call's exit would therefore reset the GUCs to non-bypass mode while
    the outer caller's `with platform_staff_bypass():` block was still
    logically open, silently breaking every subsequent RLS-protected
    query/write in the outer block (caught here as
    `Model.save(update_fields=...)` raising `NotUpdated` — Django's own
    zero-rows-affected safety check). Only the *outermost* call now
    actually touches the GUCs; nested calls are no-ops that just track
    depth, so the outermost call's own restore-on-exit is the only one
    that ever runs.
    """
    if _bypass_depth.get() > 0:
        token = _bypass_depth.set(_bypass_depth.get() + 1)
        try:
            yield
        finally:
            _bypass_depth.reset(token)
        return

    previous_client_id = get_current_client_id()
    previous_is_platform_staff = get_is_platform_staff()
    ctx = nullcontext() if connection.in_atomic_block else transaction.atomic()
    depth_token = _bypass_depth.set(1)
    try:
        with ctx:
            set_rls_session_vars(None, is_platform_staff=True)
            try:
                yield
            finally:
                set_rls_session_vars(previous_client_id, previous_is_platform_staff)
    finally:
        _bypass_depth.reset(depth_token)
