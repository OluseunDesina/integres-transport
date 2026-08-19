"""Tap-and-go fare determination — see docs/specs/4b-tap-and-go.md.

`TapCredential` is the passenger-held bearer token (QR or NFC, resolved
identically — see the spec's "Tap identifier" section for why this
doesn't wait on ADR-0005's QR ticket signing scheme). `FareJourney` is
the open->closed lifecycle for one board/alight pair, the tap-and-go
analogue of `apps.seating.SeatReservation`'s held->confirmed lifecycle.
`TapEvent` is the immutable append-only record of each physical tap,
kept distinct from `FareJourney` (which mutates as it moves
open->closed) so a dispute or audit always has the raw tap sequence,
not just the journey's final state.

Every FK uses `related_name="+"` — matches `apps.seating`'s and
`apps.booking`'s own convention: a reverse accessor on an RLS-protected
model would traverse the same `TenantScopedManager` that silently
empties for platform staff (see `apps.booking.models.Booking`'s
docstring). Batched `.filter(...)` queries, not reverse traversal, are
used wherever a "children of X" query is needed (`apps.tapngo.views`).
"""

from django.db import models
from django.db.models import Q

from apps.businesses.models import Business
from apps.core.models import BaseModel
from apps.identity.models import User
from apps.network.models import Stop
from apps.scheduling.models import Trip


class TapCredential(BaseModel):
    """A passenger-held bearer credential. Only `token_hash` (SHA-256)
    is ever stored — the raw token is returned once, at issuance
    (`apps.tapngo.services.issue_credential`), and never again. `channel`
    is informational only; resolution logic (`apps.tapngo.services._resolve_credential`)
    never branches on it, since the backend never learns whether a token
    was decoded from a QR scan or an NFC read."""

    class Channel(models.TextChoices):
        QR = "qr", "QR code"
        NFC = "nfc", "NFC"

    passenger = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    token_hash = models.CharField(max_length=64, unique=True)
    channel = models.CharField(max_length=10, choices=Channel.choices)
    label = models.CharField(max_length=100, blank=True)
    is_active = models.BooleanField(default=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.passenger_id} ({self.channel})"


class FareJourney(BaseModel):
    """One board->alight lifecycle. `NEEDS_REVIEW` (not `CLOSED`) is the
    deliberate outcome when no fare rule covers the resolved segment at
    alight time — see the spec's edge case 5: unlike the reservation
    flow's `FareNotConfigured` 404, an alight tap can't be rejected
    outright, because the passenger already physically rode the vehicle.

    The partial unique constraint below (a plain Postgres partial unique
    index, not a GiST exclusion constraint like `SeatReservation`'s —
    this isn't a range-overlap problem) is the concurrency mechanism: at
    most one `open` row per `(business, passenger)`, enforced atomically
    by Postgres, never pre-checked by application code first (same
    "always attempt the write, let the database decide" discipline as
    docs/adr/0004).
    """

    class Status(models.TextChoices):
        OPEN = "open", "Open"
        CLOSED = "closed", "Closed"
        NEEDS_REVIEW = "needs_review", "Needs review"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    passenger = models.ForeignKey(User, on_delete=models.PROTECT, related_name="+")
    credential = models.ForeignKey(TapCredential, on_delete=models.PROTECT, related_name="+")
    board_stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    alight_stop = models.ForeignKey(
        Stop, on_delete=models.PROTECT, related_name="+", null=True, blank=True
    )
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.OPEN)
    amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    currency = models.CharField(max_length=8, blank=True)
    fare_rule = models.ForeignKey(
        "fares.FareRule", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    fare_segment_rule = models.ForeignKey(
        "fares.FareSegmentRule", on_delete=models.PROTECT, null=True, blank=True, related_name="+"
    )
    boarded_at = models.DateTimeField()
    alighted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["business", "passenger"],
                condition=Q(status="open"),
                name="one_open_fare_journey_per_business_passenger",
            ),
            models.CheckConstraint(
                condition=~(Q(fare_rule__isnull=False) & Q(fare_segment_rule__isnull=False)),
                name="fare_journey_at_most_one_fare_rule",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.trip_id} journey for {self.passenger_id} ({self.status})"


class TapEvent(BaseModel):
    """Immutable append-only record of one physical tap. Never mutated
    after creation — `FareJourney` is what carries the mutable lifecycle
    state."""

    class TapType(models.TextChoices):
        BOARD = "board", "Board"
        ALIGHT = "alight", "Alight"

    business = models.ForeignKey(Business, on_delete=models.PROTECT, related_name="+")
    trip = models.ForeignKey(Trip, on_delete=models.PROTECT, related_name="+")
    credential = models.ForeignKey(TapCredential, on_delete=models.PROTECT, related_name="+")
    journey = models.ForeignKey(FareJourney, on_delete=models.PROTECT, related_name="+")
    tap_type = models.CharField(max_length=10, choices=TapType.choices)
    stop = models.ForeignKey(Stop, on_delete=models.PROTECT, related_name="+")
    tapped_at = models.DateTimeField()

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.trip_id} {self.tap_type} @ {self.stop_id}"
