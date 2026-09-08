"""Reusable DRF permission classes.

`IsPlatformStaff`/`IsClientStaff` check the same boolean flags
`TenancyMiddleware`/JWT claims already carry — still correct for
anything not permission-specific: registration, the super-admin KYC/KYB
queues (§4 gates those on `platform`, not a codename — `is_platform_staff`
stays an all-access flag for Phase 1, per the spec's own non-goal).

`HasPermission(codename)` (Slice 4) is real per-permission RBAC: it
checks `user.role.permissions`, seeded via
`apps/identity/migrations/0003_seed_permissions.py` and assigned via
`apps.identity.services.create_default_roles`. A factory function, not
one class per codename, so call sites read
`permission_classes = [HasPermission("business.manage")]`.

`HasAnyPermission(*codenames)` is the same check widened to a set, for
the one endpoint two different capabilities legitimately need — see
`apps.identity.views.PassengerLookupView`. Deliberately **not** the
default shape: an endpoint that accepts several codenames is an endpoint
whose authority is hard to reason about, so it has to be argued for
each time rather than reached for.
"""

from rest_framework.permissions import BasePermission
from rest_framework.request import Request
from rest_framework.views import APIView


class IsPlatformStaff(BasePermission):
    def has_permission(self, request: Request, view: APIView) -> bool:
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, "is_platform_staff", False))


class IsClientStaff(BasePermission):
    def has_permission(self, request: Request, view: APIView) -> bool:
        user = request.user
        return bool(user and user.is_authenticated and getattr(user, "is_client_staff", False))


def HasPermission(codename: str) -> type[BasePermission]:
    class _HasPermission(BasePermission):
        def has_permission(self, request: Request, view: APIView) -> bool:
            user = request.user
            if not (user and user.is_authenticated and getattr(user, "is_client_staff", False)):
                return False
            role = getattr(user, "role", None)
            if role is None:
                return False
            return role.permissions.filter(codename=codename).exists()

    return _HasPermission


def HasAnyPermission(*codenames: str) -> type[BasePermission]:
    """Passes if the caller's Role holds **any** of `codenames`.

    One query regardless of how many codenames are named — `__in`, not a
    loop of `.exists()` calls.
    """

    class _HasAnyPermission(BasePermission):
        def has_permission(self, request: Request, view: APIView) -> bool:
            user = request.user
            if not (user and user.is_authenticated and getattr(user, "is_client_staff", False)):
                return False
            role = getattr(user, "role", None)
            if role is None:
                return False
            return role.permissions.filter(codename__in=codenames).exists()

    return _HasAnyPermission
