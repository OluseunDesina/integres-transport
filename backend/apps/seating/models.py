"""Seat inventory and the seat-hold/reservation concurrency model — see
docs/specs/4-fares-seating-booking.md §2 and docs/adr/0004 (the
finalized concurrency decision this app implements).
"""

from django.contrib.postgres.fields import IntegerRangeField
from django.db import models
from django.db.models import Q

from apps.booking.models import Booking
from apps.core.models import BaseModel
from apps.fleet.models import VehicleType
from apps.network.models import Stop
from apps.scheduling.models import Trip


class Seat(BaseModel):
    """Real per-seat inventory for a VehicleType — replaces nothing;
    `VehicleType.capacity` (Phase 3) remains the authoritative cap a
    Business's Seat rows must not exceed (validated in services, not a
    DB constraint — see apps.seating.services.replace_vehicle_type_seats).
    """

    vehicle_type = models.ForeignKey(VehicleType, on_delete=models.PROTECT, related_name="+")
    seat_number = models.CharField(max_length=10)
    row = models.PositiveIntegerField(null=True, blank=True)
    column = models.PositiveIntegerField(null=True, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["vehicle_type", "seat_number"],
                name="unique_seat_number_per_vehicle_type",
            )
        ]

    def __str__(self) -> str:
        return f"{self.vehicle_type_id} seat {self.seat_number}"


class SeatReservation(BaseModel):
    """The single table implementing docs/adr/0004's unified hold/booking
    lifecycle. `segment_range` is derived, internal-only — computed from
    RouteStop.sequence at creation (apps.seating.services.create_reservation)
    and never read/written by application logic beyond that write, never
    serialized in an API response. The GiST exclusion constraint enforcing
    "no two active rows for the same (seat, trip) with an overlapping
    segment_range" is applied via raw SQL in this app's initial migration,
    not expressible as a Django model constraint.

    `amount` / `fare_rule` / `fare_segment_rule` are the purchase-time
    price snapshot: the unit fare actually charged for this seat, and
    the versioned rule that produced it. Exactly one of the two rule FKs
    is set (CHECK constraint) — flat mode vs per-segment mode.
    """

    class Status(models.TextChoices):
        HELD = "held", "Held"
        CONFIRMED = "confirmed", "Confirmed"
        EXPIRED = "expired", "Expired"
        RELEASED = "released", "Released"

    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    seat = models.ForeignKey(Seat, on_delete=models.PROTECT, related_name="+")
    booking = models.ForeignKey(Booking, on_delete=models.PROTECT, related_name="+")
    from_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    to_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    segment_range = IntegerRangeField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.HELD)
    held_until = models.DateTimeField(null=True, blank=True)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    fare_rule = models.ForeignKey(
        "fares.FareRule",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )
    fare_segment_rule = models.ForeignKey(
        "fares.FareSegmentRule",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(fare_rule__isnull=False, fare_segment_rule__isnull=True)
                    | Q(fare_rule__isnull=True, fare_segment_rule__isnull=False)
                ),
                name="seat_reservation_exactly_one_fare_rule",
            )
        ]

    def __str__(self) -> str:
        return f"{self.trip_id} seat {self.seat_id} ({self.status})"
