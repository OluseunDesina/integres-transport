"""Schedule/Trip for a Business — see
docs/specs/3-network-scheduling-fleet.md §2. `Schedule` is the recurring
pattern (days of week + a time of day) a Celery Beat job expands into
concrete `Trip` rows (see `tasks.generate_trips`); a `Trip` with
`schedule=None` is a manual one-off. `business`/`booking_mode` on `Trip`
are deliberately denormalized snapshots — see `services.py` for why.
"""

from django.db import models

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.fleet.models import Driver, Vehicle
from apps.network.models import Route


class Schedule(BaseModel):
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="+")
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    days_of_week = models.JSONField(default=list)
    departure_time = models.TimeField()
    effective_from = models.DateField()
    effective_until = models.DateField(null=True, blank=True)
    # docs/specs/15-trip-classes.md. Snapshotted onto each generated
    # Trip, so editing it here only affects Trips generated after the
    # edit — the same semantics days_of_week edits already have.
    trip_class = models.CharField(
        max_length=20,
        choices=Business.TripClass.choices,
        default=Business.TripClass.STANDARD,
    )
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.route_id} @ {self.departure_time}"


class Trip(BaseModel):
    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"
        IN_PROGRESS = "in_progress", "In progress"
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"

    schedule = models.ForeignKey(
        Schedule, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    route = models.ForeignKey(Route, on_delete=models.PROTECT, related_name="+")
    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    service_date = models.DateField()
    scheduled_departure_at = models.DateTimeField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.SCHEDULED)
    status_changed_at = models.DateTimeField(null=True, blank=True)
    # docs/specs/16-operational-analytics.md slice 1. Stamped by
    # apps.scheduling.services.transition_trip_status on the
    # `-> in_progress` and `-> completed` transitions respectively.
    #
    # These exist because `status_changed_at` above cannot answer "when
    # did this Trip depart": it is a single mutable field that every
    # transition overwrites, so once a Trip completes, the moment it
    # actually left is gone. Delay is not derivable without these.
    #
    # Nullable forever, and never backfilled: a Trip cancelled before
    # departure has neither, every Trip predating this spec has
    # neither, and reinterpreting `status_changed_at` as a departure
    # time for a past Trip would be a lie. Every metric derived from
    # them reports "unknown" rather than zero when they are null.
    actual_departure_at = models.DateTimeField(null=True, blank=True)
    actual_arrival_at = models.DateTimeField(null=True, blank=True)
    vehicle = models.ForeignKey(
        Vehicle, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    driver = models.ForeignKey(
        Driver, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    booking_mode = models.CharField(max_length=20, choices=Business.BookingMode.choices)
    # Snapshotted alongside booking_mode, and for the same reason: a
    # Business that switches how it collects fares must not silently
    # change the terms of a departure passengers have already booked.
    # Where the two disagree, the Trip's snapshot wins everywhere
    # (docs/specs/10-booking-modes.md).
    fare_collection_mode = models.CharField(
        max_length=20,
        choices=Business.FareCollectionMode.choices,
        default=Business.FareCollectionMode.PREPAID,
    )
    # docs/specs/15-trip-classes.md. Snapshotted from the Schedule at
    # generation time, alongside booking_mode/fare_collection_mode above
    # and for the same reason.
    #
    # The snapshot direction is the opposite of the naive reading, and
    # deliberately so: class is NOT derived from `vehicle`. That FK is
    # nullable, and a Trip is generated — and can be booked — long
    # before a vehicle is assigned. Deriving class from the vehicle
    # would mean a departure had no class until the morning it ran. A
    # passenger buys a class; the operator then has to find a vehicle
    # that honours it.
    #
    # Immutable once anything non-cancelled is sold — enforced by
    # apps.scheduling.services.set_trip_class, not just the serializer.
    trip_class = models.CharField(
        max_length=20,
        choices=Business.TripClass.choices,
        default=Business.TripClass.STANDARD,
    )
    cancellation_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["service_date", "scheduled_departure_at"]
        # docs/specs/16-operational-analytics.md slice 1 — composites
        # matched to that spec's documented filter set. `business` alone
        # is not indexed here: Postgres already indexes every FK column,
        # so only the multi-column shapes are new.
        indexes = [
            models.Index(fields=["business", "service_date"], name="trip_business_service_date"),
            models.Index(fields=["business", "status"], name="trip_business_status"),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["schedule", "service_date"],
                condition=models.Q(schedule__isnull=False),
                name="unique_trip_per_schedule_per_service_date",
            )
        ]

    def __str__(self) -> str:
        return f"{self.route_id} {self.service_date}"
