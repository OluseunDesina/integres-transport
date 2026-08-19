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
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    name = models.CharField(max_length=255)
    code = models.CharField(max_length=32, blank=True)
    description = models.TextField(blank=True)
    is_active = models.BooleanField(default=True)

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
