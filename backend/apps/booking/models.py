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
        COMPLETED = "completed", "Completed"
        CANCELLED = "cancelled", "Cancelled"
        EXPIRED = "expired", "Expired"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    # docs/specs/18-manifest-and-staff-booking.md slice 1. Until then a
    # Booking had no identifier but its UUID, which meant a passenger had
    # nothing to quote and the manifest had nothing to print — the spec's
    # own envelope names a `booking_reference` that simply did not exist.
    #
    # Same shape as `incidents.Incident.reference`: Crockford base32
    # (no I/L/O/U, so it survives being read aloud), unique per Business
    # rather than globally, generated in the service with a collision
    # retry. Blank only on rows written before `0007` backfilled them,
    # which is nothing in practice — the constraint arrives in `0008`
    # once the backfill has run.
    reference = models.CharField(max_length=16, blank=True)
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    passenger = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING_PAYMENT)
    total_amount = models.DecimalField(max_digits=10, decimal_places=2)
    currency = models.CharField(max_length=8)
    # docs/specs/10-booking-modes.md. Reservation bookings derive this
    # from their seat count (one place per seat); open-seating bookings
    # take it from the request, since there are no seats to count.
    passenger_count = models.PositiveIntegerField(default=1)
    # Open seating only, and **required** there in practice — null for
    # reservation bookings, whose journey is per-`SeatReservation` and
    # can legitimately differ between seats on one booking.
    #
    # Not derivable for open seating: there are no seat rows to read a
    # segment from, and the fare was quoted for a specific journey at
    # booking time. Ticket issuance happens later, at payment, and has
    # to know which segment was actually sold. Not enforced by a
    # CheckConstraint for the same reason the ticket invariant isn't —
    # the mode lives on `Trip`, across an FK a check constraint cannot
    # reach.
    from_stop = models.ForeignKey(
        "network.Stop", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    to_stop = models.ForeignKey(
        "network.Stop", null=True, blank=True, on_delete=models.PROTECT, related_name="+"
    )
    cancellation_reason = models.TextField(blank=True)

    class Meta:
        # See apps.network.models.Route's Meta docstring for why this
        # must be restated explicitly rather than omitted.
        ordering = ["-created_at"]
        # docs/specs/16-operational-analytics.md slice 1 — composites
        # matched to that spec's documented filter set. `business` alone
        # is already indexed as an FK.
        indexes = [
            models.Index(fields=["business", "created_at"], name="booking_business_created"),
            models.Index(fields=["business", "status"], name="booking_business_status"),
            # The manifest and the counter both look a booking up by the
            # reference a passenger read out.
            models.Index(fields=["business", "reference"], name="booking_business_reference"),
        ]
        constraints = [
            # No `deleted_at` condition, matching `Incident`'s own
            # constraint and this codebase's rule that soft delete is a
            # manager concern, never a constraint condition. A
            # soft-deleted booking keeping its reference reserved is also
            # correct on its own terms: reissuing it would make two
            # records answer to one name on a phone call.
            models.UniqueConstraint(
                fields=["business", "reference"],
                name="unique_booking_reference_per_business",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.reference or self.id} for {self.passenger_id}"


class Traveler(BaseModel):
    """Who is actually travelling — docs/specs/22-marketplace.md slice 2.

    Additive and optional at the base level: `apps.booking`'s own
    passenger-facing booking flow (`customer-app`) sends none of this,
    so every Booking made through it simply has no `Traveler` rows.
    The marketplace booking flow is the one caller that requires it,
    enforced in `apps.marketplace.views.MarketplaceBookingCreateSerializer`
    rather than here — this model imposes no such requirement itself.

    `seat_reservation` is null for a places-mode (open-seating /
    quick-book) booking's single lead traveler, and set for a seats-mode
    booking's per-seat traveler — the same "two ways to buy" split
    `apps.booking.services.create_booking` already models, applied here
    to who is travelling rather than what was bought.

    `seat_reservation` is a **string** FK to `"seating.SeatReservation"`,
    not a direct import: `apps.seating.models` already imports `Booking`
    from this module, so an eager import in the other direction would be
    circular. Django resolves a string reference lazily, at first use,
    which is what avoids it.

    Both FKs are `CASCADE`, not this codebase's usual `PROTECT` — a
    `Traveler` has no meaning independent of the `Booking`/
    `SeatReservation` it describes, the same reasoning
    `apps.network.models.RouteStop.route` already applies to its own
    parent.
    """

    class Title(models.TextChoices):
        MR = "mr", "Mr"
        MRS = "mrs", "Mrs"
        MISS = "miss", "Miss"
        MS = "ms", "Ms"
        DR = "dr", "Dr"

    class Gender(models.TextChoices):
        MALE = "male", "Male"
        FEMALE = "female", "Female"
        OTHER = "other", "Other"
        PREFER_NOT_TO_SAY = "prefer_not_to_say", "Prefer not to say"

    booking = models.ForeignKey(Booking, on_delete=models.CASCADE, related_name="+")
    seat_reservation = models.ForeignKey(
        "seating.SeatReservation",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="+",
    )
    # Blank-allowed throughout except name/phone/email — title, DOB,
    # gender and nationality are collected but not required by the
    # model itself (docs/specs/22-marketplace.md's own "basic things"
    # framing); the marketplace frontend decides what it insists on
    # before submitting.
    title = models.CharField(max_length=10, choices=Title.choices, blank=True)
    first_name = models.CharField(max_length=150)
    last_name = models.CharField(max_length=150)
    phone = models.CharField(max_length=32)
    email = models.EmailField()
    date_of_birth = models.DateField(null=True, blank=True)
    gender = models.CharField(max_length=20, choices=Gender.choices, blank=True)
    nationality = models.CharField(max_length=100, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.first_name} {self.last_name} for booking {self.booking_id}"
