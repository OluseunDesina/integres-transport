"""`python manage.py simulate_vehicle_positions` — dev/CI only, see
docs/specs/20-live-operations.md's "The simulator" section.

Walks each `in_progress` Trip's vehicle along its route's ordered stop
coordinates, through `apps.telemetry.services.record_positions()` — the
same function `apps.telemetry.views.PositionIngestView` calls for a real
device — so the simulator exercises the real idempotency and
live-state-advance contract rather than writing rows directly. Every row
it writes carries `source="simulated"`; nothing downstream has to know
that, but everything downstream *can* tell.

Guarded the same way `apps.core.management.commands.prune_e2e_test_data`
is: test/dev infrastructure, refusing to run under production settings.
"""

import os
import time
from decimal import Decimal
from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from apps.core.rls import platform_staff_bypass
from apps.network.models import RouteStop
from apps.scheduling.models import Trip
from apps.telemetry.models import VehiclePosition
from apps.telemetry.services import record_positions

# Interpolation points per stop-to-stop segment. Not a CLI flag — this
# governs simulated granularity, not anything an operator running the
# command needs to tune.
_STEPS_PER_SEGMENT = 6
_SIMULATED_SPEED_KPH = 30

_Coordinate = tuple[Any, Any]


def _coordinated_stops(route_id: Any) -> list[_Coordinate]:
    """All-or-nothing: one uncoordinated Stop makes the whole route
    unusable to the simulator, matching the live-read API's own
    `progress: null, method: "unavailable"` treatment of the same case
    (spec's edge case table) — a partial walk across a gap would be
    fiction with no way to mark it as such."""
    route_stops = list(
        RouteStop.all_objects.filter(route_id=route_id).select_related("stop").order_by("sequence")
    )
    coordinates = [
        (rs.stop.latitude, rs.stop.longitude)
        for rs in route_stops
        if rs.stop.latitude is not None and rs.stop.longitude is not None
    ]
    if len(coordinates) != len(route_stops) or len(coordinates) < 2:
        return []
    return coordinates


def _interpolated_points(coordinates: list[_Coordinate]) -> list[_Coordinate]:
    points: list[_Coordinate] = []
    for (lat_a, lon_a), (lat_b, lon_b) in zip(coordinates, coordinates[1:], strict=False):
        for step in range(_STEPS_PER_SEGMENT):
            fraction = Decimal(step) / Decimal(_STEPS_PER_SEGMENT)
            points.append((lat_a + (lat_b - lat_a) * fraction, lon_a + (lon_b - lon_a) * fraction))
    points.append(coordinates[-1])
    return points


class Command(BaseCommand):
    help = (
        "Simulate vehicle telemetry for every in_progress Trip, through the same "
        "record_positions() the authenticated ingest endpoint uses. Dev/CI only."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--loop",
            action="store_true",
            help="Run continuously, emitting one batch every --interval seconds.",
        )
        parser.add_argument(
            "--interval",
            type=int,
            default=10,
            help="Seconds between batches in --loop mode (default 10).",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        # `settings.SETTINGS_MODULE`, deliberately not used here: Django's
        # own `UserSettingsHolder` — what `settings._wrapped` becomes
        # under ANY `override_settings`, including pytest-django's
        # autouse `settings` fixture already active on every test in
        # this suite (see conftest.py) — hardcodes `SETTINGS_MODULE =
        # None` at the class level ("doesn't make much sense in the
        # manually configured case"), which shadows the real value for
        # the whole test process, not just deliberately-overridden
        # settings. The env var Django itself resolves the settings
        # module from is unaffected by that wrapping.
        settings_module = os.environ.get("DJANGO_SETTINGS_MODULE", "")
        if "production" in settings_module:
            raise CommandError(
                "simulate_vehicle_positions refuses to run under production settings."
            )

        if options["loop"]:
            while True:
                self._run_once()
                time.sleep(options["interval"])
        else:
            self._run_once()

    def _run_once(self) -> None:
        emitted = 0
        skipped_routes = 0
        with platform_staff_bypass():
            trips = list(
                Trip.all_objects.filter(
                    status=Trip.Status.IN_PROGRESS, vehicle__isnull=False
                ).select_related("route", "business", "vehicle")
            )
            for trip in trips:
                vehicle = trip.vehicle
                if vehicle is None:
                    continue

                coordinates = _coordinated_stops(trip.route_id)
                if not coordinates:
                    skipped_routes += 1
                    continue

                points = _interpolated_points(coordinates)
                step_count = VehiclePosition.all_objects.filter(
                    vehicle=vehicle, source=VehiclePosition.Source.SIMULATED
                ).count()
                latitude, longitude = points[step_count % len(points)]

                record_positions(
                    business=trip.business,
                    vehicle=vehicle,
                    source=VehiclePosition.Source.SIMULATED,
                    readings=[
                        {
                            "latitude": latitude,
                            "longitude": longitude,
                            "speed_kph": _SIMULATED_SPEED_KPH,
                            "heading_degrees": None,
                            "recorded_at": timezone.now(),
                        }
                    ],
                )
                emitted += 1

        # Reports how many it skipped rather than silently doing
        # nothing — the prune_e2e_test_data lesson (see that command's
        # own docstring) of a command whose silence was mistaken for
        # success.
        self.stdout.write(
            f"Emitted {emitted} simulated position(s); skipped {skipped_routes} "
            "route(s) with uncoordinated stops."
        )
