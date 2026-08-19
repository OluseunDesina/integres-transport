"""QR ticket issuance — see docs/specs/6-ticketing.md.

`Ticket` is one row per `SeatReservation`, not per `Booking` — a
Booking can hold several seats (`apps.booking.services.create_booking`
accepts `seats: list[SeatRequest]`), and each seat needs its own
independently scannable ticket, since ADR-0005's signed QR payload
identifies a ticket by `seat_reservation_id`. `signed_payload` is
generated once at issuance (`apps.ticketing.services.issue_ticket`,
called from `apps.booking.services.mark_booking_paid`) and stored
verbatim rather than regenerated per request, so a passenger's
saved/screenshotted QR never goes stale from a different `issued_at`.
"""

from django.db import models

from apps.booking.models import Booking
from apps.core.models import BaseModel
from apps.scheduling.models import Trip
from apps.seating.models import SeatReservation


class Ticket(BaseModel):
    class Status(models.TextChoices):
        ISSUED = "issued", "Issued"
        BOARDED = "boarded", "Boarded"
        EXPIRED = "expired", "Expired"
        REVOKED = "revoked", "Revoked"

    booking = models.ForeignKey(Booking, on_delete=models.PROTECT, related_name="+")
    seat_reservation = models.OneToOneField(
        SeatReservation, on_delete=models.PROTECT, related_name="+"
    )
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    kid = models.CharField(max_length=100)
    signed_payload = models.TextField()
    issued_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.ISSUED)
    boarded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        # See apps.network.models.Route's Meta docstring for why this
        # must be restated explicitly rather than omitted.
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(expires_at__gt=models.F("issued_at")),
                name="ticket_expires_after_issued",
            )
        ]

    def __str__(self) -> str:
        return f"{self.booking_id} ticket for seat_reservation {self.seat_reservation_id}"
