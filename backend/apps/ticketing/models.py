"""QR ticket issuance — see docs/specs/6-ticketing.md and
docs/specs/10-booking-modes.md.

`Ticket` is one row per *passenger place*, not per `Booking` — a
Booking can cover several passengers, and each needs its own
independently scannable ticket. How a place is identified depends on
the trip's booking mode:

- **reservation**: one Ticket per `SeatReservation`. `seat_reservation`
  is set, `passenger_index` is null.
- **open_seating**: one Ticket per passenger, numbered by
  `passenger_index` (0-based). `seat_reservation` is null — there is no
  seat to point at.

Exactly one of the two identifies any given row, enforced in
`apps.ticketing.services.issue_ticket` rather than by a
`CheckConstraint`: the mode lives on `Trip` and a check constraint
cannot reach across the FK.

`signed_payload` is generated once at issuance (`issue_ticket`, called
from `apps.booking.services.mark_booking_paid`) and stored verbatim
rather than regenerated per request, so a passenger's
saved/screenshotted QR never goes stale from a different `issued_at`.
ADR-0005's payload identifies a ticket by `ticket_id`, which works in
both modes — it used to be `seat_reservation_id`, which does not.
"""

from django.contrib.postgres.fields import IntegerRangeField
from django.db import models

from apps.booking.models import Booking
from apps.core.models import BaseModel
from apps.network.models import Stop
from apps.scheduling.models import Trip
from apps.seating.models import SeatReservation


class Ticket(BaseModel):
    class Status(models.TextChoices):
        ISSUED = "issued", "Issued"
        BOARDED = "boarded", "Boarded"
        EXPIRED = "expired", "Expired"
        REVOKED = "revoked", "Revoked"

    booking = models.ForeignKey(Booking, on_delete=models.PROTECT, related_name="+")
    # Nullable as of docs/specs/10-booking-modes.md — an open-seating
    # ticket has no seat. Still unique when present.
    seat_reservation = models.OneToOneField(
        SeatReservation, null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    # 0-based, open seating only. Its uniqueness per Booking is what
    # makes a 4-passenger booking yield 4 distinct scannable tickets
    # rather than one ticket scanned 4 times.
    passenger_index = models.PositiveIntegerField(null=True, blank=True)
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    # Held directly rather than read through `seat_reservation`: an
    # open-seating ticket has no reservation to read them from, and
    # capacity counting needs them on this row.
    from_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    to_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    # Derived, internal-only, mirroring seating.SeatReservation.segment_range
    # exactly — computed from RouteStop.sequence at issuance and never
    # read or written by application logic beyond the capacity count,
    # never serialized. It exists so "how many sold places overlap this
    # segment?" is one indexed `&&` rather than a per-request join
    # against RouteStop (docs/adr/0008).
    segment_range = IntegerRangeField()
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
            ),
            models.UniqueConstraint(
                fields=["booking", "passenger_index"],
                condition=models.Q(passenger_index__isnull=False),
                name="unique_passenger_index_per_booking",
            ),
        ]

    def __str__(self) -> str:
        if self.seat_reservation_id is not None:
            return f"{self.booking_id} ticket for seat_reservation {self.seat_reservation_id}"
        return f"{self.booking_id} ticket for passenger {self.passenger_index}"
