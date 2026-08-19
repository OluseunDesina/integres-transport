"""`Booking` — see docs/specs/4-fares-seating-booking.md §2.

Only the bare model lands in Phase 4 Slice 2. The creation/cancellation
service layer, serializers, views, and endpoints (`POST /bookings/`,
`POST /bookings/{id}/cancel/`, `GET /bookings/mine/`, `GET /bookings/`)
are Slice 3 — this app has no `services.py`/`views.py`/`urls.py` yet.
It lands now, not with Slice 3, only because
`apps.seating.SeatReservation.booking` is a required FK to this model
(§2: "a SeatReservation only ever exists as part of a Booking") — that
coupling is why `docs/specs/4-fares-seating-booking.md` §9 puts
`apps/seating` and this bare model in the same slice.

`currency` is snapshotted from `Business.currency` at creation so a
later Business currency edit cannot re-label a historical total — the
brief's "currency stored alongside every amount" rule applied to the
purchase record itself.
"""

from django.db import models

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.identity.models import User
from apps.scheduling.models import Trip


class Booking(BaseModel):
    class Status(models.TextChoices):
        PENDING_PAYMENT = "pending_payment", "Pending payment"
        PAID = "paid", "Paid"
        CANCELLED = "cancelled", "Cancelled"
        EXPIRED = "expired", "Expired"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    passenger = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING_PAYMENT)
    total_amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=8)
    cancellation_reason = models.TextField(blank=True)

    class Meta:
        # See apps.network.models.Route's Meta docstring for why this
        # must be restated explicitly rather than omitted.
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.trip_id} booking for {self.passenger_id}"
