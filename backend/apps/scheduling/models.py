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
    vehicle = models.ForeignKey(
        Vehicle, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    driver = models.ForeignKey(
        Driver, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )
    booking_mode = models.CharField(max_length=20, choices=Business.BookingMode.choices)
    cancellation_reason = models.TextField(blank=True)

    class Meta:
        ordering = ["service_date", "scheduled_departure_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["schedule", "service_date"],
                condition=models.Q(schedule__isnull=False),
                name="unique_trip_per_schedule_per_service_date",
            )
        ]

    def __str__(self) -> str:
        return f"{self.route_id} {self.service_date}"
