"""Route/Stop network for a Business — see
docs/specs/3-network-scheduling-fleet.md §2. `Route` carries no
vertical-specific fields of its own (it's structurally vertical-agnostic,
just an ordered list of Stops); any vertical-specific behavior is
`apps.fares`' problem (Phase 4+).
"""

from django.db import models
from django.db.models import Q

from apps.businesses.models import Business
from apps.core.models import BaseModel


class Route(BaseModel):
    # docs/specs/19-route-lifecycle.md. Replaces the old bare
    # `is_active` boolean — see that spec for the full meaning table and
    # the guarded transitions in apps.network.services.set_route_status,
    # the sole writer of this field. Only Route gets this treatment:
    # Stop, Vehicle, VehicleType and Driver keep their `is_active`
    # booleans, a deliberate, accepted inconsistency (the brief only
    # describes a lifecycle for Route).
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        ACTIVE = "active", "Active"
        INACTIVE = "inactive", "Inactive"
        ARCHIVED = "archived", "Archived"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=255)
    code = models.CharField(max_length=32, blank=True)
    description = models.TextField(blank=True)
    # docs/specs/15-trip-classes.md — the classes this route may offer.
    # A JSONField list, mirroring Schedule.days_of_week's own precedent
    # rather than introducing a second multi-value convention.
    #
    # An **empty list means no restriction**, not "no classes allowed" —
    # that is what makes every pre-existing Route keep working
    # unchanged. Validated against Business.TripClass.values in the
    # serializer; enforced when a Schedule or manual Trip is created on
    # the route (apps.scheduling.services).
    #
    # Narrowing this list after Schedules already exist outside it is
    # deliberately *allowed* and leaves them alone: narrowing a plan
    # must not silently invalidate services already running.
    available_trip_classes = models.JSONField(default=list, blank=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.DRAFT)
    # Both nullable — every pre-spec-19 route has neither, and a route
    # is perfectly operable without them. Decimal for distance per the
    # standing money-and-measurement convention; minutes as a plain
    # integer rather than a DurationField, matching
    # Business.seat_hold_minutes's own precedent.
    distance_km = models.DecimalField(max_digits=7, decimal_places=2, null=True, blank=True)
    estimated_duration_minutes = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        # `ordering` must be restated explicitly here, even though it's
        # `-created_at` on every other domain model too (Business,
        # Client, ...): Django only inherits an abstract base's Meta
        # options when the subclass declares NO Meta of its own, or
        # subclasses the base's Meta directly (`class Meta(BaseModel.Meta)`).
        # A subclass that declares `class Meta:` with its own attributes
        # (here, `constraints`) gets none of BaseModel.Meta's options for
        # free — confirmed via `Route._meta.ordering == []` in a shell,
        # vs. `Stop._meta.ordering == ['-created_at']` (Stop has no Meta
        # override at all, so it inherits cleanly). An earlier
        # `ordering = ["name"]` here was a first bug (alphabetical, not
        # recency, order — caught live by routes.spec.ts's "edits an
        # existing route" e2e case); simply deleting that line looked
        # like a fix but produced a second, worse bug — no ordering at
        # all, i.e. undefined/physical-storage order — caught live by a
        # raw curl to the API returning stale-looking results that
        # survived every caching fix, only root-caused by directly
        # inspecting `Route._meta.ordering` in a shell.
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["business", "code"],
                condition=~Q(code=""),
                name="unique_route_code_per_business",
            )
        ]

    def __str__(self) -> str:
        return self.name


# Module-level, not `Route.Status.choices` inline at the call site: an
# `ENUM_NAME_OVERRIDES` entry resolves a dotted path with `import_string`,
# which cannot walk into a nested class — see config/settings/base.py's
# own comment and IncidentStatusEnum's precedent.
ROUTE_STATUS_CHOICES = Route.Status.choices


class Stop(BaseModel):
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=255)
    address = models.CharField(max_length=500, blank=True)
    latitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    longitude = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self) -> str:
        return self.name


class RouteStop(BaseModel):
    """Ordered Route<->Stop through model. Rows are hard-deleted and
    recreated on every reorder (apps.network.services.set_route_stops) —
    no historical value in a stale sequence row; the resulting order is
    still visible via the route.stops_updated audit event's metadata."""

    route = models.ForeignKey(Route, on_delete=models.CASCADE, related_name="+")
    stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    sequence = models.PositiveIntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["route", "sequence"], name="unique_route_stop_sequence"
            ),
            models.UniqueConstraint(fields=["route", "stop"], name="unique_route_stop_pair"),
        ]
        ordering = ["route", "sequence"]

    def __str__(self) -> str:
        return f"{self.route_id} #{self.sequence}"
