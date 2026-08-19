"""Fat-service layer for Route/Stop management — mirrors
apps.businesses.services's shape (see
docs/specs/3-network-scheduling-fleet.md §4)."""

from typing import Any

from django.db import transaction

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.identity.models import User

from .models import Route, RouteStop, Stop


def create_route(
    *, business: Business, name: str, code: str, description: str, created_by: User
) -> Route:
    """business.kyb_status == approved is already enforced by
    RouteCreateSerializer.validate_business() before this is called —
    services here assume pre-validated input, matching the rest of the
    codebase's convention (see apps.businesses.services.update_business's
    own docstring on this)."""
    route = Route.objects.create(
        client=business.client, business=business, name=name, code=code, description=description
    )
    record_audit_event(actor=created_by, action="route.created", target=route)
    return route


def update_route(*, route: Route, updated_by: User, **fields: Any) -> Route:
    for field, value in fields.items():
        setattr(route, field, value)
    route.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="route.updated", target=route, **fields)
    return route


def create_stop(
    *,
    business: Business,
    name: str,
    address: str,
    latitude: Any,
    longitude: Any,
    created_by: User,
) -> Stop:
    stop = Stop.objects.create(
        client=business.client,
        business=business,
        name=name,
        address=address,
        latitude=latitude,
        longitude=longitude,
    )
    record_audit_event(actor=created_by, action="stop.created", target=stop)
    return stop


def update_stop(*, stop: Stop, updated_by: User, **fields: Any) -> Stop:
    for field, value in fields.items():
        setattr(stop, field, value)
    stop.save(update_fields=list(fields))
    record_audit_event(actor=updated_by, action="stop.updated", target=stop, **fields)
    return stop


def set_route_stops(*, route: Route, stops: list[Stop], updated_by: User) -> list[RouteStop]:
    """Hard-deletes the existing ordered set and recreates it in one
    transaction — no historical value in a stale sequence row (see
    RouteStop's own docstring). `stops` is already validated (existence,
    same-business, no duplicates) by RouteStopsUpdateSerializer.

    Deletes via `all_objects`, not `.objects`: `route` is already a real
    instance the caller legitimately holds (tenant-verified upstream in
    the normal request path), so re-deriving a tenancy filter here adds
    nothing — and `.objects` actively breaks this function for a caller
    running under `apps.core.rls.platform_staff_bypass()` (a management
    command, e.g. `seed_e2e_users`), whose docstring is explicit that the
    bypass only changes Postgres-level GUCs, not the Python contextvar
    `TenantScopedManager` reads. Under that bypass, `.objects` silently
    matches zero rows, the delete is a no-op, and the recreate below then
    collides with the still-present old rows on `unique_route_stop_sequence`
    — caught live via `seed_e2e_users` failing on a second run against an
    already-seeded database, not by a test (no test exercised this
    function from inside a bypass context)."""
    with transaction.atomic():
        RouteStop.all_objects.filter(route=route).delete()
        created = [
            RouteStop.objects.create(
                client=route.client, route=route, stop=stop, sequence=index + 1
            )
            for index, stop in enumerate(stops)
        ]
    record_audit_event(
        actor=updated_by,
        action="route.stops_updated",
        target=route,
        stop_ids=[str(stop.id) for stop in stops],
    )
    return created
