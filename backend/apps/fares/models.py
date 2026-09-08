"""Fare pricing for a Business — see
docs/specs/4-fares-seating-booking.md §2. A Route uses exactly one of
`FareRule` (`business.fare_pricing_mode == flat`) or `FareSegmentRule`
(`== per_segment`) — which one applies is decided at lookup time by
`apps.fares.services.get_fare`, never stored per-Route. Switching a
Business's `fare_pricing_mode` after rules exist under the old mode
does not delete those rows (no destructive cascade) — see that
section's own note.

Rules are versioned by a half-open validity window
`[effective_from, effective_to)`: editing a fare closes the current
row and inserts a successor rather than mutating `amount` in place,
so historical bookings can still point at the rule that priced them.
Non-overlap is enforced by a Postgres GiST exclusion constraint in the
migration (same raw-SQL shape `apps.seating` uses for seat segments —
Django cannot express `tstzrange(col_a, col_b)` as a model-level
`ExclusionConstraint` expression cleanly).
"""

from django.db import models

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.network.models import Route, Stop

# docs/specs/15-trip-classes.md. The empty string is a **wildcard**
# meaning "any class", not "no class", and it is why both rule models
# below store `trip_class` as a NOT NULL blank-able CharField rather
# than a nullable one.
#
# A nullable column was considered and rejected on a database fact:
# Postgres `=` does not match NULL against NULL, so a GiST exclusion
# constraint containing `trip_class WITH =` would silently permit two
# overlapping NULL-class rules for the same route — the exact duplicate
# the constraint exists to prevent. The sentinel keeps it honest.
#
# It is also what makes spec 15's migration behaviour-preserving: every
# pre-existing rule backfills to the wildcard and therefore keeps
# pricing every class exactly as it did before classes existed.
ANY_TRIP_CLASS = ""


class FareRule(BaseModel):
    """Versioned flat fare for a Route — used when
    business.fare_pricing_mode == FLAT. Multiple rows per route are
    expected over time; at most one non-deleted row may cover any given
    instant (GiST exclusion on the validity window)."""

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="+")
    # `""` (ANY_TRIP_CLASS) is the wildcard — see its definition above.
    # An exact class match beats the wildcard at lookup time; the
    # precedence rule lives in `services.get_fare`.
    trip_class = models.CharField(
        max_length=20,
        choices=Business.TripClass.choices,
        blank=True,
        default=ANY_TRIP_CLASS,
    )
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    effective_from = models.DateTimeField()
    effective_to = models.DateTimeField(null=True, blank=True)

    class Meta:
        # See apps.network.models.Route's Meta docstring for why this
        # must be restated explicitly rather than omitted.
        ordering = ["-effective_from", "-created_at"]

    def __str__(self) -> str:
        return f"{self.route_id} flat {self.amount} from {self.effective_from}"


class FareSegmentRule(BaseModel):
    """Versioned per-stop-pair fare — used when
    business.fare_pricing_mode == PER_SEGMENT. Every valid
    (from_stop, to_stop) pair a passenger can book must have its own
    explicit row here — there is no fare-composition/inference logic
    (see the spec's §1 non-goals). Same validity-window versioning as
    FareRule."""

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="+")
    from_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    to_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    # Same wildcard semantics as FareRule.trip_class above.
    trip_class = models.CharField(
        max_length=20,
        choices=Business.TripClass.choices,
        blank=True,
        default=ANY_TRIP_CLASS,
    )
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    effective_from = models.DateTimeField()
    effective_to = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-effective_from", "-created_at"]

    def __str__(self) -> str:
        return (
            f"{self.route_id} {self.from_stop_id}->{self.to_stop_id} "
            f"{self.amount} from {self.effective_from}"
        )
