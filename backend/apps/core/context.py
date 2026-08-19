"""Request-scoped tenancy context.

`TenancyMiddleware` sets these contextvars from the active JWT once per
request; `TenantScopedManager` reads them on every query. Using
`contextvars` (not `threading.local`) so this stays correct under ASGI /
async views, not just WSGI. See docs/adr/0002-tenancy-enforcement.md.
"""

from contextvars import ContextVar, Token

_current_client_id: ContextVar[str | None] = ContextVar("current_client_id", default=None)
_is_platform_staff: ContextVar[bool] = ContextVar("is_platform_staff", default=False)


def set_current_client_id(client_id: str | None) -> Token[str | None]:
    return _current_client_id.set(client_id)


def reset_current_client_id(token: Token[str | None]) -> None:
    _current_client_id.reset(token)


def get_current_client_id() -> str | None:
    return _current_client_id.get()


def set_is_platform_staff(value: bool) -> Token[bool]:
    return _is_platform_staff.set(value)


def reset_is_platform_staff(token: Token[bool]) -> None:
    _is_platform_staff.reset(token)


def get_is_platform_staff() -> bool:
    return _is_platform_staff.get()
