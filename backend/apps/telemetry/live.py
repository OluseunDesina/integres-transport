"""Live-read composition for `GET /trips/live/` and `GET
/trips/{id}/live/` — see docs/specs/20-live-operations.md's "Live read"
and "Progress and ETA" sections.

A module of its own, not `services.py`, for the same reason
`apps.booking.manifest` is: this is a read that reaches across
`scheduling`, `network`, `booking`/`ticketing`/`tapngo` (occupancy) and
`incidents` (open count), and `services.py` owns the write path — its
docstring is about ingest idempotency, not fan-out reads.

Registered under `apps.telemetry.urls` even though every path is
`trips/...`, matching how `apps.booking` owns `trips/{id}/manifest/`
and `apps.fares` owns `trips/{id}/fare/`: the app that owns the data
owns the endpoint.
"""

from __future__ import annotations

import hashlib
import math
from datetime import timedelta
from typing import Any

from django.core.cache import cache
from django.db.models import QuerySet
from django.utils import timezone

from apps.analytics.services import seats_sold_and_total
from apps.booking.manifest import trip_summary
from apps.businesses.models import Business
from apps.identity.models import User
from apps.incidents.models import OPEN_STATUSES, Incident
from apps.network.models import RouteStop
from apps.scheduling.models import Trip
from apps.tapngo.models import FareJourney
from apps.ticketing.models import Ticket

from .models import VehicleLiveState, VehiclePosition

_EARTH_RADIUS_KM = 6371.0088

# How long a trip's furthest-reached stop index is remembered — see
# `_progress_index`'s docstring. Generous relative to any real trip's
# duration; eviction only ever softens the forward-only guarantee, never
# breaks correctness.
_PROGRESS_CACHE_TTL_SECONDS = 60 * 60 * 24


def _haversine_km(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> float:
    lat1_r, lon1_r, lat2_r, lon2_r = (math.radians(float(v)) for v in (lat1, lon1, lat2, lon2))
    d_lat = lat2_r - lat1_r
    d_lon = lon2_r - lon1_r
    a = math.sin(d_lat / 2) ** 2 + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(d_lon / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _coordinated_route_stops(route_id: Any) -> list[RouteStop] | None:
    """`None` — not an empty list — whenever the route can't support
    progress at all: fewer than two stops, or any one of them missing
    coordinates. Mirrors `apps.telemetry.management.commands
    .simulate_vehicle_positions._coordinated_stops`'s own all-or-nothing
    rule, so a route reads the same way to both the simulator and the
    live API."""
    route_stops = list(
        RouteStop.objects.filter(route_id=route_id).select_related("stop").order_by("sequence")
    )
    if len(route_stops) < 2:
        return None
    if any(rs.stop.latitude is None or rs.stop.longitude is None for rs in route_stops):
        return None
    return route_stops


def _delay_minutes(trip: Trip) -> int | None:
    """`None` — not zero — when `actual_departure_at` was never
    stamped (a Trip transitioned to `in_progress` before that field
    existed). Matches the model's own "report unknown, not a lie"
    convention for this exact column."""
    if trip.actual_departure_at is None:
        return None
    delta = trip.actual_departure_at - trip.scheduled_departure_at
    return round(delta.total_seconds() / 60)


def compute_progress(*, trip: Trip, latitude: Any, longitude: Any) -> dict[str, Any] | None:
    """Nearest `RouteStop` by haversine distance, constrained to move
    forward only.

    `ASSUMPTION`: "constrained to move forward" is implemented as a
    short-lived cache of the furthest stop index reached for this trip,
    not a database column — a route that loops back near its own start
    (or ordinary GPS jitter) would otherwise make a live trip's progress
    visibly regress between polls, which is the one thing an operator
    watching a map cannot be shown. This is a soft guarantee: cache
    eviction only ever lets one stale poll compute a lower raw index,
    never reports one, since the cached floor still wins. Acceptable for
    an operational display — nothing here backs a fare, a booking, or a
    dispute.
    """
    route_stops = _coordinated_route_stops(trip.route_id)
    if route_stops is None:
        return None

    distances = [
        _haversine_km(latitude, longitude, rs.stop.latitude, rs.stop.longitude)
        for rs in route_stops
    ]
    raw_index = distances.index(min(distances))

    cache_key = f"telemetry:progress:{trip.id}"
    best_index = max(raw_index, cache.get(cache_key) or 0)
    cache.set(cache_key, best_index, _PROGRESS_CACHE_TTL_SECONDS)

    next_stop = route_stops[best_index + 1] if best_index + 1 < len(route_stops) else None
    return {
        "last_stop": route_stops[best_index].stop.name,
        "next_stop": next_stop.stop.name if next_stop else None,
        "stops_completed": best_index + 1,
        "stops_total": len(route_stops),
        "method": "nearest_stop",
    }


def compute_eta(*, trip: Trip, progress: dict[str, Any] | None) -> dict[str, Any] | None:
    """Remaining scheduled segment time, offset by the observed
    departure delay.

    `ASSUMPTION`: this system has no per-stop scheduled time — only
    `Route.estimated_duration_minutes` (docs/specs/19-route-lifecycle.md)
    for the whole route — so "scheduled segment timing" is read as a
    uniform split of that total across the route's segments, not a
    per-segment schedule this data model does not carry. `null`
    whenever progress is unavailable or the route has no estimated
    duration at all; both share `progress`'s own "no basis to compute
    from" reasoning.
    """
    if progress is None:
        return None
    duration_minutes = trip.route.estimated_duration_minutes
    if duration_minutes is None:
        return None

    segments = progress["stops_total"] - 1
    if segments <= 0:
        return None
    per_segment_minutes = duration_minutes / segments
    delay_minutes = _delay_minutes(trip) or 0

    final_stop_at = trip.scheduled_departure_at + timedelta(
        minutes=duration_minutes + delay_minutes
    )
    next_stop_at = None
    if progress["next_stop"] is not None:
        next_stop_at = trip.scheduled_departure_at + timedelta(
            minutes=per_segment_minutes * progress["stops_completed"] + delay_minutes
        )

    return {
        "next_stop_at": next_stop_at,
        "final_stop_at": final_stop_at,
        "method": "scheduled_segment",
        "confidence": "low",
    }


def _boarded_and_capacity(trip: Trip) -> tuple[int, int | None]:
    """`boarded` is a physical-presence count, deliberately different
    from `apps.booking.manifest.totals`'s own `boarded` (which counts
    against a paginated, cancellation-aware row list built for a
    manifest *screen*). This is the same underlying fact, computed as a
    single count query instead of materializing that full row list —
    this endpoint is polled every 10-15 seconds across a whole fleet,
    where `manifest.totals`'s cost is fine for one screen opened once.
    `capacity` reuses `apps.analytics.services.seats_sold_and_total` so
    the "no vehicle means unknowable, not zero" rule isn't a second copy.
    """
    _, capacity = seats_sold_and_total(trip)
    if trip.fare_collection_mode == Business.FareCollectionMode.PAY_AS_YOU_GO:
        boarded = FareJourney.objects.filter(trip=trip).count()
    else:
        boarded = Ticket.objects.filter(trip=trip, status=Ticket.Status.BOARDED).count()
    return boarded, capacity


def _position_envelope(
    position: VehicleLiveState | VehiclePosition | None,
) -> dict[str, Any] | None:
    if position is None:
        return None
    staleness_seconds = max(0, int((timezone.now() - position.recorded_at).total_seconds()))
    return {
        "latitude": position.latitude,
        "longitude": position.longitude,
        "recorded_at": position.recorded_at,
        "source": position.source,
        "staleness_seconds": staleness_seconds,
    }


def current_position_for(trip: Trip) -> VehicleLiveState | VehiclePosition | None:
    """`VehicleLiveState` (vehicle-keyed) for a trip still `in_progress`;
    the trip's own last `VehiclePosition` otherwise.

    Load-bearing distinction, not a shortcut: `VehicleLiveState` is
    upserted per **vehicle**, and a vehicle is reused across trips. Once
    a trip completes, its vehicle may already be reporting for the
    *next* one — reading `VehicleLiveState` for a completed trip would
    silently show a different trip's live position. `VehiclePosition`
    rows, in contrast, are stamped with the trip that was actually
    `in_progress` at ingest time and never get reattributed.
    """
    if trip.status == Trip.Status.IN_PROGRESS and trip.vehicle_id is not None:
        return VehicleLiveState.objects.filter(vehicle_id=trip.vehicle_id).first()
    return VehiclePosition.objects.filter(trip=trip).order_by("-recorded_at").first()


def trip_live_envelope(
    *, trip: Trip, position: VehicleLiveState | VehiclePosition | None
) -> dict[str, Any]:
    position_envelope = _position_envelope(position)
    progress = None
    eta = None
    if position_envelope is not None:
        progress = compute_progress(
            trip=trip,
            latitude=position_envelope["latitude"],
            longitude=position_envelope["longitude"],
        )
        eta = compute_eta(trip=trip, progress=progress)

    boarded, capacity = _boarded_and_capacity(trip)
    incidents_open = Incident.objects.filter(trip=trip, status__in=OPEN_STATUSES).count()

    return {
        "trip": trip_summary(trip),
        "position": position_envelope,
        "progress": progress,
        "eta": eta,
        "punctuality": {"delay_minutes": _delay_minutes(trip)},
        "occupancy": {"boarded": boarded, "capacity": capacity},
        "incidents_open": incidents_open,
    }


def live_trips_queryset() -> QuerySet[Trip]:
    return Trip.objects.filter(status=Trip.Status.IN_PROGRESS).select_related(
        "route", "business", "vehicle", "driver"
    )


def live_states_by_vehicle(trips: list[Trip]) -> dict[Any, VehicleLiveState]:
    vehicle_ids = [trip.vehicle_id for trip in trips if trip.vehicle_id is not None]
    states = VehicleLiveState.objects.filter(vehicle_id__in=vehicle_ids)
    return {state.vehicle_id: state for state in states}


def compute_fleet_etag(trips: list[Trip], states_by_vehicle: dict[Any, VehicleLiveState]) -> str:
    """Represents the **whole** live board — trip membership and every
    live position — not just what a `?since=` filter would return, so
    `If-None-Match` can short-circuit a truly quiet poll before any
    per-trip envelope (occupancy counts, incident counts, ...) is built
    at all. `?since=` is a second, independent optimization layered
    underneath: it only narrows which of *these* trips are worth
    sending, once the fleet is known to have changed at all.
    """
    parts = []
    for trip in sorted(trips, key=lambda t: str(t.id)):
        state = states_by_vehicle.get(trip.vehicle_id)
        parts.append(f"{trip.id}:{state.updated_at.isoformat() if state else ''}")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def include_in_delta(trip: Trip, state: VehicleLiveState | None, since: Any) -> bool:
    """`?since=` narrows a `200` response to trips that moved — a trip
    with no live state yet is always included, so a "no signal" trip
    the client has never seen isn't silently withheld waiting for a
    first position that may never come (spec's own "Trip in progress,
    no device" edge case).

    `ASSUMPTION`: a trip that leaves `/trips/live/` entirely (completes)
    between polls is not separately signalled — the next
    no-`?since=` refresh reconciles it. Named here rather than solved:
    a removal-tombstone scheme is a real design, not a one-line addition,
    and slice 3 (the actual polling client) is better placed to decide
    whether a periodic full refresh is enough or whether this needs
    revisiting.
    """
    if since is None or state is None:
        return True
    return state.updated_at > since


def passenger_holds_trip(*, trip: Trip, user: User) -> bool:
    if Ticket.objects.filter(trip=trip, booking__passenger=user).exists():
        return True
    return FareJourney.objects.filter(trip=trip, passenger=user).exists()


def staff_can_view_live(*, user: User) -> bool:
    if not (getattr(user, "is_client_staff", False)):
        return False
    role = getattr(user, "role", None)
    if role is None:
        return False
    return role.permissions.filter(codename="scheduling.view").exists()
