"""Fat-service layer for Route/Stop management — mirrors
apps.businesses.services's shape (see
docs/specs/3-network-scheduling-fleet.md §4)."""

from datetime import datetime
from typing import Any, NamedTuple
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import QuerySet

from apps.businesses.models import Business
from apps.core.audit import record_audit_event
from apps.core.rls import platform_staff_bypass
from apps.fares.services import route_fare_summary
from apps.identity.models import User
from apps.scheduling.models import Trip

from .models import Route, RouteStop, Stop

# docs/specs/19-route-lifecycle.md. Restore lands on `inactive`, never
# straight back to `active` — a route archived months ago may have
# stale stops, no current fares and no vehicles, so bringing it back
# paused is the safe default. `draft` has no way back in.
ROUTE_TRANSITIONS: dict[str, set[str]] = {
    Route.Status.DRAFT: {Route.Status.ACTIVE, Route.Status.ARCHIVED},
    Route.Status.ACTIVE: {Route.Status.INACTIVE, Route.Status.ARCHIVED},
    Route.Status.INACTIVE: {Route.Status.ACTIVE, Route.Status.ARCHIVED},
    Route.Status.ARCHIVED: {Route.Status.INACTIVE},
}


class RouteTransitionIllegal(Exception):
    """The requested status is not reachable from the route's current
    one — mapped to a 400: the request itself is malformed, not merely
    refused by the route's state."""


class RouteNotReadyToActivate(Exception):
    """`-> active` requires a currently-effective fare and at least two
    stops. Mapped to a 409: the request is well-formed and the
    transition would be legal in general, but this route's own state
    refuses it right now — same reasoning as
    apps.scheduling.services.TripClassLocked's own docstring."""


class RouteHasFutureTrips(Exception):
    """`-> archived` is refused while future non-cancelled Trips exist
    on the route — archiving out from under a passenger holding a paid
    booking is the failure this prevents. Mapped to a 409."""


def create_route(
    *,
    business: Business,
    name: str,
    code: str,
    description: str,
    created_by: User,
    available_trip_classes: list[str] | None = None,
) -> Route:
    """business.kyb_status == approved is already enforced by
    RouteCreateSerializer.validate_business() before this is called —
    services here assume pre-validated input, matching the rest of the
    codebase's convention (see apps.businesses.services.update_business's
    own docstring on this)."""
    route = Route.objects.create(
        client=business.client,
        business=business,
        name=name,
        code=code,
        description=description,
        # `[]` means no restriction, so an omitted allow-list leaves the
        # route open to every class — the pre-spec-15 behaviour.
        available_trip_classes=available_trip_classes or [],
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


def set_route_status(*, route: Route, new_status: str, actor: User, reason: str = "") -> Route:
    """The sole write path for `Route.status` — never the serializer.
    Unlike apps.scheduling.serializers.TripStatusSerializer's transition
    check, the guards here need database queries (a currently-effective
    fare, a stop count, future Trips), which is service-layer work, not
    presentation-layer validation — so the whole thing, transition
    legality included, lives here rather than being split across both.

    A request naming the route's own current status is an idempotent
    no-op: returns the route unchanged, no audit row — same convention
    as apps.scheduling.services.transition_trip_status.

    The activation guard runs for *any* transition into `active`, not
    only `draft -> active` (the case docs/specs/19-route-lifecycle.md's
    own prose frames it around): `inactive -> active` reactivates a
    route whose stops or fares could, in principle, have moved on while
    it was paused, and checking uniformly is simpler than checking only
    the path the spec happened to narrate.

    `reason` is optional and never required by a guard here — unlike
    `transition_trip_status`'s cancellation reason — but is recorded on
    the audit event whenever given, same as that function's own.
    """
    if new_status == route.status:
        return route
    if new_status not in ROUTE_TRANSITIONS.get(route.status, set()):
        raise RouteTransitionIllegal(f"Cannot transition from {route.status} to {new_status}.")

    if new_status == Route.Status.ACTIVE:
        stop_count = RouteStop.objects.filter(route=route).count()
        if stop_count < 2:
            raise RouteNotReadyToActivate(
                "This route needs at least two stops before it can be activated."
            )
        if not route_fare_summary(route=route)["configured"]:
            raise RouteNotReadyToActivate(
                "This route needs a currently-effective fare before it can be activated."
            )

    if new_status == Route.Status.ARCHIVED:
        today_local = datetime.now(ZoneInfo(route.business.timezone)).date()
        future_trip_count = (
            Trip.objects.filter(route=route, service_date__gte=today_local)
            .exclude(status=Trip.Status.CANCELLED)
            .count()
        )
        if future_trip_count:
            raise RouteHasFutureTrips(
                f"{future_trip_count} future trip(s) are scheduled on this route — "
                "cancel them or let them run before archiving."
            )

    route.status = new_status
    route.save(update_fields=["status"])
    record_audit_event(
        actor=actor, action="route.status_changed", target=route, status=new_status, reason=reason
    )
    return route


class RouteStopMatch(NamedTuple):
    """One `(route, from_stop, to_stop)` pairing `find_route_stop_matches`
    found, plus the stop count strictly between them — computed here
    because it needs each `RouteStop`'s `sequence`, which the plain
    `Stop` rows below don't carry on their own. `stops_between == 0`
    is a direct connection; the caller (`TripSearchView`) is what turns
    that into the word "Direct" — this stays a plain int, a display
    concern doesn't belong in a service function's return shape."""

    route: Route
    from_stop: Stop
    to_stop: Stop
    stops_between: int


def find_route_stop_matches(*, origin: str, destination: str) -> list[RouteStopMatch]:
    """Passenger-facing search entry point: given free-text `origin`/
    `destination`, returns every matching pairing where both stops sit
    on the same active Route, in the right travel direction — used by
    `apps.scheduling.views.TripSearchView` in place of a passenger
    picking a Route first (docs/specs/4-fares-seating-booking-
    frontend.md §3.3, reworked for the origin/destination flow).
    (Named `origin`, not `source` — the latter collides with
    `rest_framework.serializers.Field`'s own reserved `source`
    attribute, which the query serializer that feeds this would
    otherwise fight with; kept consistent here even though this
    function itself is plain Python, so the name doesn't change again
    between the API layer and this one.)

    Deliberately not a fuzzy cross-Route text match: `Stop` is a real,
    shared, Business-owned row (`RouteStop` just orders it onto a
    Route), so this is a plain relational join — match `Stop.name` on
    both ends, same Route, `from_stop`'s sequence strictly before
    `to_stop`'s. A search term matching more than one physical stop
    (e.g. "Lagos") legitimately produces more than one pair; this
    returns all of them rather than guessing which the passenger meant
    — the frontend's suggestion dropdown is what narrows this in
    practice before a search is even submitted.

    `route__status=ACTIVE` and `stop__is_active=True` mirror
    `RouteBrowseView`'s own passenger-visible filtering — a draft,
    inactive or archived Route, or a deactivated Stop, must be exactly
    as unreachable here as there.
    """
    from_matches = RouteStop.objects.filter(
        stop__name__icontains=origin,
        stop__is_active=True,
        route__status=Route.Status.ACTIVE,
    ).select_related("stop", "route", "route__business")
    to_matches = RouteStop.objects.filter(
        stop__name__icontains=destination,
        stop__is_active=True,
        route__status=Route.Status.ACTIVE,
    ).select_related("stop")

    return _pair_route_stops(from_matches, to_matches)


def _pair_route_stops(
    from_matches: QuerySet[RouteStop], to_matches: QuerySet[RouteStop]
) -> list[RouteStopMatch]:
    """The actual pairing logic shared by `find_route_stop_matches` and
    its marketplace variant below — the only difference between them is
    which manager/predicates built `from_matches`/`to_matches`, never
    this part."""
    to_by_route: dict[Any, list[RouteStop]] = {}
    for candidate in to_matches:
        to_by_route.setdefault(candidate.route_id, []).append(candidate)

    matches: list[RouteStopMatch] = []
    for from_candidate in from_matches:
        for to_candidate in to_by_route.get(from_candidate.route_id, []):
            if from_candidate.sequence < to_candidate.sequence:
                matches.append(
                    RouteStopMatch(
                        route=from_candidate.route,
                        from_stop=from_candidate.stop,
                        to_stop=to_candidate.stop,
                        stops_between=to_candidate.sequence - from_candidate.sequence - 1,
                    )
                )
    return matches


def find_route_stop_matches_across_clients(
    *, origin: str, destination: str
) -> list[RouteStopMatch]:
    """The marketplace's cross-Client variant of `find_route_stop_matches`
    — docs/adr/0009, docs/specs/22-marketplace.md. Identical matching
    logic, but `all_objects` instead of `.objects`, since a marketplace
    passenger's own Client is never the one that owns the Route being
    searched.

    `route__business__kyb_status=APPROVED` is the one predicate the
    same-Client version doesn't need: there, RLS's own Client-scoping
    incidentally guarantees "this Business belongs to a Client I already
    trust", which stops being true the moment `all_objects` opens this up
    platform-wide. Confirmed by reading `create_route`'s own docstring:
    KYB approval is enforced only at route-creation time, never re-checked
    on any read path — so this must be a first-class, explicit filter
    here, not an assumption carried over from the same-Client function.

    **`all_objects` alone is not enough.** It only removes the ORM-level
    filter — `RouteStop`'s Postgres RLS policy still applies regardless
    of manager, so this also needs `platform_staff_bypass()` to actually
    see another Client's rows at the database level (confirmed live: an
    earlier version of this function without it silently returned
    nothing for a genuinely cross-Client match). This is the first
    ordinary passenger-facing read to reach for that bypass — every
    other call site is system/platform-staff code (see its own
    docstring) — justified here specifically because the four predicates
    above are exactly the "caller has already established authorization
    some other way" that docstring asks for: they, not RLS, are what
    keeps this to only publicly-bookable rows.
    """
    with platform_staff_bypass():
        from_matches = RouteStop.all_objects.filter(
            stop__name__icontains=origin,
            stop__is_active=True,
            route__status=Route.Status.ACTIVE,
            route__business__kyb_status=Business.KybStatus.APPROVED,
        ).select_related("stop", "route", "route__business")
        to_matches = RouteStop.all_objects.filter(
            stop__name__icontains=destination,
            stop__is_active=True,
            route__status=Route.Status.ACTIVE,
            route__business__kyb_status=Business.KybStatus.APPROVED,
        ).select_related("stop")

        return _pair_route_stops(from_matches, to_matches)


def duplicate_route(*, route: Route, duplicated_by: User) -> Route:
    """Copies `route` and its ordered RouteStop rows. The copy is always
    `draft`, its name suffixed `(copy)`, its `code` cleared — a
    duplicated code is a data-entry landmine since codes are meant to be
    unique in practice.

    **Fares are not copied.** They are versioned on a half-open timeline
    with a GiST exclusion constraint; a copy would have to invent
    `effective_from` values, and spec 12 already established that
    anything touching fare amounts outside apps.fares.services silently
    destroys the price snapshot historical SeatReservations depend on.
    The `-> active` guard in set_route_status forces the operator to
    price the copy before it can sell, which is what makes not copying
    fares safe rather than merely convenient. Schedules, Trips and
    vehicle assignments are likewise not copied.

    Uses `all_objects` throughout, per the trap that has now bitten this
    codebase twice (`set_route_stops` above, `replace_vehicle_type_seats`
    in apps.fleet.services): under `apps.core.rls.platform_staff_bypass()`
    the Python tenancy contextvar is unset, and `.objects` silently
    matches zero rows — `route` is already a real instance the caller
    legitimately holds, so re-deriving a tenancy filter here adds
    nothing either way.
    """
    with transaction.atomic():
        stops = list(
            RouteStop.all_objects.filter(route=route).select_related("stop").order_by("sequence")
        )
        copy = Route.all_objects.create(
            client=route.client,
            business_id=route.business_id,
            name=f"{route.name} (copy)",
            code="",
            description=route.description,
            available_trip_classes=list(route.available_trip_classes),
            status=Route.Status.DRAFT,
        )
        for entry in stops:
            RouteStop.all_objects.create(
                client=route.client, route=copy, stop=entry.stop, sequence=entry.sequence
            )
    record_audit_event(
        actor=duplicated_by,
        action="route.duplicated",
        target=copy,
        source_route_id=str(route.id),
    )
    return copy
